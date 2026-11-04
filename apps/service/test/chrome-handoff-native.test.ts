import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, it } from "vitest";
import { CHROME_EXTENSION_ORIGIN, ChromeHandoffSession, ChromeTransferStore, type SealedBrowserSourceHandle } from "../src/browser/chrome-handoff.js";
import { validatePdfFile } from "../src/browser/chrome-pdf-validator.js";
import { ensurePrivateDirectory, establishPrivateDirectory, verifyPrivatePath, writePrivateFile } from "../src/platform/private-storage.js";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";

const roots: string[] = [];
afterAll(() => closeWindowsNativeWorker());
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(validate = validatePdfFile) {
  const root = await mkdtemp(join(tmpdir(), "pk-native-chrome-handoff-"));
  roots.push(root);
  await establishPrivateDirectory(root);
  const store = await ChromeTransferStore.create({ root: join(root, "sources"), validate, maxConcurrentTransfers: 1 });
  return { root, store };
}
const bytes = () => readFile(resolve("test/fixtures/pdfs/multi-page-text.pdf"));

it("streams a real Chrome handoff into a private, validated sealed PDF on the native filesystem", async () => {
  const { store } = await fixture();
  const pdf = await bytes();
  let sealed: SealedBrowserSourceHandle | undefined;
  const destination = "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";
  const session = new ChromeHandoffSession({ callerOrigin: CHROME_EXTENSION_ORIGIN, store, opener: {
    openLocal: async () => { throw new Error("unexpected local acquisition"); },
    openSealed: async (handle) => { sealed = handle; return destination; },
  } });
  await expect(session.handle({ type: "start", protocolVersion: 1, transferId: "native-handoff", disposition: "remote-temporary", displayName: "Native paper.pdf" }))
    .resolves.toMatchObject({ type: "ack", phase: "start" });
  await verifyPrivatePath(store.root, "directory");
  const partials = await readdir(store.root);
  expect(partials).toHaveLength(1);
  expect(partials[0]).toMatch(/^\.[A-Za-z0-9_-]{32}\.partial$/u);
  await verifyPrivatePath(join(store.root, partials[0]!), "file");
  for (let offset = 0, sequence = 0; offset < pdf.length; offset += 16_384, sequence++) {
    await expect(session.handle({ type: "chunk", transferId: "native-handoff", sequence, data: pdf.subarray(offset, offset + 16_384).toString("base64") }))
      .resolves.toMatchObject({ type: "ack", phase: "chunk", sequence });
  }
  const reply = await session.handle({ type: "finish", transferId: "native-handoff", sequence: Math.ceil(pdf.length / 16_384) });
  expect(reply).toEqual({ type: "success", transferId: "native-handoff", destination });
  expect(sealed).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  const inspection = await store.inspect(sealed!);
  expect(inspection).toMatchObject({ disposition: "remote-temporary", byteLength: pdf.length,
    sha256: createHash("sha256").update(pdf).digest("hex"), displayName: "Native paper.pdf" });
  expect(basename(inspection.path)).toBe(`${sealed}.pdf`);
  expect(await readdir(store.root)).toEqual([`${sealed}.pdf`]);
  await verifyPrivatePath(inspection.path, "file");
  expect(await readFile(inspection.path)).toEqual(pdf);
  await validatePdfFile(inspection.path);
  expect(JSON.stringify(reply)).not.toContain(store.root);
  await store.remove(sealed!);
  expect(await readdir(store.root)).toEqual([]);
});

it("rejects privacy changes during structural validation before publishing a sealed handle", async () => {
  const { store } = await fixture(async (path) => {
    await validatePdfFile(path);
    if (process.platform === "win32") {
      await promisify(execFile)(join(process.env.SystemRoot!, "System32", "icacls.exe"), [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
    } else await chmod(path, 0o644);
  });
  const staged = await store.begin("Private paper.pdf");
  await store.append(staged, await bytes());
  await expect(store.seal(staged)).rejects.toThrow();
  expect(await readdir(store.root)).toEqual([]);
});

it("keeps concurrent native admission exclusive and releases quota after cancellation", async () => {
  const { store } = await fixture();
  const other = await ChromeTransferStore.create({ root: store.root, validate: validatePdfFile, maxConcurrentTransfers: 1 });
  const first = await store.begin();
  await expect(other.begin()).rejects.toThrow("host-busy");
  await store.cancel(first);
  const second = await other.begin();
  await verifyPrivatePath(second.path, "file");
  await other.cancel(second);
  expect(await readdir(store.root)).toEqual([]);
});


it("creates the cold Chrome-first app support parent privately without changing its existing ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-cold-chrome-parent-"));
  roots.push(root);
  await establishPrivateDirectory(root);
  const before = await lstat(root);
  const appSupport = join(root, "Placekeeper");
  const store = await ChromeTransferStore.create({ root: join(appSupport, "browser-sources"), validate: validatePdfFile });
  await verifyPrivatePath(appSupport, "directory");
  await verifyPrivatePath(store.root, "directory");
  // A subsequent daemon must be able to use the same private support root.
  await ensurePrivateDirectory(appSupport);
  await ensurePrivateDirectory(join(appSupport, "recovery"));
  await verifyPrivatePath(join(appSupport, "recovery"), "directory");
  const after = await lstat(root);
  expect({ device: after.dev, inode: after.ino, owner: after.uid, mode: after.mode })
    .toEqual({ device: before.dev, inode: before.ino, owner: before.uid, mode: before.mode });
});

it("rejects a replaced partial identity after validation without deleting the replacement", async () => {
  const pdf = await bytes();
  const { root, store } = await fixture(async (path) => {
    await validatePdfFile(path);
    await rename(path, join(root, "original-partial.pdf"));
    await writePrivateFile(path, pdf);
  });
  const staged = await store.begin();
  await store.append(staged, pdf);
  await expect(store.seal(staged)).rejects.toThrow("identity changed");
  expect(await readFile(staged.path)).toEqual(pdf);
  expect(await readFile(join(root, "original-partial.pdf"))).toEqual(pdf);
  expect(await readdir(store.root)).toEqual([basename(staged.path)]);
  await store.cancel(staged);
  expect(await readFile(staged.path)).toEqual(pdf);
});


it.runIf(process.platform === "win32")("does not create unrelated missing Windows profile ancestors for a Chrome root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-chrome-missing-ancestor-"));
  roots.push(root);
  await establishPrivateDirectory(root);
  const missing = join(root, "unrelated-profile");
  await expect(ChromeTransferStore.create({ root: join(missing, "Placekeeper", "browser-sources"), validate: validatePdfFile })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});
