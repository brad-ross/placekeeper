import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { archiveExtraction, bundleDependencyNotices, inventory } from "./package-assets.js";
import forgeConfig from "../../apps/electron/forge.config.js";
import { MakerDeb } from "@electron-forge/maker-deb";

const temporary: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-package-"));
  temporary.push(root);
  return root;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("desktop package assets", () => {
  it.skipIf(process.platform === "win32")("links the Debian launcher to the packaged executable when the npm name is scoped", async () => {
    const root = await fixture();
    const maker = forgeConfig.makers.find((candidate): candidate is MakerDeb => candidate instanceof MakerDeb);
    expect(maker).toBeDefined();
    await maker!.prepareConfig("x64");
    const require = createRequire(import.meta.url);
    const requireMaker = createRequire(require.resolve("@electron-forge/maker-deb"));
    const requireInstaller = createRequire(requireMaker.resolve("electron-installer-debian"));
    const { ElectronInstaller, getDefaultsFromPackageJSON, sanitizeName } = requireInstaller("electron-installer-common");
    const pkg = JSON.parse(await readFile(new URL("../../apps/electron/package.json", import.meta.url), "utf8"));
    const installer = new ElectronInstaller({});
    installer.options = { ...getDefaultsFromPackageJSON(pkg), ...maker!.config.options, src: root };
    installer.options.name = sanitizeName(installer.options.name.toLowerCase(), "-+.a-z0-9");
    installer.stagingDir = join(root, "staging");
    await writeFile(join(root, forgeConfig.packagerConfig.executableName), "packaged executable");

    await installer.createBinarySymlink();

    expect(await readlink(join(installer.stagingDir, "usr", "bin", installer.options.name)))
      .toBe(`../lib/${installer.options.name}/${forgeConfig.packagerConfig.executableName}`);
    installer.options.desktopTemplate = join(dirname(requireMaker.resolve("electron-installer-debian")), "../resources/desktop.ejs");
    await installer.createDesktopFile();
    const desktop = await readFile(join(installer.stagingDir, "usr/share/applications", `${installer.appIdentifier}.desktop`), "utf8");
    expect(desktop).toContain(`Exec=${installer.options.name} %U`);
    expect(desktop).toContain("MimeType=application/pdf;x-scheme-handler/placekeeper;x-scheme-handler/placekeeper-navigation;");
  });

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

describe("production desktop identity", () => {
  it("uses the same production name, bundle id and executable on all platforms", async () => {
    expect(forgeConfig.packagerConfig).toMatchObject({ name: "Placekeeper", executableName: "PlacekeeperDesktop", appBundleId: "local.placekeeper" });
    const pkg = JSON.parse(await readFile(new URL("../../apps/electron/package.json", import.meta.url), "utf8"));
    expect(pkg).toMatchObject({ productName: "Placekeeper", version: "0.3.0" });
  });

  it("advertises PDF and Placekeeper URL opening without claiming the default PDF handler", () => {
    expect(forgeConfig.packagerConfig.extendInfo).toEqual({
      CFBundleURLTypes: [{ CFBundleURLName: "local.placekeeper.review-link", CFBundleTypeRole: "Viewer",
        CFBundleURLSchemes: ["placekeeper", "placekeeper-navigation"] }],
      CFBundleDocumentTypes: [{ CFBundleTypeName: "PDF document", CFBundleTypeRole: "Viewer",
        LSHandlerRank: "Alternate", LSItemContentTypes: ["com.adobe.pdf"] }],
    });
  });

  it("preserves published Mac CLI paths as forwarders to this runtime", async () => {
    const { installMacCompatibility } = await import("./macos-compatibility.js");
    const root = await fixture();
    const resources = join(root, "Placekeeper.app/Contents/Resources");
    await mkdir(resources, { recursive: true });
    await installMacCompatibility(resources);
    const cli = await readFile(join(resources, "../MacOS/placekeeper"), "utf8");
    expect(cli).toContain('../Resources/desktop');
    expect(cli).toContain('exec "$resources/bin/placekeeper" "$@"');
    expect(await readFile(join(resources, "../MacOS/placekeeper-chrome-host"), "utf8")).toContain('bin/placekeeper-chrome-native-host');
    expect(await readlink(join(resources, "node"))).toBe(join("desktop", "node"));
    expect(await readlink(join(resources, "integrations"))).toBe(join("desktop", "integrations"));
    if (process.platform !== 'win32') {
      await mkdir(join(resources, 'desktop/bin'), { recursive: true });
      for (const [alias, target] of [['placekeeper', 'placekeeper'], ['placekeeper-vscode', 'placekeeper-vscode'], ['placekeeper-chrome-host', 'placekeeper-chrome-native-host']]) {
        const executable = join(resources, 'desktop/bin', target!);
        await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${target}' "$@"\n`);
        await chmod(executable, 0o755);
        const { stdout } = await promisify(execFile)(join(resources, '../MacOS', alias!), ['a PDF & notes.pdf']);
        expect(stdout.trim().split('\n')).toEqual([target, 'a PDF & notes.pdf']);
      }
    }
  });
});
