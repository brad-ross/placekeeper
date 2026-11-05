import { chmod, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { closeWindowsNativeWorker } from "../src/platform/windows-native-worker.js";
import { establishPrivateDirectory, readPrivateFile, readPrivateFileRange, writePrivateFile } from "../src/platform/private-storage.js";

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


it("reads only the requested private range, including short reads and the final partial range", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-range-"));
  try {
    await establishPrivateDirectory(root);
    const path = join(root, "large.pdf"), source = Buffer.alloc(1024 * 1024, 0xa5);
    source.set(Buffer.from("last"), source.length - 4);
    await writePrivateFile(path, source);
    const handle = await open(path, "r"), read = handle.read;
    const reads: { length: number; position: number }[] = [];
    vi.spyOn(handle, "read").mockImplementation(async (...args) => {
      const [buffer, offset, length, position] = args as unknown as [Buffer, number, number, number];
      reads.push({ length, position });
      return Reflect.apply(read, handle, [buffer, offset, Math.min(length, 2), position]);
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    const allocations = vi.spyOn(Buffer, "alloc");
    expect(await readPrivateFileRange(path, source.length, source.length - 4, 192 * 1024)).toEqual({ bytes: Buffer.from("last"), fileSize: source.length });
    expect(reads).toEqual([{ length: 4, position: source.length - 4 }, { length: 2, position: source.length - 2 }]);
    expect(allocations.mock.calls.map(([size]) => size)).toEqual([4]);
    expect(await readPrivateFileRange(path, source.length, 10, 8)).toEqual({ bytes: source.subarray(10, 18), fileSize: source.length });
    await expect(readPrivateFileRange(path, source.length - 1, 0, 1)).rejects.toThrow("oversized");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["growth", "truncation", "mutation", "replacement"] as const)("rejects private range %s during a descriptor read", async (change) => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-range-race-"));
  try {
    await establishPrivateDirectory(root);
    const path = join(root, "saved.pdf");
    await writePrivateFile(path, "original bytes");
    const handle = await open(path, "r"), read = handle.read;
    vi.spyOn(handle, "read").mockImplementationOnce(async (...args) => {
      const result = await Reflect.apply(read, handle, args);
      if (change === "replacement") {
        await rename(path, join(root, "previous.pdf"));
        await writePrivateFile(path, "original bytes");
      } else {
        await writeFile(path, change === "growth" ? "original bytes with growth" : change === "truncation" ? "" : "modified bytes");
      }
      return result;
    });
    vi.mocked(open).mockResolvedValueOnce(handle);
    await expect(readPrivateFileRange(path, 1024, 2, 4)).rejects.toThrow(/changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("rejects symlinks and unsafe file or directory permissions for private ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-private-range-permissions-"));
  try {
    await establishPrivateDirectory(root);
    const path = join(root, "saved.pdf"), link = join(root, "link.pdf");
    await writePrivateFile(path, "private bytes");
    await symlink(path, link);
    await expect(readPrivateFileRange(link, 1024, 0, 4)).rejects.toThrow("file type");
    await chmod(path, 0o644);
    await expect(readPrivateFileRange(path, 1024, 0, 4)).rejects.toThrow("permissions");
    await chmod(path, 0o600);
    await chmod(root, 0o755);
    await expect(readPrivateFileRange(path, 1024, 0, 4)).rejects.toThrow("permissions");
  } finally { await rm(root, { recursive: true, force: true }); }
});
