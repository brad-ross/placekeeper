import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { establishPrivateDirectory, writePrivateFile } from "../src/platform/private-storage.js";

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
