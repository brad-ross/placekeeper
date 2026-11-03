import { parseElectronAppControlResponse, type ElectronAppControlMessage, type ElectronAppControlResponse } from "../../../../packages/core/src/electron-app-control-protocol.js";
import { validElectronReviewHelperResponse, type ElectronReviewHelperMessage, type ElectronReviewHelperResponse } from "../../../../packages/core/src/electron-helper-protocol.js";
import { observeIsolatedDaemonStartup } from './daemon-startup-diagnostic.js';
import { closeWindowsNativeWorker } from "../platform/windows-native-worker.js";
import { readControlDiscovery } from "../platform/control-transport.js";
import { platformPath, resolvePlatformLocations } from "../platform/locations.js";
import { resolvePackagedRuntime, type PackagedRuntimeInstallation } from "../platform/runtime-layout.js";
import { NativeQualificationExperiments } from "../codex/native-qualification-experiments.js";
import { NativeQualificationObserver } from "../codex/native-qualification.js";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, realpath, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";

import {
  DaemonUpgradeRequiredError,
  inspectDaemonCompatibility,
  requestControl,
  startLaunchControlServer,
  type PlacekeeperControlRequest,
  type PlacekeeperControlResponse,
} from "./launch-control.js";
import type { LaunchRequest, LaunchResponse } from "./placekeeper-host.js";
import type {
  LinkLaunchResponse,
  LinkOpenRequest,
  LinkPreflightResponse,
} from "./placekeeper-host.js";
import { PlacekeeperHost } from "./placekeeper-host.js";
import { acquireLifecycleLock, LifecycleLockTimeoutError } from "./lifecycle-lock.js";
import { upgradeReason } from "./upgrade-coordinator.js";
import { PLACEKEEPER_HTTP_PORT } from "../server/http-server.js";
import type { ChromeBrowserSourceOpenRequest } from "../browser/browser-source-store.js";
import type {
  ChromeRuntimeExtensionMessage,
  ChromeRuntimeHostMessage,
} from "../../../../packages/core/src/chrome-native-runtime-protocol.js";
import type {
  MacosReviewHelperMessage,
  MacosReviewHelperResponse,
} from "../../../../packages/core/src/macos-helper-protocol.js";
import { validMacosReviewHelperResponse } from "../../../../packages/core/src/macos-helper-protocol.js";
import type {
  MacosAppControlMessage,
  MacosAppControlResponse,
} from "../../../../packages/core/src/macos-app-control-protocol.js";
import { parseMacosAppControlResponse } from "../../../../packages/core/src/macos-app-control-protocol.js";

export interface DaemonPaths {
  readonly appSupportRoot: string;
  readonly recoveryRoot: string;
  readonly socketPath: string;
  readonly webAssetsRoot: string;
  readonly httpPort?: number;
  readonly isolatedTestRoot?: string;
  readonly packagedRuntime?: PackagedRuntimeInstallation;
  readonly lifecycleLockPath?: string;
}

export const DAEMON_IDENTITY_ENV = "PLACEKEEPER_DAEMON_IDENTITY";
export const INSTALL_ARTIFACT_IDENTITY_ENV = "PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY";
export const LIFECYCLE_LOCK_TOKEN_ENV = "PLACEKEEPER_LIFECYCLE_LOCK_TOKEN";
export const LIFECYCLE_LOCK_PATH_ENV = "PLACEKEEPER_LIFECYCLE_LOCK_PATH";
export const READINESS_TOKEN_ENV = "PLACEKEEPER_READINESS_TOKEN";
export const MACOS_DEVELOPMENT_ROOT_ENV = "PLACEKEEPER_MAC_DEVELOPMENT_ROOT";
export const MACOS_DEVELOPMENT_HTTP_PORT_ENV = "PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT";
export const INSTALLED_SMOKE_DAEMON_FLAG = "--isolated-installed-smoke";
export const INSTALLED_SMOKE_HTTP_PORT_FLAG = "--http-port";
export const INSTALLED_SMOKE_ROOT_FLAG = "--isolated-test-root";

export interface CandidateDaemonReceipt {
  readonly version: 1;
  readonly pid: number;
  readonly daemonIdentity: string;
  readonly readinessToken: string;
}

function currentDaemonIdentity(): string {
  return process.env[DAEMON_IDENTITY_ENV] ?? "development";
}

export function defaultDaemonPaths(): DaemonPaths {
  const fixedAppSupportRoot = resolvePlatformLocations().appSupportRoot;
  const developmentRoot = currentDaemonIdentity() === "development"
    ? process.env[MACOS_DEVELOPMENT_ROOT_ENV]
    : undefined;
  const appSupportRoot = developmentRoot !== undefined && platformPath(process.platform).isAbsolute(developmentRoot)
    && developmentRoot.length <= 16_384 && !developmentRoot.includes("\0")
    ? resolve(developmentRoot)
    : fixedAppSupportRoot;
  const developmentPortText = developmentRoot === undefined
    ? undefined
    : process.env[MACOS_DEVELOPMENT_HTTP_PORT_ENV];
  const developmentPort = developmentPortText !== undefined && /^[1-9][0-9]{0,4}$/u.test(developmentPortText)
    && Number(developmentPortText) <= 65_535
    ? Number(developmentPortText)
    : undefined;
  return {
    appSupportRoot,
    recoveryRoot: join(appSupportRoot, "recovery"),
    socketPath: join(appSupportRoot, "control.sock"),
    lifecycleLockPath: process.env[LIFECYCLE_LOCK_PATH_ENV] ?? join(appSupportRoot, "lifecycle.lock"),
    // Packaged service identity hashes this exact sibling tree. Development
    // and tests can still inject a different root through an explicit paths
    // object, but an inherited environment cannot make packaged code serve
    // caller-selected browser assets under a trusted build identity.
    webAssetsRoot: resolve(dirname(process.argv[1] ?? "."), "../web"),
    httpPort: developmentPort ?? PLACEKEEPER_HTTP_PORT,
  };
}

/** Test-only command-line configuration for the installed lifecycle smoke.
 * Production uses the fixed packaged port and never reads a port override
 * from the environment. */
export function installedSmokeDaemonPaths(args: readonly string[]): DaemonPaths | undefined {
  const smokeIndexes = args.flatMap((value, index) => value === INSTALLED_SMOKE_DAEMON_FLAG ? [index] : []);
  const portIndexes = args.flatMap((value, index) => value === INSTALLED_SMOKE_HTTP_PORT_FLAG ? [index] : []);
  const rootIndexes = args.flatMap((value, index) => value === INSTALLED_SMOKE_ROOT_FLAG ? [index] : []);
  if (smokeIndexes.length === 0 && portIndexes.length === 0 && rootIndexes.length === 0) return undefined;
  if (rootIndexes.length > 1) throw new Error("The isolated installed smoke requires at most one root");
  if (smokeIndexes.length !== 1 || portIndexes.length !== 1) {
    throw new Error("The isolated installed smoke requires one explicit HTTP port");
  }
  const portText = args[portIndexes[0]! + 1];
  if (!/^[1-9][0-9]{0,4}$/u.test(portText ?? "")) {
    throw new Error("The isolated installed smoke HTTP port is invalid");
  }
  const httpPort = Number(portText);
  if (httpPort > 65_535) throw new Error("The isolated installed smoke HTTP port is invalid");
  const rootText = rootIndexes.length === 0 ? undefined : args[rootIndexes[0]! + 1];
  if (rootIndexes.length !== 0 && (rootText === undefined || !platformPath(process.platform).isAbsolute(rootText)
    || rootText.length > 16_384 || rootText.includes("\0"))) {
    throw new Error("The isolated installed smoke root must be absolute");
  }
  if (rootText === undefined) return { ...defaultDaemonPaths(), httpPort };
  const isolatedTestRoot = resolve(rootText);
  return {
    ...defaultDaemonPaths(), httpPort, isolatedTestRoot,
    appSupportRoot: isolatedTestRoot,
    recoveryRoot: join(isolatedTestRoot, "recovery"),
    socketPath: join(isolatedTestRoot, "control.sock"),
    lifecycleLockPath: join(isolatedTestRoot, "lifecycle.lock"),
  };
}

/** Explicit CLI forwarding preserves isolated roots across independent Node children. */
export function installedSmokeDaemonArgs(paths: DaemonPaths): string[] {
  if (paths.isolatedTestRoot !== undefined) {
    return [INSTALLED_SMOKE_DAEMON_FLAG, INSTALLED_SMOKE_HTTP_PORT_FLAG,
      String(paths.httpPort ?? PLACEKEEPER_HTTP_PORT), INSTALLED_SMOKE_ROOT_FLAG, paths.isolatedTestRoot];
  }
  return paths.httpPort !== undefined && paths.httpPort !== PLACEKEEPER_HTTP_PORT
    ? [INSTALLED_SMOKE_DAEMON_FLAG, INSTALLED_SMOKE_HTTP_PORT_FLAG, String(paths.httpPort)] : [];
}

async function removeConfirmedStaleSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (process.platform === "win32") {
    const discovery = await readControlDiscovery(socketPath);
    try { process.kill(discovery.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      const current = await lstat(socketPath);
      if (current.ino === info.ino && current.dev === info.dev && (await readControlDiscovery(socketPath)).epoch === discovery.epoch) await unlink(socketPath);
      return;
    }
    throw new Error("Placekeeper service is already running");
  }
  if (!info.isSocket()) return;
  await new Promise<void>((resolveConnection, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("Cannot inspect existing control socket")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("Placekeeper service is already running")); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT") { reject(error); return; }
      void (async () => {
        const current = await lstat(socketPath).catch(() => undefined);
        if (current?.ino === info.ino && current.dev === info.dev) await unlink(socketPath);
      })().then(resolveConnection, reject);
    });
  });
}

export async function startServiceDaemon(paths = defaultDaemonPaths()): Promise<{
  readonly host: PlacekeeperHost;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}> {
  const lockPath = paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock");
  const lifecycleLock = await acquireLifecycleLock(lockPath, {
    timeoutMs: 5_000,
    ...(process.env[LIFECYCLE_LOCK_TOKEN_ENV] === undefined
      ? {}
      : { inheritedToken: process.env[LIFECYCLE_LOCK_TOKEN_ENV] }),
  });
  let host: PlacekeeperHost | undefined;
  try {
    await removeConfirmedStaleSocket(paths.socketPath);
    host = await PlacekeeperHost.start({
      nativeQualification: new NativeQualificationObserver(paths.appSupportRoot, "daemon"),
      nativeQualificationExperiments: new NativeQualificationExperiments(paths.appSupportRoot),
      recoveryRoot: paths.recoveryRoot,
      browserSourceRoot: join(paths.appSupportRoot, "browser-sources"),
      webAssets: { root: paths.webAssetsRoot },
      port: paths.httpPort ?? PLACEKEEPER_HTTP_PORT,
    });
    const startedHost = host;
    const control = await startLaunchControlServer(startedHost, paths.socketPath, {
      daemonIdentity: currentDaemonIdentity(),
      ...(process.env[READINESS_TOKEN_ENV] === undefined
        ? {}
        : { readinessToken: process.env[READINESS_TOKEN_ENV] }),
    });
    await lifecycleLock.release();
    return {
      host: startedHost,
      closed: control.closed,
      close: async () => {
        await startedHost.close();
        await control.close();
        await closeWindowsNativeWorker();
      },
    };
  } catch (error) {
    await host?.close();
    await lifecycleLock.release();
    throw error;
  }
}

export function daemonUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "ECONNRESET";
}

const isolatedStartupDiagnostics = new WeakMap<ChildProcess, () => Promise<void>>();

async function spawnServiceDaemon(
  entry: string,
  paths: DaemonPaths,
  lifecycleToken: string,
  readinessToken?: string,
): Promise<ChildProcess> {
  if (paths.packagedRuntime === undefined && process.versions.electron !== undefined) {
    throw new Error("The desktop launcher requires an independent packaged Node runtime");
  }
  const runtime = paths.packagedRuntime === undefined ? undefined : await resolvePackagedRuntime(
    paths.packagedRuntime.root, paths.packagedRuntime.manifest, paths.packagedRuntime.expectedIdentity,
  );
  if (runtime !== undefined && await realpath(paths.webAssetsRoot) !== runtime.webAssetsRoot) {
    throw new Error("Packaged runtime web assets do not match daemon paths");
  }
  if (runtime !== undefined && !paths.packagedRuntime!.manifest.webAssets.files.some(file => file.path === "pdfium.wasm")) {
    throw new Error("The packaged service PDFium runtime is missing from verified web assets");
  }
  const child = spawn(runtime?.nodeExecutable ?? process.execPath, [
    runtime?.serviceEntry ?? entry,
    "daemon",
    ...installedSmokeDaemonArgs(paths),
  ], {
    detached: true,
    stdio: paths.isolatedTestRoot === undefined ? "ignore" : ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      ...(runtime === undefined ? {} : {
        [DAEMON_IDENTITY_ENV]: runtime.daemonIdentity,
        [INSTALL_ARTIFACT_IDENTITY_ENV]: runtime.installArtifactIdentity,
        PLACEKEEPER_PDFIUM_WASM: join(runtime.webAssetsRoot, "pdfium.wasm"),
      }),
      PLACEKEEPER_WEB_ASSETS: paths.webAssetsRoot,
      [LIFECYCLE_LOCK_TOKEN_ENV]: lifecycleToken,
      [LIFECYCLE_LOCK_PATH_ENV]: paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
      ...(readinessToken === undefined ? {} : { [READINESS_TOKEN_ENV]: readinessToken }),
    },
  });
  if (paths.isolatedTestRoot !== undefined) isolatedStartupDiagnostics.set(child, observeIsolatedDaemonStartup(child));
  await new Promise<void>((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  child.unref();
  return child;
}

export async function launchThroughDaemon(
  request: LaunchRequest,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<LaunchResponse> {
  const response = await demandStartedControl({ kind: "launch", request }, paths, signal);
  if (response.kind !== "launch") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}

export async function openChromeBrowserSourceThroughDaemon(
  request: ChromeBrowserSourceOpenRequest,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<LaunchResponse> {
  const response = await demandStartedControl({ kind: "chrome-open", request }, paths, signal);
  if (response.kind !== "chrome-open") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}

export async function chromeRuntimeThroughDaemon(
  portId: string,
  message: ChromeRuntimeExtensionMessage,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<readonly ChromeRuntimeHostMessage[]> {
  const request = { kind: "chrome-runtime" as const, portId, message };
  // Negotiation may need to start the daemon and therefore uses the lifecycle
  // lock. Once the daemon owns the port, its aggregate activity keeps it alive
  // and upgrade-ineligible; routing later frames directly avoids serializing
  // independent Chrome tabs behind a long save picker or export.
  const response = message.type === "hello"
    ? await demandStartedControl(request, paths, signal)
    : await requestControl(paths.socketPath, request, {
        timeoutMs: 10 * 60_000,
        ...(signal === undefined ? {} : { signal }),
      });
  if (response.kind !== "chrome-runtime") throw new DaemonUpgradeRequiredError("malformed");
  return response.messages;
}

export async function detachChromeRuntimeThroughDaemon(
  portId: string,
  paths = defaultDaemonPaths(),
): Promise<void> {
  const response = await requestControl(
    paths.socketPath,
    { kind: "chrome-runtime-detach", portId },
    { timeoutMs: 15_000 },
  );
  if (response.kind !== "chrome-runtime-detached") throw new DaemonUpgradeRequiredError("malformed");
}

export async function macosRuntimeThroughDaemon(
  appInstanceId: string,
  helperId: string,
  message: MacosReviewHelperMessage,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<MacosReviewHelperResponse> {
  const request = { kind: "macos-runtime" as const, appInstanceId, helperId, message };
  const response = message.type === "admit" || message.type === "admit-link"
    ? await demandStartedControl(request, paths, signal)
    : await requestControl(paths.socketPath, request, {
        timeoutMs: 10 * 60_000,
        ...(signal === undefined ? {} : { signal }),
      });
  if (response.kind !== "macos-runtime" || !validMacosReviewHelperResponse(response.response)) {
    throw new DaemonUpgradeRequiredError("malformed");
  }
  return response.response;
}

export async function detachMacosRuntimeThroughDaemon(
  appInstanceId: string,
  helperId: string,
  paths = defaultDaemonPaths(),
): Promise<void> {
  const response = await requestControl(
    paths.socketPath,
    { kind: "macos-runtime-detach", appInstanceId, helperId },
    { timeoutMs: 15_000 },
  );
  if (response.kind !== "macos-runtime-detached") throw new DaemonUpgradeRequiredError("malformed");
}

export async function macosAppControlThroughDaemon(
  message: MacosAppControlMessage,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<MacosAppControlResponse> {
  const request = { kind: "macos-app-control" as const, message };
  const response = message.type === "register-app"
    ? await demandStartedControl(request, paths, signal)
    : await requestControl(paths.socketPath, request, {
        timeoutMs: 15_000,
        ...(signal === undefined ? {} : { signal }),
      });
  if (response.kind !== "macos-app-control" || parseMacosAppControlResponse(response.response) === undefined) {
    throw new DaemonUpgradeRequiredError("malformed");
  }
  return response.response;
}

export async function electronRuntimeThroughDaemon(
  appInstanceId: string,
  helperId: string,
  message: ElectronReviewHelperMessage,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<ElectronReviewHelperResponse> {
  const request = { kind: "electron-runtime" as const, appInstanceId, helperId, message };
  const response = message.type === "admit" || message.type === "admit-link"
    ? await demandStartedControl(request, paths, signal)
    : await requestControl(paths.socketPath, request, {
        timeoutMs: 10 * 60_000,
        ...(signal === undefined ? {} : { signal }),
      });
  if (response.kind !== "electron-runtime" || !validElectronReviewHelperResponse(response.response)) {
    throw new DaemonUpgradeRequiredError("malformed");
  }
  return response.response;
}

export async function detachElectronRuntimeThroughDaemon(
  appInstanceId: string,
  helperId: string,
  paths = defaultDaemonPaths(),
): Promise<void> {
  const response = await requestControl(
    paths.socketPath,
    { kind: "electron-runtime-detach", appInstanceId, helperId },
    { timeoutMs: 15_000 },
  );
  if (response.kind !== "electron-runtime-detached") throw new DaemonUpgradeRequiredError("malformed");
}

export async function electronAppControlThroughDaemon(
  message: ElectronAppControlMessage,
  signal?: AbortSignal,
  paths = defaultDaemonPaths(),
): Promise<ElectronAppControlResponse> {
  const request = { kind: "electron-app-control" as const, message };
  const response = message.type === "register-app"
    ? await demandStartedControl(request, paths, signal)
    : await requestControl(paths.socketPath, request, {
        timeoutMs: 15_000,
        ...(signal === undefined ? {} : { signal }),
      });
  if (response.kind !== "electron-app-control" || parseElectronAppControlResponse(response.response) === undefined) {
    throw new DaemonUpgradeRequiredError("malformed");
  }
  return response.response;
}

export async function preflightLinkThroughDaemon(
  link: string,
  paths = defaultDaemonPaths(),
): Promise<LinkPreflightResponse> {
  const response = await demandStartedControl({ kind: "link-preflight", link }, paths);
  if (response.kind !== "link-preflight") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}

export async function openLinkThroughDaemon(
  request: LinkOpenRequest,
  paths = defaultDaemonPaths(),
): Promise<LinkLaunchResponse> {
  const response = await demandStartedControl({ kind: "link-open", request }, paths);
  if (response.kind !== "link-open") throw new DaemonUpgradeRequiredError("malformed");
  return response.response;
}

async function demandStartedControl(
  request: PlacekeeperControlRequest,
  paths: DaemonPaths,
  signal?: AbortSignal,
): Promise<PlacekeeperControlResponse> {
  signal?.throwIfAborted();
  const lockPath = paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock");
  let lifecycleLock;
  try {
    lifecycleLock = await acquireLifecycleLock(lockPath, { timeoutMs: 5_000 });
  } catch (error) {
    if (error instanceof LifecycleLockTimeoutError) {
      throw new DaemonUpgradeRequiredError("transient-busy");
    }
    throw error;
  }
  try {
    return await controlWhileLocked(request, paths, lifecycleLock.token, signal);
  } finally {
    await lifecycleLock.release();
  }
}

async function controlWhileLocked(
  request: PlacekeeperControlRequest,
  paths: DaemonPaths,
  lifecycleToken: string,
  signal?: AbortSignal,
): Promise<PlacekeeperControlResponse> {
  try {
    const compatibility = await waitForAcceptingCompatibility(paths.socketPath, paths.packagedRuntime?.expectedIdentity.daemonIdentity ?? currentDaemonIdentity());
    if (compatibility.kind !== "exact") {
      throw new DaemonUpgradeRequiredError(
        compatibility.kind === "incompatible"
          ? upgradeReason(compatibility.status.activity) ?? "incompatible"
          : compatibility.reason,
      );
    }
    return await requestControl(paths.socketPath, request, signal === undefined ? {} : { signal });
  } catch (error) {
    if (!daemonUnavailable(error)) throw error;
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("The placekeeper launcher entry point is unavailable");
  const started = await spawnServiceDaemon(entry, paths, lifecycleToken);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    signal?.throwIfAborted();
    if (started.exitCode !== null || started.signalCode !== null) {
      await isolatedStartupDiagnostics.get(started)?.();
      throw new Error('The local placekeeper service exited before becoming ready');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    try {
      const compatibility = await waitForAcceptingCompatibility(paths.socketPath, paths.packagedRuntime?.expectedIdentity.daemonIdentity ?? currentDaemonIdentity());
      if (compatibility.kind !== "exact") {
        throw new DaemonUpgradeRequiredError(
          compatibility.kind === "incompatible"
            ? upgradeReason(compatibility.status.activity) ?? "incompatible"
            : compatibility.reason,
        );
      }
      return await requestControl(paths.socketPath, request, signal === undefined ? {} : { signal });
    } catch (error) {
      if (!daemonUnavailable(error)) throw error;
    }
  }
  await isolatedStartupDiagnostics.get(started)?.();
  throw new Error("The local placekeeper service did not become ready");
}

/** Starts the exact packaged daemon while an installer holds the lifecycle
 * lock, then proves its management endpoint is accepting before commit. */
export async function ensureServiceDaemonReady(
  paths = defaultDaemonPaths(),
  lifecycleToken = process.env[LIFECYCLE_LOCK_TOKEN_ENV],
  receiptPath?: string,
): Promise<CandidateDaemonReceipt> {
  if (lifecycleToken === undefined) {
    throw new Error("Candidate readiness requires the inherited lifecycle lock");
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("The placekeeper launcher entry point is unavailable");
  const readinessToken = randomBytes(24).toString("base64url");
  const child = await spawnServiceDaemon(entry, paths, lifecycleToken, readinessToken);
  if (child.pid === undefined) throw new Error("Candidate daemon did not expose its process identity");
  const receipt: CandidateDaemonReceipt = {
    version: 1,
    pid: child.pid,
    daemonIdentity: paths.packagedRuntime?.expectedIdentity.daemonIdentity ?? currentDaemonIdentity(),
    readinessToken,
  };
  let spawnError: Error | undefined;
  child.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 5_000;
  try {
    if (receiptPath !== undefined) {
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
    }
    while (true) {
      if (spawnError !== undefined) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Candidate daemon exited ${child.exitCode}`);
      try {
        const compatibility = await inspectDaemonCompatibility(paths.socketPath, paths.packagedRuntime?.expectedIdentity.daemonIdentity ?? currentDaemonIdentity());
        if (
          compatibility.kind === "exact" &&
          compatibility.status.lifecycle === "accepting" &&
          compatibility.status.readinessToken === readinessToken
        ) return receipt;
        if (compatibility.kind !== "exact") {
          throw new Error("Candidate daemon did not expose its exact build identity");
        }
      } catch (error) {
        if (!daemonUnavailable(error)) throw error;
      }
      if (Date.now() >= deadline) throw new Error("Candidate daemon did not become ready");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  } catch (error) {
    if (child.pid !== undefined) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* already stopped */ }
    }
    await Promise.race([
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
      new Promise<void>((_, rejectTimeout) => setTimeout(
        () => rejectTimeout(new Error("Candidate daemon did not stop after readiness failure")),
        5_000,
      )),
    ]);
    throw error;
  }
}

async function waitForAcceptingCompatibility(socketPath: string, identity: string) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const compatibility = await inspectDaemonCompatibility(socketPath, identity);
    if (compatibility.kind !== "exact" || compatibility.status.lifecycle === "accepting") {
      return compatibility;
    }
    if (Date.now() >= deadline) throw new DaemonUpgradeRequiredError("transient-busy");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

/** Lifecycle hooks never start or discover a host; they address only the
 * private daemon created by the exact successful launch they observed. */
export function controlThroughDaemon(
  request: PlacekeeperControlRequest,
  paths = defaultDaemonPaths(),
): Promise<PlacekeeperControlResponse> {
  return requestControl(paths.socketPath, request);
}

export async function runServiceDaemon(paths = defaultDaemonPaths()): Promise<void> {
  const daemon = await startServiceDaemon(paths);
  const signal = Promise.withResolvers<void>();
  const resolveSignal = (): void => signal.resolve();
  process.once("SIGINT", resolveSignal);
  process.once("SIGTERM", resolveSignal);
  try {
    await Promise.race([signal.promise, daemon.closed]);
    await daemon.close();
  } finally {
    process.off("SIGINT", resolveSignal);
    process.off("SIGTERM", resolveSignal);
  }
}

/** Trusted main-only launch resolution; this never crosses a renderer bridge. */
export async function resolveElectronLaunchThroughDaemon(launchId: string, paths = defaultDaemonPaths()): Promise<{ sourcePath: string; sessionId: string; documentGeneration: number } | undefined> {
  const response = await controlThroughDaemon({ kind: "electron-resolve-launch", launchId }, paths);
  if (response.kind !== "electron-resolve-launch") throw new DaemonUpgradeRequiredError("malformed");
  return response.target;
}
