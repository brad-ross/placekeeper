import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, unlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
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

export interface DaemonPaths {
  readonly appSupportRoot: string;
  readonly recoveryRoot: string;
  readonly socketPath: string;
  readonly webAssetsRoot: string;
  readonly httpPort?: number;
  readonly lifecycleLockPath?: string;
}

export const DAEMON_IDENTITY_ENV = "PLACEKEEPER_DAEMON_IDENTITY";
export const INSTALL_ARTIFACT_IDENTITY_ENV = "PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY";
export const LIFECYCLE_LOCK_TOKEN_ENV = "PLACEKEEPER_LIFECYCLE_LOCK_TOKEN";
export const LIFECYCLE_LOCK_PATH_ENV = "PLACEKEEPER_LIFECYCLE_LOCK_PATH";
export const READINESS_TOKEN_ENV = "PLACEKEEPER_READINESS_TOKEN";
export const INSTALLED_SMOKE_DAEMON_FLAG = "--isolated-installed-smoke";
export const INSTALLED_SMOKE_HTTP_PORT_FLAG = "--http-port";

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
  const appSupportRoot = join(
    homedir(),
    "Library",
    "Application Support",
    "Placekeeper",
  );
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
    httpPort: PLACEKEEPER_HTTP_PORT,
  };
}

/** Test-only command-line configuration for the installed lifecycle smoke.
 * Production uses the fixed packaged port and never reads a port override
 * from the environment. */
export function installedSmokeDaemonPaths(args: readonly string[]): DaemonPaths | undefined {
  const smokeIndexes = args.flatMap((value, index) => value === INSTALLED_SMOKE_DAEMON_FLAG ? [index] : []);
  const portIndexes = args.flatMap((value, index) => value === INSTALLED_SMOKE_HTTP_PORT_FLAG ? [index] : []);
  if (smokeIndexes.length === 0 && portIndexes.length === 0) return undefined;
  if (smokeIndexes.length !== 1 || portIndexes.length !== 1) {
    throw new Error("The isolated installed smoke requires one explicit HTTP port");
  }
  const portText = args[portIndexes[0]! + 1];
  if (!/^[1-9][0-9]{0,4}$/u.test(portText ?? "")) {
    throw new Error("The isolated installed smoke HTTP port is invalid");
  }
  const httpPort = Number(portText);
  if (httpPort > 65_535) throw new Error("The isolated installed smoke HTTP port is invalid");
  return { ...defaultDaemonPaths(), httpPort };
}

async function removeConfirmedStaleSocket(socketPath: string): Promise<void> {
  const info = await lstat(socketPath).catch(() => undefined);
  if (info?.isSocket() !== true) return;
  await new Promise<void>((resolveConnection) => {
    const socket = createConnection(socketPath);
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      socket.destroy();
      resolveConnection();
    });
    socket.once("error", () => {
      if (!connected) void unlink(socketPath).finally(resolveConnection);
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
      recoveryRoot: paths.recoveryRoot,
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

function spawnServiceDaemon(
  entry: string,
  paths: DaemonPaths,
  lifecycleToken: string,
  readinessToken?: string,
): ChildProcess {
  const httpPort = paths.httpPort ?? PLACEKEEPER_HTTP_PORT;
  const child = spawn(process.execPath, [
    entry,
    "daemon",
    ...(httpPort === PLACEKEEPER_HTTP_PORT
      ? []
      : [INSTALLED_SMOKE_DAEMON_FLAG, INSTALLED_SMOKE_HTTP_PORT_FLAG, String(httpPort)]),
  ], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PLACEKEEPER_WEB_ASSETS: paths.webAssetsRoot,
      [LIFECYCLE_LOCK_TOKEN_ENV]: lifecycleToken,
      [LIFECYCLE_LOCK_PATH_ENV]: paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
      ...(readinessToken === undefined ? {} : { [READINESS_TOKEN_ENV]: readinessToken }),
    },
  });
  child.unref();
  return child;
}

export async function launchThroughDaemon(
  request: LaunchRequest,
  paths = defaultDaemonPaths(),
): Promise<LaunchResponse> {
  const response = await demandStartedControl({ kind: "launch", request }, paths);
  if (response.kind !== "launch") throw new DaemonUpgradeRequiredError("malformed");
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
): Promise<PlacekeeperControlResponse> {
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
    return await controlWhileLocked(request, paths, lifecycleLock.token);
  } finally {
    await lifecycleLock.release();
  }
}

async function controlWhileLocked(
  request: PlacekeeperControlRequest,
  paths: DaemonPaths,
  lifecycleToken: string,
): Promise<PlacekeeperControlResponse> {
  try {
    const compatibility = await waitForAcceptingCompatibility(paths.socketPath, currentDaemonIdentity());
    if (compatibility.kind !== "exact") {
      throw new DaemonUpgradeRequiredError(
        compatibility.kind === "incompatible"
          ? upgradeReason(compatibility.status.activity) ?? "incompatible"
          : compatibility.reason,
      );
    }
    return await requestControl(paths.socketPath, request);
  } catch (error) {
    if (!daemonUnavailable(error)) throw error;
  }
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("The placekeeper launcher entry point is unavailable");
  spawnServiceDaemon(entry, paths, lifecycleToken);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    try {
      const compatibility = await waitForAcceptingCompatibility(paths.socketPath, currentDaemonIdentity());
      if (compatibility.kind !== "exact") {
        throw new DaemonUpgradeRequiredError(
          compatibility.kind === "incompatible"
            ? upgradeReason(compatibility.status.activity) ?? "incompatible"
            : compatibility.reason,
        );
      }
      return await requestControl(paths.socketPath, request);
    } catch (error) {
      if (!daemonUnavailable(error)) throw error;
    }
  }
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
  const child = spawnServiceDaemon(entry, paths, lifecycleToken, readinessToken);
  if (child.pid === undefined) throw new Error("Candidate daemon did not expose its process identity");
  const receipt: CandidateDaemonReceipt = {
    version: 1,
    pid: child.pid,
    daemonIdentity: currentDaemonIdentity(),
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
        const compatibility = await inspectDaemonCompatibility(paths.socketPath, currentDaemonIdentity());
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
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already stopped */ }
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
