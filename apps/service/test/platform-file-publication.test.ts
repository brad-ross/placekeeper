import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { closeWindowsNativeWorker, requestWindowsNative } from "../src/platform/windows-native-worker.js";
import { windowsPowerShellScript } from "../src/platform/windows-powershell.js";
import { FileCapabilityRegistry, validatePdfFilename } from "../src/files/file-capabilities.js";
import { preserveReplacementPermissions, publishFile, stagePublication, syncPublishedFile } from "../src/platform/file-publication.js";

const directories: string[] = [];
afterAll(() => closeWindowsNativeWorker());
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-publication-"));
  directories.push(directory);
  const target = join(directory, "paper.pdf");
  await writeFile(target, "original", { mode: 0o640 });
  return { directory, target };
}

it("stages beside the destination, preserves permissions and publishes complete bytes", async () => {
  const { directory, target } = await fixture();
  const candidate = await stagePublication(target, Buffer.from("reviewed"));
  expect(dirname(candidate)).toBe(directory);
  expect(await readFile(target, "utf8")).toBe("original");
  await preserveReplacementPermissions(candidate, target);
  const publication = await publishFile(candidate, target);
  await syncPublishedFile(publication);
  expect(publication.confirmed).toBe(true);
  expect(await readFile(target, "utf8")).toBe("reviewed");
  if (process.platform !== "win32") expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect(await readdir(directory)).toEqual(["paper.pdf"]);
});

it("rejects cross-directory staging before touching the original", async () => {
  const { directory, target } = await fixture();
  const candidate = join(directory, "nested", "candidate");
  await expect(publishFile(candidate, target)).rejects.toThrow("destination directory");
  expect(await readFile(target, "utf8")).toBe("original");
});

it("does not overwrite a collision when publication requested a new file", async () => {
  const { target } = await fixture();
  const candidate = await stagePublication(target, Buffer.from("reviewed"));
  await expect(publishFile(candidate, target, { replaceExisting: false })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(target, "utf8")).toBe("original");
  expect(await readFile(candidate, "utf8")).toBe("reviewed");
});

it("does not turn an inconclusive publication into durable success", async () => {
  const { target } = await fixture();
  await expect(syncPublishedFile({ target, confirmed: false, windowsWriteThrough: false })).rejects.toThrow("could not be confirmed");
});

it("recognizes an existing target through a directory alias", async () => {
  const { directory, target } = await fixture();
  const alias = `${directory}-alias`;
  directories.push(alias);
  await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
  const capabilities = new FileCapabilityRegistry();
  const approved = await capabilities.approvePdf(target);
  const destination = await capabilities.preauthorizeDestination(join(alias, "paper.pdf"));
  expect(destination.existingTarget?.path).toBe(approved.canonicalPath);
  // Even filesystems that report weak inode identities must prove the bytes.
  await writeFile(target, "external");
  await expect(capabilities.validateDestination(destination.id)).rejects.toMatchObject({ code: "TARGET_CHANGED" });
});

it("rejects a changed parent during destination refresh", async () => {
  const { directory } = await fixture();
  const capabilities = new FileCapabilityRegistry();
  const path = join(directory, "missing.pdf");
  const destination = await capabilities.preauthorizeDestination(path);
  await rm(directory, { recursive: true });
  // Recreated paths do not inherit authority from the removed directory.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory);
  await writeFile(path, "reviewed");
  await expect(capabilities.refreshDestination(destination.id, "unused")).rejects.toMatchObject({ code: "TARGET_CHANGED" });
});

it.skipIf(process.platform !== "win32")("protects Windows staged bytes even in a broadly readable destination directory", async () => {
  const { directory, target } = await fixture();
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:PLACEKEEPER_TEST_DIRECTORY
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:PLACEKEEPER_TEST_DIRECTORY -AclObject $acl
`;
  await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsPowerShellScript(script), "utf16le").toString("base64")],
    { env: { ...process.env, PLACEKEEPER_TEST_DIRECTORY: directory }, windowsHide: true });
  const candidate = await stagePublication(target, Buffer.from("sensitive accepted edits"));
  expect(await requestWindowsNative({ operation: "verify", path: candidate })).toEqual({ status: "ok" });
  expect(await readFile(candidate, "utf8")).toBe("sensitive accepted edits");
});

it("recognizes case aliases on a filesystem that actually supports them", async context => {
  const { directory, target } = await fixture();
  const alias = join(directory, "PAPER.PDF");
  const resolved = await realpath(alias).catch(() => undefined);
  if (resolved === undefined) { context.skip(); return; }
  const capabilities = new FileCapabilityRegistry();
  const approved = await capabilities.approvePdf(target);
  const destination = await capabilities.preauthorizeDestination(alias);
  expect(destination.existingTarget?.path).toBe(approved.canonicalPath);
});

it.skipIf(process.platform !== "win32")("rejects Windows stream syntax and device aliases as save names", () => {
  for (const name of ["paper:review.pdf", "NUL.pdf", "COM¹.pdf", "LPT2.pdf", 'bad?.pdf']) {
    expect(() => validatePdfFilename(name)).toThrow("one PDF filename");
  }
});
