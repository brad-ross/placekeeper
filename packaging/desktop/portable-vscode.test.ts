import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { portableVscodePackager } from "./package-assets.js";
it("packages the bundled VS Code integration using Node only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-vsix-"));
  try {
    const installer = join(root, "installer"), extension = join(root, "integrations/vscode");
    await mkdir(installer); await mkdir(extension, { recursive: true });
    await writeFile(join(extension, "package.json"), JSON.stringify({ publisher: "placekeeper-local", name: "placekeeper-vscode", version: "0.1.1", engines: { vscode: ">=1.95.0" } }));
    const source = await readFile(new URL("../macos/update-vscode.mjs", import.meta.url), "utf8");
    const helper = join(installer, "update-vscode.mjs"), archive = join(root, "placekeeper.vsix");
    await copyFile(new URL("./portable-zip.mjs", import.meta.url), join(installer, "portable-zip.mjs"));
    await writeFile(helper, portableVscodePackager(source));
    expect(JSON.parse(execFileSync(process.execPath, [helper, "--package", root, archive], { encoding: "utf8" }))).toMatchObject({ path: archive, version: "0.1.1" });
    expect((await readFile(archive)).readUInt32LE(0)).toBe(0x04034b50);
  } finally { await rm(root, { recursive: true, force: true }); }
});
