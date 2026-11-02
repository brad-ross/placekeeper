import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { archiveExtraction, bundleDependencyNotices, inventory } from "./package-assets.js";

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-package-"));
  temporary.push(root);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("desktop package assets", () => {
  it("uses native ZIP extraction on Windows and gzip tar extraction on Unix without shell interpolation", () => {
    expect(archiveExtraction("win32", "C:\\PDFs & café\\node.zip", "C:\\output dir")).toEqual({
      command: "tar.exe", args: ["-xf", "C:\\PDFs & café\\node.zip", "-C", "C:\\output dir"],
    });
    expect(archiveExtraction("darwin", "/tmp/node.tar.gz", "/tmp/out").args).toEqual(["-xzf", "/tmp/node.tar.gz", "-C", "/tmp/out"]);
    expect(() => archiveExtraction("linux", "/tmp/node.zip", "/tmp/out")).toThrow("native Windows");
  });

  it("inventories nested resource bytes deterministically and rejects symlinks", async () => {
    const root = await fixture();
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "z.txt"), "first");
    await writeFile(join(root, "assets", "pdfium.wasm"), "wasm");
    const first = await inventory(root);
    expect(first.map(file => file.path)).toEqual(["assets/pdfium.wasm", "z.txt"]);
    await writeFile(join(root, "z.txt"), "changed");
    expect((await inventory(root))[1]?.sha256).not.toBe(first[1]?.sha256);
    if (process.platform !== "win32") {
      await symlink(join(root, "z.txt"), join(root, "linked"), "file");
      await expect(inventory(root)).rejects.toThrow("Unexpected packaged resource");
    }
  });

  it("copies complete transitive production licenses and fails for a missing notice", async () => {
    const root = await fixture();
    const dependency = join(root, "node_modules", "one");
    const transitive = join(root, "node_modules", "two");
    await mkdir(dependency, { recursive: true });
    await mkdir(transitive, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { one: "1" } }));
    await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "Reviewed catalog attribution");
    await writeFile(join(dependency, "package.json"), JSON.stringify({ name: "one", version: "1.0.0", license: "MIT", dependencies: { two: "2" } }));
    await writeFile(join(dependency, "LICENSE"), "one license");
    await writeFile(join(transitive, "package.json"), JSON.stringify({ name: "two", version: "2.0.0", license: "MIT" }));
    await writeFile(join(transitive, "LICENSE.md"), "two license");
    const output = join(root, "output");
    await bundleDependencyNotices(root, output);
    expect(await readFile(join(output, "two@2.0.0", "LICENSE.md"), "utf8")).toBe("two license");
    expect(JSON.parse(await readFile(join(output, "dependencies.json"), "utf8"))).toHaveLength(2);
    await rm(join(transitive, "LICENSE.md"));
    await expect(bundleDependencyNotices(root, join(root, "bad"))).rejects.toThrow("No dependency license/notice");
  });
});
