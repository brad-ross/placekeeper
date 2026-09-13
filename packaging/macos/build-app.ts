import { spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MAC_ICON_REPRESENTATIONS,
  CATALOG_NOTICE_RESOURCE_PATH,
  validateCatalogRuntimeDistribution,
  validateAppBundleManifest,
  validateBackendRuntimeManifest,
  validateMacIconSet,
  validateSharedWebDistribution,
} from "./validate-manifest.js";
import { MANAGEMENT_PROTOCOL_VERSION } from "../../apps/service/src/host/launch-control.js";
import {
  CHROME_EXTENSION_BUNDLE_PATH,
  CHROME_NATIVE_WRAPPER_BUNDLE_PATH,
  validateChromeIntegrationBundle,
} from "./chrome-integration.js";

export const BUILD_IDENTITY_FILENAME = "build-identity.json";

export interface PackagedBuildIdentity {
  readonly managementProtocolVersion: typeof MANAGEMENT_PROTOCOL_VERSION;
  readonly daemonIdentity: string;
  readonly installArtifactIdentity: string;
}

interface PackagedBuildIdentityOptions {
  readonly contentsRoot: string;
  readonly serviceRoot: string;
  readonly webRoot: string;
}

type Architecture = "arm64";

interface BuildOptions {
  readonly arch: Architecture;
  readonly nodeRuntime: string;
  readonly serviceDist: string;
  readonly webDist: string;
  readonly outputDirectory: string;
  readonly signingIdentity?: string;
  readonly repoRoot?: string;
  readonly enforceReviewedWebSize?: boolean;
}

async function run(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = Buffer.alloc(0);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: Buffer) => {
      const combined = Buffer.concat([stderr, chunk]);
      stderr = combined.subarray(Math.max(0, combined.byteLength - 64 * 1024));
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolvePromise(stdout.trim())
      : reject(new Error(`${basename(command)} failed with exit code ${code ?? "unknown"}: ${stderr.toString("utf8").trim()}`)));
  });
}

async function packMacIconSet(iconsetPath: string, outputPath: string): Promise<void> {
  const chunks = await Promise.all(MAC_ICON_REPRESENTATIONS.map(async ([filename, , chunkType]) => {
    const png = await readFile(resolve(iconsetPath, filename));
    const chunk = Buffer.alloc(8 + png.byteLength);
    chunk.write(chunkType, 0, 4, "ascii");
    chunk.writeUInt32BE(chunk.byteLength, 4);
    png.copy(chunk, 8);
    return chunk;
  }));
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.byteLength, 0), 4);
  await writeFile(outputPath, Buffer.concat([header, ...chunks]), { mode: 0o644 });
}

/** Compile with Apple's iconutil. macOS 26.5 may reject even an iconset that
 * iconutil itself reverse-expanded; its deterministic chunk-container fallback
 * preserves the same ten standard representations and remains readable by
 * iconutil in the reverse direction. */
export async function compileMacIcon(iconsetPath: string, outputPath: string): Promise<void> {
  await validateMacIconSet(iconsetPath);
  try {
    await run("/usr/bin/iconutil", ["-c", "icns", iconsetPath, "-o", outputPath]);
  } catch (error) {
    if (process.platform !== "darwin" || !(error instanceof Error) || !error.message.includes("Invalid Iconset")) {
      throw error;
    }
    await packMacIconSet(iconsetPath, outputPath);
  }
}

function hashField(hash: Hash, field: string | Buffer): void {
  const bytes = Buffer.isBuffer(field) ? field : Buffer.from(field);
  hash.update(String(bytes.byteLength));
  hash.update(":");
  hash.update(bytes);
  hash.update("\n");
}

async function hashTree(
  hash: Hash,
  root: string,
  label: string,
  excluded: (relativePath: string) => boolean = () => false,
): Promise<void> {
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (excluded(relativePath)) continue;
      const absolutePath = resolve(directory, entry.name);
      const info = await lstat(absolutePath);
      hashField(hash, `${label}/${relativePath}`);
      hashField(hash, String(info.mode & 0o777));
      if (entry.isDirectory()) {
        hashField(hash, "directory");
        await visit(absolutePath, relativePath);
      } else if (entry.isSymbolicLink()) {
        hashField(hash, "symlink");
        hashField(hash, await readlink(absolutePath));
      } else if (entry.isFile()) {
        hashField(hash, "file");
        hashField(hash, await readFile(absolutePath));
      } else {
        throw new Error(`Unsupported packaged entry: ${relativePath}`);
      }
    }
  };
  await visit(root, "");
}

/** Hashes logical replacement inputs, excluding derived code signatures and
 * the identity record itself so identical package inputs remain stable. */
export async function computePackagedBuildIdentity(
  options: PackagedBuildIdentityOptions,
): Promise<PackagedBuildIdentity> {
  const daemonHash = createHash("sha256");
  hashField(daemonHash, `management:${MANAGEMENT_PROTOCOL_VERSION}`);
  await hashTree(daemonHash, options.serviceRoot, "service");
  await hashTree(daemonHash, options.webRoot, "web");

  const artifactHash = createHash("sha256");
  await hashTree(artifactHash, options.contentsRoot, "Contents", (relativePath) =>
    relativePath === `Resources/${BUILD_IDENTITY_FILENAME}` ||
    relativePath === "_CodeSignature" || relativePath.startsWith("_CodeSignature/") ||
    relativePath.endsWith("/CodeResources"));
  return {
    managementProtocolVersion: MANAGEMENT_PROTOCOL_VERSION,
    daemonIdentity: daemonHash.digest("hex"),
    installArtifactIdentity: artifactHash.digest("hex"),
  };
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function infoPlist(manifest: ReturnType<typeof validateAppBundleManifest>): string {
  const document = manifest.documentTypes[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>${xml(manifest.bundleName)}</string>
<key>CFBundleExecutable</key><string>${xml(manifest.finderExecutable)}</string>
<key>CFBundleIdentifier</key><string>${xml(manifest.bundleIdentifier)}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>${xml(manifest.bundleName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(manifest.bundleVersion)}</string>
<key>CFBundleVersion</key><string>${xml(manifest.bundleVersion)}</string>
<key>CFBundleIconFile</key><string>${xml(manifest.icon.file)}</string>
<key>CFBundleSignature</key><string>dplt</string>
<key>LSMinimumSystemVersion</key><string>${xml(manifest.minimumSystemVersion)}</string>
<key>LSHasLocalizedDisplayName</key><true/>
<key>LSMultipleInstancesProhibited</key><true/>
<key>OSAAppletShowStartupScreen</key><false/>
<key>CFBundleURLTypes</key><array><dict>
  <key>CFBundleURLName</key><string>local.placekeeper.review-link</string>
  <key>CFBundleTypeRole</key><string>Viewer</string>
  <key>CFBundleURLSchemes</key><array><string>placekeeper</string></array>
</dict></array>
<key>CFBundleDocumentTypes</key><array><dict>
  <key>CFBundleTypeName</key><string>PDF document</string>
  <key>CFBundleTypeRole</key><string>${document.role}</string>
  <key>LSHandlerRank</key><string>${document.rank}</string>
  <key>LSItemContentTypes</key><array><string>${document.contentType}</string></array>
</dict></array>
</dict></plist>\n`;
}

function stringsLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

export function infoPlistStrings(manifest: ReturnType<typeof validateAppBundleManifest>): string {
  const productName = stringsLiteral(manifest.productName);
  return `"CFBundleDisplayName" = "${productName}";\n"CFBundleName" = "${productName}";\n`;
}

export function appBundlePath(
  outputDirectory: string,
  manifest: ReturnType<typeof validateAppBundleManifest>,
): string {
  return resolve(outputDirectory, `${manifest.bundleName}.app`);
}

function launcherScript(): string {
  return `#!/bin/sh
set -eu
contents_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$contents_dir/Resources/node/bin/node" "$contents_dir/Resources/launcher.mjs" "$@"
`;
}

function vscodeLauncherScript(): string {
  return `#!/bin/sh
set -eu
contents_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$contents_dir/Resources/node/bin/node" "$contents_dir/Resources/vscode-launcher.mjs" "$@"
`;
}

export async function assertSelfContainedService(entryPath: string): Promise<void> {
  // Bundled dependencies retain JSDoc type imports; they are comments, not
  // runtime module edges, and must not be mistaken for external imports.
  const source = (await readFile(entryPath, "utf8")).replace(/\/\*\*[\s\S]*?\*\//gu, "");
  // Rolldown external dependencies are emitted as static ESM imports. Looking
  // for require()/import() text would misclassify AJV code-generation strings
  // and the deliberately embedded browser bootstrap as service dependencies.
  const patterns = [
    /^\s*import\s+(?:[^"'()]*?\s+from\s+)?(["'])([^"']+)\1/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[2]!;
      if (!isBuiltin(specifier)) {
        throw new Error(`Service bundle is not self-contained; external import: ${specifier}`);
      }
    }
  }
}

async function signBundle(appPath: string, nodePath: string, launcherPath: string, vscodeLauncherPath: string, identity: string, entitlements: string): Promise<void> {
  const common = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
  await run("codesign", [...common, "--entitlements", entitlements, nodePath]);
  await run("codesign", [...common, launcherPath]);
  await run("codesign", [...common, vscodeLauncherPath]);
  await run("codesign", [...common, "--entitlements", entitlements, appPath]);
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

async function signAdHocBundle(appPath: string): Promise<void> {
  await run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  await run("codesign", ["--verify", "--deep", "--strict", appPath]);
}

export async function buildMacApp(options: BuildOptions): Promise<string> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const appManifest = validateAppBundleManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/app-bundle.json"), "utf8")) as unknown);
  const backendManifest = validateBackendRuntimeManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown);
  if (!appManifest.architectures.includes(options.arch)) throw new Error(`Unsupported architecture: ${options.arch}`);
  if (appManifest.nodeVersion !== backendManifest.nodeVersion) throw new Error("Runtime manifest Node versions differ");
  const serviceEntry = resolve(options.serviceDist, "main.js");
  const vscodeExtension = resolve(repoRoot, appManifest.embeddedArtifacts.vscodeExtension);
  const vscodeDist = resolve(vscodeExtension, "dist");
  const codexPlugin = resolve(repoRoot, appManifest.embeddedArtifacts.codexPlugin);
  const chromeExtension = resolve(repoRoot, appManifest.embeddedArtifacts.chromeExtension);
  const chromeNativeWrapper = resolve(repoRoot, appManifest.embeddedArtifacts.chromeNativeWrapper);
  const iconMaster = resolve(repoRoot, appManifest.icon.master);
  const iconset = resolve(repoRoot, appManifest.icon.source);
  for (const required of [
    options.nodeRuntime,
    serviceEntry,
    options.webDist,
    resolve(vscodeDist, "extension.cjs"),
    resolve(vscodeExtension, "assets/placekeeper.png"),
    resolve(vscodeExtension, "assets/placekeeper.svg"),
    resolve(codexPlugin, ".codex-plugin/plugin.json"),
    resolve(codexPlugin, "assets/placekeeper.svg"),
    resolve(codexPlugin, "hooks/hooks.json"),
    resolve(codexPlugin, "skills/placekeeper/SKILL.md"),
    resolve(codexPlugin, "skills/placekeeper/references/live-evidence.md"),
    resolve(codexPlugin, "skills/placekeeper/references/source-work.md"),
    resolve(codexPlugin, "skills/placekeeper/assets/placekeeper.svg"),
    resolve(codexPlugin, "skills/placekeeper/agents/openai.yaml"),
    resolve(chromeExtension, "manifest.json"),
    resolve(chromeExtension, "handler.html"),
    resolve(chromeExtension, "popup.html"),
    resolve(chromeExtension, "background.js"),
    chromeNativeWrapper,
    iconMaster,
  ]) await access(required);
  await validateMacIconSet(iconset);
  await assertSelfContainedService(serviceEntry);
  const version = (await run(options.nodeRuntime, ["--version"])).replace(/^v/u, "");
  if (version !== appManifest.nodeVersion) throw new Error(`Expected Node ${appManifest.nodeVersion}, received ${version}`);
  if (process.arch !== options.arch) throw new Error(`Build host architecture ${process.arch} does not match ${options.arch}`);

  const appPath = appBundlePath(options.outputDirectory, appManifest);
  try {
    await lstat(appPath);
    throw new Error(`Refusing to overwrite existing bundle: ${appPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await run("/usr/bin/osacompile", ["-o", appPath, resolve(repoRoot, "packaging/macos/finder-bridge.applescript")]);
  const contents = resolve(appPath, "Contents");
  const resources = resolve(contents, "Resources");
  const nodePath = resolve(resources, "node/bin/node");
  const launcherPath = resolve(contents, `MacOS/${appManifest.executable}`);
  const vscodeLauncherPath = resolve(contents, "MacOS/placekeeper-vscode");
  await mkdir(dirname(nodePath), { recursive: true, mode: 0o755 });
  await mkdir(dirname(launcherPath), { recursive: true, mode: 0o755 });
  await copyFile(options.nodeRuntime, nodePath);
  await chmod(nodePath, 0o755);
  await mkdir(resolve(resources, "service"), { recursive: true, mode: 0o755 });
  await copyFile(serviceEntry, resolve(resources, "service/main.js"));
  await cp(options.webDist, resolve(resources, "web"), { recursive: true, errorOnExist: true });
  await cp(codexPlugin, resolve(resources, "integrations/codex-plugin"), { recursive: true, errorOnExist: true });
  // Keep every optional setup dependency in the durable installed bundle.
  const installer = resolve(resources, "installer");
  await mkdir(installer, { recursive: true, mode: 0o755 });
  for (const helper of ["setup-integrations.mjs", "setup-chrome.mjs", "update-vscode.mjs"]) {
    await copyFile(resolve(repoRoot, "packaging/macos", helper), resolve(installer, helper));
  }
  await mkdir(resolve(resources, "integrations/.agents/plugins"), { recursive: true, mode: 0o755 });
  await copyFile(resolve(repoRoot, "packaging/macos/codex-marketplace.json"), resolve(resources, "integrations/.agents/plugins/marketplace.json"));
  const vscodeInstall = resolve(resources, "integrations/vscode");
  await mkdir(vscodeInstall, { recursive: true, mode: 0o755 });
  await copyFile(resolve(vscodeExtension, "package.json"), resolve(vscodeInstall, "package.json"));
  await cp(vscodeDist, resolve(vscodeInstall, "dist"), { recursive: true, errorOnExist: true });
  await cp(resolve(vscodeExtension, "assets"), resolve(vscodeInstall, "assets"), { recursive: true, errorOnExist: true });
  await run(nodePath, [resolve(installer, "update-vscode.mjs"), "--package", appPath, resolve(resources, "integrations/placekeeper.vsix")]);
  const sharedWebManifest = await validateSharedWebDistribution(options.webDist);
  const vscodeWebManifest = await validateSharedWebDistribution(resolve(vscodeDist, "web"));
  if (JSON.stringify(vscodeWebManifest) !== JSON.stringify(sharedWebManifest)) {
    throw new Error("The VS Code extension web assets differ from the shared production payload");
  }
  const chromeWebManifest = await validateSharedWebDistribution(resolve(chromeExtension, "shared"));
  if (JSON.stringify(chromeWebManifest) !== JSON.stringify(sharedWebManifest)) {
    throw new Error("The Chrome extension web assets differ from the shared production payload");
  }
  await cp(chromeExtension, resolve(appPath, CHROME_EXTENSION_BUNDLE_PATH), {
    recursive: true,
    errorOnExist: true,
  });
  const chromeWrapperInstall = resolve(appPath, CHROME_NATIVE_WRAPPER_BUNDLE_PATH);
  await copyFile(chromeNativeWrapper, chromeWrapperInstall);
  await chmod(chromeWrapperInstall, 0o755);
  for (const asset of backendManifest.assets) {
    const destination = resolve(contents, asset.installPath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(resolve(repoRoot, asset.source), destination);
  }
  await writeFile(resolve(contents, "Info.plist"), infoPlist(appManifest), { mode: 0o644 });
  const englishResources = resolve(resources, "en.lproj");
  await mkdir(englishResources, { recursive: true, mode: 0o755 });
  await writeFile(resolve(englishResources, "InfoPlist.strings"), infoPlistStrings(appManifest), { mode: 0o644 });
  await compileMacIcon(iconset, resolve(resources, `${appManifest.icon.file}.icns`));
  await copyFile(
    resolve(repoRoot, "THIRD_PARTY_NOTICES.md"),
    resolve(contents, CATALOG_NOTICE_RESOURCE_PATH),
  );
  await copyFile(resolve(repoRoot, "packaging/macos/launcher.mjs"), resolve(resources, "launcher.mjs"));
  await copyFile(resolve(repoRoot, "packaging/macos/vscode-launcher.mjs"), resolve(resources, "vscode-launcher.mjs"));
  await writeFile(launcherPath, launcherScript(), { mode: 0o755 });
  await writeFile(vscodeLauncherPath, vscodeLauncherScript(), { mode: 0o755 });
  await validateChromeIntegrationBundle(appPath);
  await validateCatalogRuntimeDistribution({
    runtimeRoot: resources,
    webEntry: resolve(resources, "web/app.js"),
    noticePath: resolve(contents, CATALOG_NOTICE_RESOURCE_PATH),
    ...(options.enforceReviewedWebSize === undefined
      ? {}
      : { enforceReviewedWebSize: options.enforceReviewedWebSize }),
  });
  const buildIdentity = await computePackagedBuildIdentity({
    contentsRoot: contents,
    serviceRoot: resolve(resources, "service"),
    webRoot: resolve(resources, "web"),
  });
  await writeFile(
    resolve(resources, BUILD_IDENTITY_FILENAME),
    `${JSON.stringify(buildIdentity)}\n`,
    { mode: 0o644 },
  );
  if (options.signingIdentity !== undefined) {
    await signBundle(appPath, nodePath, launcherPath, vscodeLauncherPath, options.signingIdentity, resolve(repoRoot, appManifest.signing.entitlements));
  } else {
    await signAdHocBundle(appPath);
  }
  return appPath;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arch = argument("--arch") ?? process.arch;
  if (arch !== "arm64") {
    throw new Error("The source-first macOS package supports Apple silicon only");
  }
  const nodeRuntime = argument("--node-runtime") ?? process.execPath;
  const serviceDist = argument("--service-dist") ?? resolve("dist/service");
  const webDist = argument("--web-dist") ?? resolve("dist/web");
  const outputDirectory = argument("--output") ??
    await mkdtemp(resolve(tmpdir(), `placekeeper-package-${arch}-`));
  const appPath = await buildMacApp({
    arch,
    nodeRuntime,
    serviceDist,
    webDist,
    outputDirectory,
    ...(argument("--sign-identity") === undefined ? {} : { signingIdentity: argument("--sign-identity")! }),
  });
  process.stdout.write(`${appPath}\n`);
}
