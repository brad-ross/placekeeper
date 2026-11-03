import { RECOVERY_CAPABILITIES } from "../../apps/service/src/recovery/recovery-capabilities.js";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buildNativeLaunchers } from "./native-launcher.js";
import { archiveExtraction, bundleDependencyNotices, inventory, portableIntegrationSetup, portableVscodePackager } from "./package-assets.js";
import type { PackagedRuntimeManifest } from "../../apps/service/src/platform/runtime-layout.js";
import { hashFile as digest } from "../../apps/service/src/files/file-capabilities.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
interface RuntimePins {
  nodeVersion: string;
  targets: Record<string, { archive: string; sha256: string }>;
}
function run(command: string, args: string[], cwd = repo): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
  });
}

export async function prepareDesktopRuntime(target: string): Promise<string> {
  const pins = JSON.parse(await readFile(join(repo, "packaging/desktop/runtime-manifest.json"), "utf8")) as RuntimePins;
  const pin = pins.targets[target];
  if (pin === undefined) throw new Error(`Unsupported desktop target: ${target}`);
  if (!target.startsWith(`${process.platform}-`)) throw new Error("Prepare desktop payloads on their native OS host");
  const icons = join(repo, "dist/desktop-icons");
  await mkdir(icons, { recursive: true });
  const iconset = join(repo, "packaging/macos/icon/Placekeeper.iconset");
  const png = await readFile(join(iconset, "icon_256x256.png"));
  await writeFile(join(icons, "Placekeeper.png"), png);
  // ICO supports PNG-compressed images; retain the reviewed source pixels.
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await writeFile(join(icons, "Placekeeper.ico"), Buffer.concat([ico, png]));
  if (process.platform === "darwin") await run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(icons, "Placekeeper.icns")]);
  const [platform, arch] = target.split("-") as [NodeJS.Platform, string];
  const cache = join(repo, "dist/desktop-node", target);
  await mkdir(cache, { recursive: true });
  const archive = join(cache, pin.archive);
  if (await digest(archive).catch(() => "") !== pin.sha256) {
    const response = await fetch(`https://nodejs.org/dist/v${pins.nodeVersion}/${pin.archive}`);
    if (!response.ok || response.body === null) throw new Error(`Node download failed: ${response.status}`);
    const temporary = `${archive}.download`;
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>), createWriteStream(temporary));
      if (await digest(temporary) !== pin.sha256) throw new Error("Node archive digest mismatch");
      await copyFile(temporary, archive);
    } finally { await rm(temporary, { force: true }); }
  }
  const unpacked = join(cache, "unpacked");
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked);
  const extraction = archiveExtraction(process.platform, archive, unpacked);
  await run(extraction.command, extraction.args);
  const extracted = join(unpacked, pin.archive.replace(/\.(?:tar\.gz|zip)$/u, ""));
  const root = join(repo, "dist/desktop-runtime", target, "desktop");
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "node/bin"), { recursive: true });
  await mkdir(join(root, "service"));
  const nodePath = platform === "win32" ? "node/bin/node.exe" : "node/bin/node";
  await copyFile(join(extracted, platform === "win32" ? "node.exe" : "bin/node"), join(root, nodePath));
  await chmod(join(root, nodePath), 0o755);
  await copyFile(join(extracted, "LICENSE"), join(root, "node/LICENSE"));
  await copyFile(join(repo, "dist/service/main.js"), join(root, "service/main.js"));
  await writeFile(join(root, "service/package.json"), '{"type":"module"}\n');
  await cp(join(repo, "dist/web"), join(root, "web"), { recursive: true });
  await cp(join(repo, "dist/electron-web"), join(root, "electron-web"), { recursive: true });
  await copyFile(join(repo, "packaging/desktop/launcher.mjs"), join(root, "launcher.mjs"));
  await buildNativeLaunchers(root, target, run);
  await copyFile(join(repo, "packaging/desktop/vscode-launcher.mjs"), join(root, "vscode-launcher.mjs"));
  await cp(join(repo, "dist/codex-mcp"), join(root, "codex-mcp"), { recursive: true });
  await cp(join(repo, "apps/chrome-extension/dist"), join(root, "integrations/chrome-extension"), { recursive: true });
  await writeFile(join(root, "codex-mcp/package.json"), '{"type":"module"}\n');
  await cp(join(repo, "integrations/codex-plugin"), join(root, "integrations/codex-plugin-template"), { recursive: true });
  await cp(join(repo, "integrations/editors"), join(root, "integrations/editors"), { recursive: true });
  await copyFile(join(repo, "docs/guides/editor-synctex.md"), join(root, "integrations/editors/guide.md"));
  const installer = join(root, "installer");
  await mkdir(installer, { recursive: true });
  for (const helper of ["setup-integrations.mjs", "setup-chrome.mjs", "update-vscode.mjs", "setup-zed.mjs"]) {
    await copyFile(join(repo, "packaging/macos", helper), join(installer, helper));
  }
  await cp(await realpath(join(repo, "node_modules/jsonc-parser")), join(installer, "node_modules/jsonc-parser"), { recursive: true });
  await copyFile(join(repo, "packaging/desktop/setup-codex.mjs"), join(installer, "setup-codex.mjs"));
  const integrationHelper = join(installer, "setup-integrations.mjs");
  await writeFile(integrationHelper, portableIntegrationSetup(await readFile(integrationHelper, "utf8")));
  const extension = join(root, "integrations/vscode");
  await mkdir(extension, { recursive: true });
  await copyFile(join(repo, "apps/vscode/package.json"), join(extension, "package.json"));
  await cp(join(repo, "apps/vscode/dist"), join(extension, "dist"), { recursive: true });
  await cp(join(repo, "apps/vscode/assets"), join(extension, "assets"), { recursive: true });
  const vscodeHelper = join(installer, "update-vscode.mjs");
  await copyFile(join(repo, "packaging/desktop/portable-zip.mjs"), join(installer, "portable-zip.mjs"));
  await writeFile(vscodeHelper, portableVscodePackager(await readFile(vscodeHelper, "utf8")));
  await run(join(root, nodePath), [vscodeHelper, "--package", root, join(root, "integrations/placekeeper.vsix")]);
  await bundleDependencyNotices(repo, join(root, "licenses"));
  const webFiles = await inventory(join(root, "web"));
  const nodeHash = await digest(join(root, nodePath));
  const serviceHash = await digest(join(root, "service/main.js"));
  const daemonIdentity = createHash("sha256").update(JSON.stringify({ node: nodeHash, service: serviceHash, webFiles })).digest("hex");
  const shellFiles = await inventory(join(repo, "apps/electron/dist"));
  const uiFiles = await inventory(join(root, "electron-web"));
  const resourceFiles = await inventory(root);
  const installedElectron = JSON.parse(await readFile(join(repo, "apps/electron/node_modules/electron/package.json"), "utf8")) as { version: string };
  const electronVersion = (JSON.parse(await readFile(join(repo, "packaging/desktop/runtime-manifest.json"), "utf8")) as { electronVersion: string }).electronVersion;
  if (installedElectron.version !== electronVersion) throw new Error("Installed Electron does not match the pinned runtime");
  const source = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repo, encoding: "utf8" }).trim().length > 0,
    lockfileSha256: await digest(join(repo, "pnpm-lock.yaml")),
  };
  const installArtifactIdentity = createHash("sha256").update(JSON.stringify({ target, daemonIdentity, shellFiles, uiFiles, resourceFiles, electronVersion })).digest("hex");
  const version = (JSON.parse(await readFile(join(repo, "apps/electron/package.json"), "utf8")) as { version: string }).version;
  const manifest: PackagedRuntimeManifest = {
    schemaVersion: 1, target: { platform, arch }, daemonIdentity, installArtifactIdentity,
    node: { path: nodePath, sha256: nodeHash, version: pins.nodeVersion },
    service: { path: "service/main.js", sha256: serviceHash, version },
    codexMcp: { path: "codex-mcp/server.js", sha256: await digest(join(root, "codex-mcp/server.js")) },
    webAssets: { path: "web", files: webFiles },
    recovery: RECOVERY_CAPABILITIES,
  };
  await writeFile(join(root, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(root, "build-evidence.json"), `${JSON.stringify({
    schemaVersion: 1, target, source, electronVersion, daemonNodeVersion: pins.nodeVersion,
    nodeArchive: pin, daemonIdentity, installArtifactIdentity, resourceFiles, shellFiles,
    runtimeManifestSha256: await digest(join(root, "runtime-manifest.json")),
  }, null, 2)}\n`);
  return root;
}

async function main(): Promise<void> {
  const targetFlag = process.argv.indexOf("--target");
  const target = targetFlag < 0 ? `${process.platform}-${process.arch}` : process.argv[targetFlag + 1];
  if (target === undefined) throw new Error("--target requires a platform-architecture value");
  if (!target.startsWith(`${process.platform}-`)) throw new Error("Build desktop installers on their native OS host");
  for (const config of ["apps/service/vite.config.ts", "apps/web/vite.production.config.ts", "apps/chrome-extension/vite.config.ts", "apps/web/vite.electron.config.ts", "apps/electron/vite.config.ts", "apps/codex-mcp/vite.config.ts"]) {
    await run(process.execPath, [join(repo, "node_modules/vite/bin/vite.js"), "build", "--config", config]);
  }
  await run(process.execPath, [join(repo, "node_modules/vite/bin/vite.js"), "build", "--config", "apps/codex-mcp/vite.config.ts", "--mode", "server"]);
  await run(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "-p", join(repo, "apps/vscode/tsconfig.json"), "--noEmit"]);
  await run(process.execPath, ["--input-type=module", "-e", 'import { build } from "esbuild"; await build({ entryPoints: ["src/extension.ts"], bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"], outfile: "dist/extension.cjs" });'], join(repo, "apps/vscode"));
  await run(process.execPath, [join(repo, "apps/vscode/copy-web-assets.mjs")], join(repo, "apps/vscode"));
  await run(process.execPath, ["--experimental-strip-types", join(repo, "apps/chrome-extension/scripts/validate-manifest.ts")]);
  process.stdout.write(`${await prepareDesktopRuntime(target)}\n`);
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
