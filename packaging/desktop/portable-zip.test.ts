import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeZip } from "./portable-zip.mjs";
const python = process.platform === "win32" ? "python" : "python3";
it.skipIf(spawnSync(python, ["--version"]).status !== 0)("produces a deterministic Unicode VSIX readable by an independent ZIP implementation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-zip-"));
  try {
    await mkdir(join(root, "extension"));
    await writeFile(join(root, "extension/café.json"), '{"valid":true}');
    const entries = ["extension/", "extension/café.json"];
    const first = join(root, "first.vsix"), second = join(root, "second.vsix");
    await writeZip(first, root, entries); await writeZip(second, root, entries);
    expect(await readFile(first)).toEqual(await readFile(second));
    const output = execFileSync(python, ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read('extension/café.json').decode())", first], { encoding: "utf8" });
    expect(output.trim()).toBe('{"valid":true}');
  } finally { await rm(root, { recursive: true, force: true }); }
});
