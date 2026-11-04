import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";
import { establishPrivateDirectory, readPrivateFile, writePrivateFile } from "../src/platform/private-storage.js";

it("writes streamed recovery backups without changing chunk bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-streamed-private-"));
  try {
    await establishPrivateDirectory(root);
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from("before\n");
      yield new Uint8Array(128 * 1024).fill(0xa5);
      yield Buffer.from("\nafter: résumé");
    }
    const target = join(root, "backup.pdf");
    await writePrivateFile(target, chunks());
    expect(await readFile(target)).toEqual(Buffer.concat([
      Buffer.from("before\n"), Buffer.alloc(128 * 1024, 0xa5), Buffer.from("\nafter: résumé"),
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open) };
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => closeWindowsNativeWorker());

it("bounds private receipt allocations by the actual file instead of its eight MiB budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-small-private-read-"));
  try {
    await establishPrivateDirectory(root);
    const path = join(root, "receipt.json");
    await writePrivateFile(path, "{\"status\":\"pending\"}");
    const allocations = vi.spyOn(Buffer, "alloc");
    expect((await readPrivateFile(path, 8 * 1024 * 1024)).toString()).toBe("{\"status\":\"pending\"}");
    expect(allocations.mock.calls.some(([size]) => size >= 8 * 1024 * 1024)).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["growth", "truncation"] as const)("rejects private file %s during an actual descriptor read", async (change) => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-read-race-"));
  try {
    await establishPrivateDirectory(root);
    const path = join(root, "receipt.json");
    await writePrivateFile(path, "original");
    const handle = await open(path, "r");
    const read = handle.read;
    vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      const result = await Reflect.apply(read, handle, args);
      await writeFile(path, change === "growth" ? "original with later bytes" : "");
      return result;
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    await expect(readPrivateFile(path, 1024)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reads complete private bytes when the filesystem returns short descriptor reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-short-read-"));
  try {
    await establishPrivateDirectory(root);
    const path = join(root, "receipt.json");
    await writePrivateFile(path, "complete receipt");
    const handle = await open(path, "r");
    const read = handle.read;
    vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      const [buffer, offset, length, position] = args as unknown as [Buffer, number, number, number];
      return Reflect.apply(read, handle, [buffer, offset, Math.min(length, 2), position]);
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    expect((await readPrivateFile(path, 1024)).toString()).toBe("complete receipt");
  } finally { await rm(root, { recursive: true, force: true }); }
});
