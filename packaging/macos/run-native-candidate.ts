import { spawn, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MANAGEMENT_PROTOCOL_VERSION } from "../../apps/service/src/host/launch-control.js";
import { BUILD_IDENTITY_FILENAME, type PackagedBuildIdentity } from "./build-app.js";

const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_LIMIT_BYTES = 256 * 1024;

export interface NativeCandidatePaths {
  readonly appPath: string;
  readonly executable: string;
  readonly nodeRuntime: string;
  readonly serviceEntry: string;
  readonly webRoot: string;
  readonly macWebRoot: string;
  readonly pdfiumWasm: string;
  readonly identityPath: string;
}

export interface NativeCandidateRunnerEnvironment {
  readonly daemon: NodeJS.ProcessEnv;
  readonly application: NodeJS.ProcessEnv;
}

interface RunnerArguments {
  readonly appPath?: string;
  readonly pdfPath: string;
  readonly smoke: boolean;
  readonly timeoutMs: number;
}

function argument(args: readonly string[], name: string): string | undefined {
  const indexes = args.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be provided only once`);
  if (indexes.length === 0) return undefined;
  const value = args[indexes[0]! + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

export function parseNativeCandidateRunnerArguments(
  args: readonly string[],
  repoRoot: string,
): RunnerArguments {
  if (args.filter((value) => value === "--").length > 1 || args.indexOf("--") > 0) {
    throw new Error("-- may appear only once before native candidate options");
  }
  args = args[0] === "--" ? args.slice(1) : args;
  const supported = new Set(["--app", "--pdf", "--smoke", "--timeout-ms"]);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!supported.has(value)) throw new Error(`Unsupported native candidate option: ${value}`);
    if (value !== "--smoke") index += 1;
  }
  const timeoutText = argument(args, "--timeout-ms");
  const timeoutMs = timeoutText === undefined ? DEFAULT_SMOKE_TIMEOUT_MS : Number(timeoutText);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new Error("--timeout-ms must be an integer from 1000 through 120000");
  }
  return {
    ...(argument(args, "--app") === undefined ? {} : { appPath: resolve(argument(args, "--app")!) }),
    pdfPath: resolve(argument(args, "--pdf") ?? resolve(repoRoot, "test/fixtures/pdfs/multi-page-text.pdf")),
    smoke: args.includes("--smoke"),
    timeoutMs,
  };
}

export function nativeCandidatePaths(appPath: string): NativeCandidatePaths {
  const absoluteAppPath = resolve(appPath);
  const resources = resolve(absoluteAppPath, "Contents/Resources");
  return {
    appPath: absoluteAppPath,
    executable: resolve(absoluteAppPath, "Contents/MacOS/PlacekeeperMac"),
    nodeRuntime: resolve(resources, "node/bin/node"),
    serviceEntry: resolve(resources, "service/main.js"),
    webRoot: resolve(resources, "web"),
    macWebRoot: resolve(resources, "MacWeb"),
    pdfiumWasm: resolve(resources, "pdfium/pdfium.wasm"),
    identityPath: resolve(resources, BUILD_IDENTITY_FILENAME),
  };
}

export function parsePackagedBuildIdentity(value: unknown): PackagedBuildIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Native candidate build identity must be an object");
  }
  const identity = value as Partial<PackagedBuildIdentity>;
  if (
    Object.keys(value).sort().join(",") !== "daemonIdentity,installArtifactIdentity,managementProtocolVersion" ||
    identity.managementProtocolVersion !== MANAGEMENT_PROTOCOL_VERSION ||
    !/^[a-f0-9]{64}$/u.test(identity.daemonIdentity ?? "") ||
    !/^[a-f0-9]{64}$/u.test(identity.installArtifactIdentity ?? "")
  ) {
    throw new Error("Native candidate build identity is invalid");
  }
  return identity as PackagedBuildIdentity;
}

export function nativeCandidateRunnerEnvironment(
  paths: NativeCandidatePaths,
  identity: PackagedBuildIdentity,
  privateHome: string,
  httpPort: number,
  diagnostics: boolean,
): NativeCandidateRunnerEnvironment {
  const shared = {
    HOME: privateHome,
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    TMPDIR: privateHome,
    PLACEKEEPER_DAEMON_IDENTITY: identity.daemonIdentity,
    PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: identity.installArtifactIdentity,
    PLACEKEEPER_PDFIUM_WASM: paths.pdfiumWasm,
  };
  return {
    daemon: {
      ...shared,
      PLACEKEEPER_WEB_ASSETS: paths.webRoot,
    },
    application: {
      ...shared,
      PLACEKEEPER_MAC_DEVELOPMENT_ROOT: resolve(privateHome, "Library/Application Support/Placekeeper"),
      PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT: String(httpPort),
      ...(diagnostics ? { PLACEKEEPER_MAC_DIAGNOSTICS: "1" } : {}),
    },
  };
}

export function nativeCandidateDaemonArguments(paths: NativeCandidatePaths, httpPort: number): string[] {
  return [
    paths.serviceEntry,
    "daemon",
    "--isolated-installed-smoke",
    "--http-port",
    String(httpPort),
  ];
}

export async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("Native candidate runner could not allocate a loopback port");
  }
  await new Promise<void>((resolveClose, reject) => server.close((error) => {
    if (error === undefined) resolveClose();
    else reject(error);
  }));
  return address.port;
}

async function waitForSocket(
  socketPath: string,
  daemon: ChildProcess,
  spawnError: () => Error | undefined,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const failure = spawnError();
    if (failure !== undefined) throw failure;
    if ((await lstat(socketPath).catch(() => undefined))?.isSocket() === true) return;
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`Native candidate daemon exited ${daemon.exitCode ?? daemon.signalCode}`);
    }
    if (Date.now() >= deadline) throw new Error("Native candidate daemon did not create its private control socket");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, PROCESS_STOP_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  if (!await waitForExit(child, PROCESS_STOP_TIMEOUT_MS)) {
    throw new Error(`Process ${child.pid ?? "unknown"} did not stop`);
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-DIAGNOSTIC_LIMIT_BYTES);
}

async function buildCandidate(repoRoot: string, outputRoot: string): Promise<string> {
  const packageManager = process.env.npm_execpath;
  const command = packageManager === undefined ? "pnpm" : process.execPath;
  const prefix = packageManager === undefined ? [] : [packageManager];
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, [
      ...prefix,
      "package:macos:native-candidate",
      "--",
      "--output",
      outputRoot,
    ], { cwd: repoRoot, stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolveRun()
      : reject(new Error(`Native candidate build failed with exit code ${code ?? "unknown"}`)));
  });
  return resolve(outputRoot, "Placekeeper.app");
}

async function readAndValidateCandidate(paths: NativeCandidatePaths, pdfPath: string): Promise<PackagedBuildIdentity> {
  await Promise.all([
    access(paths.executable),
    access(paths.nodeRuntime),
    access(paths.serviceEntry),
    access(paths.webRoot),
    access(paths.macWebRoot),
    access(paths.pdfiumWasm),
    access(pdfPath),
  ]);
  const raw = JSON.parse(await readFile(paths.identityPath, "utf8")) as unknown;
  return parsePackagedBuildIdentity(raw);
}

export async function runNativeCandidate(args: readonly string[]): Promise<void> {
  if (process.platform !== "darwin") throw new Error("The native candidate runner requires macOS");
  const repoRoot = process.cwd();
  const options = parseNativeCandidateRunnerArguments(args, repoRoot);
  // Unix-domain socket paths are short on macOS. Keep the private HOME under
  // the short /tmp spelling so its Application Support control socket fits.
  const runnerRoot = await mkdtemp("/tmp/placekeeper-native-run-");
  const privateHome = resolve(runnerRoot, "home");
  const launchCwd = resolve(runnerRoot, "launch-cwd");
  let daemon: ChildProcess | undefined;
  let application: ChildProcess | undefined;
  let interruptedSignal: NodeJS.Signals | undefined;
  const signalHandler = (signal: NodeJS.Signals) => { interruptedSignal = signal; void stopProcess(application); };
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await Promise.all([
      mkdir(privateHome, { recursive: true, mode: 0o700 }),
      mkdir(launchCwd, { recursive: true, mode: 0o700 }),
    ]);
    const appPath = options.appPath ?? await buildCandidate(repoRoot, resolve(runnerRoot, "candidate"));
    const paths = nativeCandidatePaths(appPath);
    const identity = await readAndValidateCandidate(paths, options.pdfPath);
    const port = await availableLoopbackPort();
    const environment = nativeCandidateRunnerEnvironment(
      paths,
      identity,
      privateHome,
      port,
      options.smoke,
    );
    let daemonDiagnostics = "";
    let daemonSpawnError: Error | undefined;
    daemon = spawn(paths.nodeRuntime, nativeCandidateDaemonArguments(paths, port), {
      cwd: launchCwd,
      env: environment.daemon,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    daemon.once("error", (error) => { daemonSpawnError = error; });
    daemon.stdout?.on("data", (chunk: Buffer) => { daemonDiagnostics = appendBounded(daemonDiagnostics, chunk); });
    daemon.stderr?.on("data", (chunk: Buffer) => { daemonDiagnostics = appendBounded(daemonDiagnostics, chunk); });
    try {
      await waitForSocket(
        resolve(privateHome, "Library/Application Support/Placekeeper/control.sock"),
        daemon,
        () => daemonSpawnError,
      );
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${daemonDiagnostics}`.trim());
    }

    let appDiagnostics = "";
    let appSpawnError: Error | undefined;
    application = spawn(paths.executable, [options.pdfPath], {
      cwd: launchCwd,
      env: environment.application,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    application.once("error", (error) => { appSpawnError = error; });
    application.stderr?.on("data", (chunk: Buffer) => {
      appDiagnostics = appendBounded(appDiagnostics, chunk);
      if (!options.smoke) process.stderr.write(chunk);
    });
    process.stdout.write(
      `Native candidate: ${paths.appPath}\nPDF: ${options.pdfPath}\nPrivate state: ${privateHome}\n`,
    );
    if (!options.smoke) {
      process.stdout.write("The installed Placekeeper remains untouched. Quit the candidate app to clean up.\n");
      await waitForExit(application, 2_147_483_647);
      if (interruptedSignal === undefined && application.exitCode !== 0) {
        throw new Error(
          `Native candidate exited ${application.exitCode ?? application.signalCode ?? "unexpectedly"}\n${appDiagnostics}`,
        );
      }
    } else {
      const deadline = Date.now() + options.timeoutMs;
      while (
        !appDiagnostics.includes("page-document-ready-accepted") ||
        !appDiagnostics.includes("runtime-activated")
      ) {
        if (appSpawnError !== undefined) throw appSpawnError;
        if (application.exitCode !== null || application.signalCode !== null) {
          throw new Error(
            `Native candidate exited ${application.exitCode ?? application.signalCode} before smoke readiness\n${appDiagnostics}`,
          );
        }
        if (daemonSpawnError !== undefined) throw daemonSpawnError;
        if (daemon.exitCode !== null || daemon.signalCode !== null) {
          throw new Error(`Native candidate daemon exited ${daemon.exitCode ?? daemon.signalCode}\n${daemonDiagnostics}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`Native candidate smoke timed out after ${options.timeoutMs}ms\n${appDiagnostics}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      process.stdout.write("Native candidate smoke passed: document ready and runtime activated.\n");
    }
    if (interruptedSignal !== undefined) process.exitCode = 128 + (interruptedSignal === "SIGINT" ? 2 : 15);
  } finally {
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    const failures = await Promise.allSettled([stopProcess(application), stopProcess(daemon)]);
    await rm(runnerRoot, { recursive: true, force: true });
    const failedStop = failures.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failedStop !== undefined) throw failedStop.reason;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runNativeCandidate(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
