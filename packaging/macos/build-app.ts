import { spawn } from "node:child_process";
import { access, chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateAppBundleManifest, validateBackendRuntimeManifest } from "./validate-manifest.js";

type Architecture = "arm64";

interface BuildOptions {
  readonly arch: Architecture;
  readonly nodeRuntime: string;
  readonly serviceDist: string;
  readonly webDist: string;
  readonly outputDirectory: string;
  readonly signingIdentity?: string;
  readonly repoRoot?: string;
}

async function run(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise(stdout.trim()) : reject(new Error(`${basename(command)} failed with exit code ${code ?? "unknown"}`)));
  });
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function infoPlist(manifest: ReturnType<typeof validateAppBundleManifest>): string {
  const document = manifest.documentTypes[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>${xml(manifest.productName)}</string>
<key>CFBundleExecutable</key><string>${xml(manifest.finderExecutable)}</string>
<key>CFBundleIdentifier</key><string>${xml(manifest.bundleIdentifier)}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>${xml(manifest.productName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${xml(manifest.bundleVersion)}</string>
<key>CFBundleVersion</key><string>${xml(manifest.bundleVersion)}</string>
<key>CFBundleIconFile</key><string>droplet</string>
<key>CFBundleSignature</key><string>dplt</string>
<key>LSMinimumSystemVersion</key><string>${xml(manifest.minimumSystemVersion)}</string>
<key>LSMultipleInstancesProhibited</key><true/>
<key>OSAAppletShowStartupScreen</key><false/>
<key>CFBundleDocumentTypes</key><array><dict>
  <key>CFBundleTypeName</key><string>PDF document</string>
  <key>CFBundleTypeRole</key><string>${document.role}</string>
  <key>LSHandlerRank</key><string>${document.rank}</string>
  <key>LSItemContentTypes</key><array><string>${document.contentType}</string></array>
</dict></array>
</dict></plist>\n`;
}

function launcherScript(): string {
  return `#!/bin/sh
set -eu
contents_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$contents_dir/Resources/node/bin/node" "$contents_dir/Resources/launcher.mjs" "$@"
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

async function signBundle(appPath: string, nodePath: string, launcherPath: string, identity: string, entitlements: string): Promise<void> {
  const common = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
  await run("codesign", [...common, "--entitlements", entitlements, nodePath]);
  await run("codesign", [...common, launcherPath]);
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
  const vscodeDist = resolve(repoRoot, appManifest.embeddedArtifacts.vscodeExtension, "dist");
  const codexPlugin = resolve(repoRoot, appManifest.embeddedArtifacts.codexPlugin);
  for (const required of [
    options.nodeRuntime,
    serviceEntry,
    options.webDist,
    resolve(vscodeDist, "extension.js"),
    resolve(codexPlugin, ".codex-plugin/plugin.json"),
    resolve(codexPlugin, "hooks/hooks.json"),
    resolve(codexPlugin, "skills/pdf-proofreader/SKILL.md"),
  ]) await access(required);
  await assertSelfContainedService(serviceEntry);
  const version = (await run(options.nodeRuntime, ["--version"])).replace(/^v/u, "");
  if (version !== appManifest.nodeVersion) throw new Error(`Expected Node ${appManifest.nodeVersion}, received ${version}`);
  if (process.arch !== options.arch) throw new Error(`Build host architecture ${process.arch} does not match ${options.arch}`);

  const appPath = resolve(options.outputDirectory, `${appManifest.productName}.app`);
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
  await mkdir(dirname(nodePath), { recursive: true, mode: 0o755 });
  await mkdir(dirname(launcherPath), { recursive: true, mode: 0o755 });
  await copyFile(options.nodeRuntime, nodePath);
  await chmod(nodePath, 0o755);
  await mkdir(resolve(resources, "service"), { recursive: true, mode: 0o755 });
  await copyFile(serviceEntry, resolve(resources, "service/main.js"));
  await cp(options.webDist, resolve(resources, "web"), { recursive: true, errorOnExist: true });
  await cp(codexPlugin, resolve(resources, "integrations/codex-plugin"), { recursive: true, errorOnExist: true });
  const vscodeInstall = resolve(resources, "integrations/vscode");
  await mkdir(vscodeInstall, { recursive: true, mode: 0o755 });
  await copyFile(resolve(repoRoot, appManifest.embeddedArtifacts.vscodeExtension, "package.json"), resolve(vscodeInstall, "package.json"));
  await cp(vscodeDist, resolve(vscodeInstall, "dist"), { recursive: true, errorOnExist: true });
  for (const asset of backendManifest.assets) {
    const destination = resolve(contents, asset.installPath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await copyFile(resolve(repoRoot, asset.source), destination);
  }
  await writeFile(resolve(contents, "Info.plist"), infoPlist(appManifest), { mode: 0o644 });
  await copyFile(resolve(repoRoot, "packaging/macos/launcher.mjs"), resolve(resources, "launcher.mjs"));
  await writeFile(launcherPath, launcherScript(), { mode: 0o755 });
  if (options.signingIdentity !== undefined) {
    await signBundle(appPath, nodePath, launcherPath, options.signingIdentity, resolve(repoRoot, appManifest.signing.entitlements));
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
    await mkdtemp(resolve(tmpdir(), `pdf-proofreader-package-${arch}-`));
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
