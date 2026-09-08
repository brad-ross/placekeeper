import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  BUILD_IDENTITY_FILENAME,
  buildMacApp,
  computePackagedBuildIdentity,
} from "./build-app.js";

export const NATIVE_CANDIDATE_EXECUTABLE = "PlacekeeperMac";
const LEGACY_DROPLET_ENTRIES = [
  "Contents/PkgInfo",
  "Contents/Resources/Assets.car",
  "Contents/Resources/droplet.icns",
  "Contents/Resources/droplet.rsrc",
] as const;

interface SwiftBuildArgumentOptions {
  readonly packagePath: string;
  readonly sourceRoot: string;
  readonly scratchPath: string;
  readonly sdkPath: string;
  readonly showBinPath: boolean;
}

interface NativeCandidateOptions {
  readonly arch: "arm64";
  readonly nodeRuntime: string;
  readonly serviceDist: string;
  readonly sharedWebDist: string;
  readonly macWebDist: string;
  readonly outputDirectory: string;
  readonly repoRoot?: string;
  readonly sdkPath?: string;
  readonly scratchPath?: string;
}

interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolvePromise(stdout.trim())
      : reject(new Error(`${basename(command)} failed with exit code ${code ?? "unknown"}: ${stderr.trim()}`)));
  });
}

export function swiftBuildArguments(options: SwiftBuildArgumentOptions): string[] {
  return [
    "build",
    "--disable-sandbox",
    "--configuration", "release",
    "--product", NATIVE_CANDIDATE_EXECUTABLE,
    "--package-path", options.packagePath,
    "--scratch-path", options.scratchPath,
    "--sdk", options.sdkPath,
    "-Xswiftc", "-file-prefix-map",
    "-Xswiftc", `${options.sourceRoot}=.`,
    "-Xswiftc", "-debug-prefix-map",
    "-Xswiftc", `${options.sourceRoot}=.`,
    ...(options.showBinPath ? ["--show-bin-path"] : []),
  ];
}

export function minimalNativeCandidateEnvironment(scratchRoot: string): NodeJS.ProcessEnv {
  return {
    HOME: scratchRoot,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    PLACEKEEPER_APP_INSTANCE_ID: "app_candidate_smoke",
    TMPDIR: scratchRoot,
  };
}

export function nativeCandidateNodeRuntimeCandidates(
  explicitPath: string | undefined,
  configuredPath: string | undefined,
  currentRuntime: string,
  userHome: string,
): string[] {
  return [...new Set([
    explicitPath,
    configuredPath,
    currentRuntime,
    resolve(userHome, "Applications/Placekeeper.app/Contents/Resources/node/bin/node"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate !== ""))];
}

async function resolveNodeRuntime(repoRoot: string, explicitPath?: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/app-bundle.json"), "utf8")) as {
    nodeVersion?: unknown;
  };
  if (typeof manifest.nodeVersion !== "string") throw new Error("App manifest has no pinned Node version");
  for (const candidate of nativeCandidateNodeRuntimeCandidates(
    explicitPath,
    process.env.PLACEKEEPER_NODE_RUNTIME,
    process.execPath,
    homedir(),
  )) {
    try {
      const version = (await run(resolve(candidate), ["--version"])).replace(/^v/u, "");
      if (version === manifest.nodeVersion) return await realpath(candidate);
    } catch {
      // Candidate lookup is best effort; the final error names the supported override.
    }
  }
  throw new Error(
    `Native candidate packaging requires Node ${manifest.nodeVersion}; pass --node-runtime or PLACEKEEPER_NODE_RUNTIME`,
  );
}

export function nativeCandidateInfoPlist(plist: string): string {
  const executable = /<key>CFBundleExecutable<\/key><string>[^<]+<\/string>/u;
  if (!executable.test(plist)) throw new Error("Bundle plist has no CFBundleExecutable");
  return plist
    .replace(executable, `<key>CFBundleExecutable</key><string>${NATIVE_CANDIDATE_EXECUTABLE}</string>`)
    .replace(/\n?<key>CFBundleSignature<\/key><string>[^<]+<\/string>/u, "")
    .replace(/\n?<key>OSAAppletShowStartupScreen<\/key><(?:true|false)\/>/u, "");
}

async function detectCommandLineToolsSDK(explicitPath?: string): Promise<string> {
  if (explicitPath !== undefined) {
    await access(explicitPath);
    return await realpath(explicitPath);
  }
  try {
    const selected = await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
    await access(selected);
    return await realpath(selected);
  } catch {
    const sdkRoot = "/Library/Developer/CommandLineTools/SDKs";
    const candidates = (await readdir(sdkRoot))
      .filter((entry) => /^MacOSX(?:\d+(?:\.\d+)*)?\.sdk$/u.test(entry))
      .sort((left, right) => right.localeCompare(left, "en", { numeric: true }));
    const selected = candidates[0];
    if (selected === undefined) throw new Error("No installed Command Line Tools macOS SDK was found");
    return await realpath(resolve(sdkRoot, selected));
  }
}

async function buildSwiftExecutable(options: {
  readonly repoRoot: string;
  readonly sdkPath: string;
  readonly scratchPath: string;
}): Promise<string> {
  const packagePath = resolve(options.repoRoot, "apps/macos");
  const environment = {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: resolve(options.scratchPath, "clang-module-cache"),
    SDKROOT: options.sdkPath,
  };
  await run("/usr/bin/swift", swiftBuildArguments({
    packagePath,
    sourceRoot: options.repoRoot,
    scratchPath: options.scratchPath,
    sdkPath: options.sdkPath,
    showBinPath: false,
  }), { env: environment });
  const output = await run("/usr/bin/swift", swiftBuildArguments({
    packagePath,
    sourceRoot: options.repoRoot,
    scratchPath: options.scratchPath,
    sdkPath: options.sdkPath,
    showBinPath: true,
  }), { env: environment });
  const binPath = output.split("\n").at(-1);
  if (binPath === undefined || !binPath.startsWith("/")) {
    throw new Error(`Swift did not report an absolute product directory: ${output}`);
  }
  const executable = resolve(binPath, NATIVE_CANDIDATE_EXECUTABLE);
  await access(executable);
  return executable;
}

async function walk(root: string, visit: (path: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path);
  }
}

async function containsBytes(path: string, needle: Buffer): Promise<boolean> {
  if (needle.byteLength === 0) return false;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.concat([carry, chunk as Buffer]);
    if (bytes.includes(needle)) return true;
    carry = bytes.subarray(Math.max(0, bytes.byteLength - needle.byteLength + 1));
  }
  return false;
}

async function validateNoExternalLinksOrCheckoutReferences(appPath: string, repoRoot: string): Promise<void> {
  const appReal = await realpath(appPath);
  const checkoutBytes = Buffer.from(await realpath(repoRoot));
  await walk(appPath, async (path) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      const outside = relative(appReal, target).startsWith("..") || resolve(appReal, relative(appReal, target)) !== target;
      if (outside) throw new Error(`Candidate contains an external symlink: ${path}`);
      return;
    }
    if (!info.isFile()) throw new Error(`Candidate contains an unsupported entry: ${path}`);
    if (await containsBytes(path, checkoutBytes)) {
      throw new Error(`Candidate embeds its build checkout path: ${path}`);
    }
  });
}

async function validateNativeDependencies(executable: string): Promise<void> {
  const type = await run("/usr/bin/file", [executable]);
  if (!type.includes("Mach-O 64-bit executable arm64")) {
    throw new Error(`Native candidate is not an arm64 Mach-O executable: ${type}`);
  }
  const dependencies = (await run("/usr/bin/otool", ["-L", executable]))
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" ")[0])
    .filter((dependency): dependency is string => dependency !== undefined && dependency !== "");
  for (const dependency of dependencies) {
    if (nativeCandidateDependencyIsSystem(dependency)) continue;
    throw new Error(`Native candidate has a non-system runtime dependency: ${dependency}`);
  }
}

export function nativeCandidateDependencyIsSystem(dependency: string): boolean {
  return dependency.startsWith("/System/") || dependency.startsWith("/usr/lib/");
}

async function smokeBundledLifecycleHelper(appPath: string, scratchRoot: string): Promise<void> {
  const resources = resolve(appPath, "Contents/Resources");
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  await run(
    resolve(resources, "node/bin/node"),
    [resolve(resources, "service/main.js"), "macos-lifecycle-control"],
    { cwd: scratchRoot, env: minimalNativeCandidateEnvironment(scratchRoot) },
  );
}

export async function validateNativeCandidateBundle(
  appPath: string,
  repoRoot: string,
  scratchRoot: string,
): Promise<void> {
  const contents = resolve(appPath, "Contents");
  const resources = resolve(contents, "Resources");
  const executable = resolve(contents, `MacOS/${NATIVE_CANDIDATE_EXECUTABLE}`);
  const required = [
    executable,
    resolve(contents, "MacOS/placekeeper"),
    resolve(resources, "node/bin/node"),
    resolve(resources, "service/main.js"),
    resolve(resources, "MacWeb/macos.html"),
    resolve(resources, "MacWeb/recovery.html"),
    resolve(resources, "MacWeb/assets/recovery.js"),
    resolve(resources, "MacWeb/assets/recovery.css"),
    resolve(resources, "MacWeb/assets/shell.js"),
    resolve(resources, "MacWeb/assets/shell.css"),
    resolve(resources, "MacWeb/assets/pdfium.wasm"),
    resolve(resources, "MacWeb/assets/pdfium-worker.js"),
    resolve(resources, BUILD_IDENTITY_FILENAME),
  ];
  for (const path of required) await access(path);
  const plist = await readFile(resolve(contents, "Info.plist"), "utf8");
  if (!plist.includes(`<key>CFBundleExecutable</key><string>${NATIVE_CANDIDATE_EXECUTABLE}</string>`)
    || plist.includes("OSAAppletShowStartupScreen") || plist.includes("<string>droplet</string>")) {
    throw new Error("Native candidate plist still exposes the AppleScript droplet entry point");
  }
  for (const relativePath of LEGACY_DROPLET_ENTRIES) {
    if (await lstat(resolve(appPath, relativePath)).catch(() => undefined) !== undefined) {
      throw new Error(`Native candidate retains a legacy droplet resource: ${relativePath}`);
    }
  }
  if ((await stat(executable)).mode & 0o111) {
    await validateNativeDependencies(executable);
  } else {
    throw new Error("Native candidate executable is not executable");
  }
  const launcher = await readFile(resolve(contents, "MacOS/placekeeper"), "utf8");
  if (!launcher.includes('$contents_dir/Resources/node/bin/node') || launcher.includes(repoRoot)) {
    throw new Error("Public CLI launcher is not bundle-relative");
  }
  await validateNoExternalLinksOrCheckoutReferences(appPath, repoRoot);
  await smokeBundledLifecycleHelper(appPath, scratchRoot);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
}

export async function buildNativeCandidate(options: NativeCandidateOptions): Promise<string> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const sdkPath = await detectCommandLineToolsSDK(options.sdkPath);
  const ownsScratchPath = options.scratchPath === undefined;
  const scratchPath = options.scratchPath ?? await mkdtemp(resolve(tmpdir(), "placekeeper-native-swift-"));
  let stagingDirectory: string | undefined;
  try {
    await mkdir(options.outputDirectory, { recursive: true, mode: 0o755 });
    stagingDirectory = await mkdtemp(resolve(options.outputDirectory, ".placekeeper-native-stage-"));
    const swiftExecutable = await buildSwiftExecutable({ repoRoot, sdkPath, scratchPath });
    const stagedAppPath = await buildMacApp({
      arch: options.arch,
      nodeRuntime: options.nodeRuntime,
      serviceDist: options.serviceDist,
      webDist: options.sharedWebDist,
      outputDirectory: stagingDirectory,
      repoRoot,
      enforceReviewedWebSize: false,
    });
    const contents = resolve(stagedAppPath, "Contents");
    const resources = resolve(contents, "Resources");
    const nativeExecutable = resolve(contents, `MacOS/${NATIVE_CANDIDATE_EXECUTABLE}`);
    await copyFile(swiftExecutable, nativeExecutable);
    await chmod(nativeExecutable, 0o755);
    await run("/usr/bin/strip", ["-S", "-x", nativeExecutable]);
    await cp(options.macWebDist, resolve(resources, "MacWeb"), { recursive: true, errorOnExist: true });
    await rm(resolve(contents, "MacOS/droplet"), { force: true });
    await rm(resolve(resources, "Scripts"), { recursive: true, force: true });
    for (const relativePath of LEGACY_DROPLET_ENTRIES) {
      await rm(resolve(stagedAppPath, relativePath), { force: true });
    }
    const plistPath = resolve(contents, "Info.plist");
    await writeFile(plistPath, nativeCandidateInfoPlist(await readFile(plistPath, "utf8")), { mode: 0o644 });
    const buildIdentity = await computePackagedBuildIdentity({
      contentsRoot: contents,
      serviceRoot: resolve(resources, "service"),
      webRoot: resolve(resources, "web"),
    });
    await writeFile(resolve(resources, BUILD_IDENTITY_FILENAME), `${JSON.stringify(buildIdentity)}\n`, { mode: 0o644 });
    await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedAppPath]);
    await validateNativeCandidateBundle(stagedAppPath, repoRoot, resolve(scratchPath, "independence-smoke"));
    const appPath = resolve(options.outputDirectory, basename(stagedAppPath));
    if (await lstat(appPath).catch(() => undefined) !== undefined) {
      throw new Error(`Refusing to overwrite existing bundle: ${appPath}`);
    }
    await rename(stagedAppPath, appPath);
    return appPath;
  } finally {
    if (stagingDirectory !== undefined) await rm(stagingDirectory, { recursive: true, force: true });
    if (ownsScratchPath) await rm(scratchPath, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The local native candidate currently supports Apple-silicon macOS only");
  }
  const outputDirectory = argument("--output")
    ?? await mkdtemp(resolve(tmpdir(), "placekeeper-native-candidate-"));
  const repoRoot = process.cwd();
  const appPath = await buildNativeCandidate({
    arch: "arm64",
    nodeRuntime: await resolveNodeRuntime(repoRoot, argument("--node-runtime")),
    serviceDist: resolve(argument("--service-dist") ?? "dist/service"),
    sharedWebDist: resolve(argument("--web-dist") ?? "dist/web"),
    macWebDist: resolve(argument("--mac-web-dist") ?? "dist/macos-web"),
    outputDirectory: resolve(outputDirectory),
    repoRoot,
    ...(argument("--sdk") === undefined ? {} : { sdkPath: resolve(argument("--sdk")!) }),
    ...(argument("--scratch") === undefined ? {} : { scratchPath: resolve(argument("--scratch")!) }),
  });
  process.stdout.write(`${appPath}\n`);
}
