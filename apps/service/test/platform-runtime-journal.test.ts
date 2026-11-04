import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { ChromeRuntimeOperationJournal } from "../src/browser/runtime-operation-journal.js";
import { ensurePrivateDirectory, establishPrivateDirectory, verifyPrivatePath } from "../src/platform/private-storage.js";
import * as publication from "../src/platform/file-publication.js";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";

const roots: string[] = [];
afterAll(() => closeWindowsNativeWorker());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pk-native-runtime-journal-"));
  roots.push(root);
  await establishPrivateDirectory(root);
  const directory = join(root, "review-session");
  await ensurePrivateDirectory(directory);
  const journal = () => new ChromeRuntimeOperationJournal({ scope: () => ({ directory, prefix: "electron" }) });
  return { directory, journal };
}

it("publishes a private native operation receipt and replays it after restart without repeating the effect", async () => {
  const { directory, journal } = await fixture();
  let revision = 0;
  const action = async () => ({ revision: ++revision, accepted: true });
  const first = await journal().commit("canonical-review", "operation-native", { name: "put-draft", text: "protected input" }, action);
  expect(first).toEqual({ revision: 1, accepted: true });
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const path = join(directory, files[0]!);
  await verifyPrivatePath(path, "file");
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ status: "completed", result: first });
  await expect(journal().commit("canonical-review", "operation-native", { name: "put-draft", text: "protected input" }, action)).resolves.toEqual(first);
  expect(revision).toBe(1);
  await expect(journal().commit("canonical-review", "operation-native", { name: "put-draft", text: "changed" }, action)).rejects.toThrow("idempotency-conflict");
  expect(revision).toBe(1);
});

it("does not silently adopt an exposed recovery directory or run an effect before private precommit", async () => {
  const { directory, journal } = await fixture();
  if (process.platform === "win32") {
    await promisify(execFile)(join(process.env.SystemRoot!, "System32", "icacls.exe"), [directory, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
  } else await chmod(directory, 0o755);
  const action = vi.fn(async () => ({ accepted: true }));
  await expect(journal().commit("canonical-review", "operation-exposed", {}, action)).rejects.toThrow();
  expect(action).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it("retains unknown precommit evidence when publication durability fails and never retries the effect", async () => {
  const { directory, journal } = await fixture();
  vi.spyOn(publication, "syncPublishedFile").mockRejectedValueOnce(new Error("native publication durability unavailable"));
  const action = vi.fn(async () => ({ accepted: true }));
  await expect(journal().commit("canonical-review", "operation-uncertain", {}, action)).rejects.toThrow("durability unavailable");
  expect(action).not.toHaveBeenCalled();
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const receipt = join(directory, files[0]!);
  await verifyPrivatePath(receipt, "file");
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ status: "pending" });
  await expect(journal().commit("canonical-review", "operation-uncertain", {}, action)).rejects.toThrow("operation-outcome-unknown");
  expect(action).not.toHaveBeenCalled();
});
