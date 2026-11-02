import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createPrivateFile, ensurePrivateDirectory, verifyPrivatePath, writePrivateFile } from "../src/platform/private-storage.js";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";
const roots: string[] = [];
afterEach(async () => {
  await closeWindowsNativeWorker();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it.runIf(process.platform === "win32")("creates private Windows files and inheritable directories without altering existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-create-")); roots.push(root);
  const directory = join(root, "private"); await ensurePrivateDirectory(directory);
  await verifyPrivatePath(directory, "directory");
  const file = join(directory, "secret"); await createPrivateFile(file);
  await verifyPrivatePath(file, "file"); await writeFile(file, "original");
  await expect(createPrivateFile(file)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(file, "utf8")).toBe("original");
  const inherited = join(directory, "inherited"); await writeFile(inherited, "inherited private bytes");
  await verifyPrivatePath(inherited, "file");
  const streamed = join(directory, "streamed");
  await writePrivateFile(streamed, (async function* () { yield Buffer.from("one"); yield Buffer.from("two"); })());
  expect(await readFile(streamed, "utf8")).toBe("onetwo"); await verifyPrivatePath(streamed, "file");
});
it.runIf(process.platform === "win32")("refuses an existing exposed directory without repairing its ACL", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-existing-")); roots.push(root);
  const execute = promisify(execFile);
  await execute(join(process.env.SystemRoot!, "System32", "icacls.exe"), [root, "/grant", "*S-1-1-0:(OI)(CI)R"], { windowsHide: true });
  async function descriptor(): Promise<string> {
    const script = "[Console]::Out.Write((Get-Acl -LiteralPath $env:PLACEKEEPER_TEST_PATH).Sddl)";
    return (await execute(join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: { ...process.env, PLACEKEEPER_TEST_PATH: root }, windowsHide: true })).stdout;
  }
  const before = await descriptor();
  await expect(ensurePrivateDirectory(root)).rejects.toThrow();
  expect(await descriptor()).toBe(before);
});
