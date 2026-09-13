import { execFile } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  DaemonUpgradeRequiredError,
  inspectDaemonCompatibility,
  MANAGEMENT_PROTOCOL_VERSION,
  managementShutdownResult,
  PlacekeeperControlProtocolError,
  PlacekeeperControlTimeoutError,
  requestControl,
} from "../host/launch-control.js";
import {
  DAEMON_IDENTITY_ENV,
  type CandidateDaemonReceipt,
  defaultDaemonPaths,
  daemonUnavailable,
  ensureServiceDaemonReady,
  INSTALL_ARTIFACT_IDENTITY_ENV,
  installedSmokeDaemonPaths,
  LIFECYCLE_LOCK_PATH_ENV,
  LIFECYCLE_LOCK_TOKEN_ENV,
} from "../host/service-daemon.js";
import { acquireLifecycleLock } from "../host/lifecycle-lock.js";
import { LifecycleLockTimeoutError } from "../host/lifecycle-lock.js";
import {
  coordinateUpgrade,
  type PackagedBuildIdentity,
  upgradeReason,
} from "../host/upgrade-coordinator.js";

const execFileAsync = promisify(execFile);

function takeFlag(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || !isAbsolute(value)) throw new Error(`${flag} requires an absolute path`);
  return value;
}

async function readIdentity(appPath: string): Promise<PackagedBuildIdentity | undefined> {
  try {
    const value = JSON.parse(await readFile(join(appPath, "Contents/Resources/build-identity.json"), "utf8")) as Partial<PackagedBuildIdentity>;
    if (
      !/^[a-f0-9]{64}$/u.test(value.daemonIdentity ?? "") ||
      !/^[a-f0-9]{64}$/u.test(value.installArtifactIdentity ?? "")
    ) return undefined;
    return {
      daemonIdentity: value.daemonIdentity!,
      installArtifactIdentity: value.installArtifactIdentity!,
    };
  } catch {
    return undefined;
  }
}

async function waitForSocketRetirement(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const exists = await lstat(socketPath).then(() => true, () => false);
    if (!exists) return;
    if (Date.now() >= deadline) throw new DaemonUpgradeRequiredError("timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

export async function initialDaemonIsAbsent(error: unknown, socketPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return true;
  if (code !== "ECONNREFUSED") return false;
  return await lstat(socketPath).then(() => false, (failure: NodeJS.ErrnoException) => {
    if (failure.code === "ENOENT") return true;
    throw failure;
  });
}

function parseCandidateReceipt(raw: string): CandidateDaemonReceipt | undefined {
  try {
    const value = JSON.parse(raw) as Partial<CandidateDaemonReceipt>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      !/^[a-f0-9]{64}$/u.test(value.daemonIdentity ?? "") ||
      !/^[A-Za-z0-9_-]{32}$/u.test(value.readinessToken ?? "")
    ) return undefined;
    return value as CandidateDaemonReceipt;
  } catch {
    return undefined;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessRetirement(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processExists(pid)) {
    if (Date.now() >= deadline) throw new DaemonUpgradeRequiredError("timeout");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function terminateCandidateProcess(pid: number): Promise<void> {
  if (processExists(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await waitForProcessRetirement(pid);
}

async function requestIdleShutdown(socketPath: string) {
  const response = await requestControl(socketPath, {
    kind: "management",
    protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
    operation: "shutdown-if-idle",
  });
  const result = managementShutdownResult(response);
  if (result === undefined) throw new DaemonUpgradeRequiredError("malformed");
  return result;
}

async function stopReadyCandidate(receiptPath: string, paths = defaultDaemonPaths()): Promise<void> {
  const inheritedToken = process.env[LIFECYCLE_LOCK_TOKEN_ENV];
  if (inheritedToken === undefined) throw new Error("Candidate retirement requires the inherited lifecycle lock");
  const raw = await readFile(receiptPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (raw === undefined) {
    const socketExists = await lstat(paths.socketPath).then(() => true, () => false);
    if (socketExists) throw new Error("Candidate readiness receipt is missing");
    return;
  }
  const receipt = parseCandidateReceipt(raw);
  if (
    receipt === undefined ||
    receipt.daemonIdentity !== process.env[DAEMON_IDENTITY_ENV]
  ) throw new Error("Candidate readiness receipt is invalid");

  const lock = await acquireLifecycleLock(
    paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
    { timeoutMs: 5_000, inheritedToken },
  );
  try {
    let compatibility;
    try {
      compatibility = await inspectDaemonCompatibility(paths.socketPath, receipt.daemonIdentity);
    } catch (error) {
      if (await initialDaemonIsAbsent(error, paths.socketPath)) {
        await terminateCandidateProcess(receipt.pid);
        await unlink(receiptPath).catch(() => undefined);
        return;
      }
      throw new DaemonUpgradeRequiredError("early-close");
    }
    if (
      compatibility.kind !== "exact" ||
      compatibility.status.readinessToken !== receipt.readinessToken
    ) throw new Error("The running daemon does not match the candidate readiness receipt");
    const shutdown = await requestIdleShutdown(paths.socketPath);
    if (shutdown.status !== "accepted") {
      throw new DaemonUpgradeRequiredError(upgradeReason(shutdown.activity) ?? "transient-busy");
    }
    await waitForSocketRetirement(paths.socketPath);
    await waitForProcessRetirement(receipt.pid);
    await unlink(receiptPath).catch(() => undefined);
  } finally {
    await lock.release();
  }
}

async function coordinateInstall(
  args: readonly string[],
  paths = defaultDaemonPaths(),
  write: (text: string) => void = () => {},
): Promise<"noop" | "installed"> {
  const hostSetup = args[0] === "coordinate-host";
  const installedApp = takeFlag(args, "--installed-app");
  const candidateApp = hostSetup ? installedApp : takeFlag(args, "--candidate-app");
  const replaceHelper = takeFlag(args, hostSetup ? "--host-helper" : "--replace-helper");
  const candidate = await readIdentity(candidateApp);
  if (candidate === undefined) throw new Error("The candidate build identity is invalid");
  if (
    candidate.daemonIdentity !== process.env[DAEMON_IDENTITY_ENV] ||
    candidate.installArtifactIdentity !== process.env[INSTALL_ARTIFACT_IDENTITY_ENV]
  ) throw new Error("The candidate launcher identity does not match its bundle");

  const smokePort = installedSmokeDaemonPaths(args)?.httpPort;
  const lifecycleLock = await acquireLifecycleLock(
    paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
    { timeoutMs: 5_000 },
  );
  try {
    const installed = await readIdentity(installedApp);
    if (hostSetup && (installed?.daemonIdentity !== candidate.daemonIdentity ||
      installed?.installArtifactIdentity !== candidate.installArtifactIdentity)) {
      throw new Error("The installed app changed before host setup; rerun the installer");
    }
    const result = await coordinateUpgrade({
      operation: hostSetup ? "host-setup" : "app-install",
      candidate,
      ...(installed === undefined ? {} : { installed }),
      inspect: async () => {
        try {
          const result = await inspectDaemonCompatibility(paths.socketPath, candidate.daemonIdentity);
          return result;
        } catch (error) {
          if (await initialDaemonIsAbsent(error, paths.socketPath)) return { kind: "absent" };
          if (daemonUnavailable(error)) return { kind: "uninspectable", reason: "early-close" };
          throw error;
        }
      },
      shutdown: async () => {
        try {
          return await requestIdleShutdown(paths.socketPath);
        } catch (error) {
          if (daemonUnavailable(error)) return { status: "accepted" };
          if (error instanceof PlacekeeperControlTimeoutError) {
            throw new DaemonUpgradeRequiredError("timeout");
          }
          if (error instanceof PlacekeeperControlProtocolError) {
            throw new DaemonUpgradeRequiredError(error.reason);
          }
          throw error;
        }
      },
      waitForRetirement: () => waitForSocketRetirement(paths.socketPath),
      replaceAndReady: async () => {
        if (hostSetup) {
          const separator = args.indexOf("--");
          const result = await execFileAsync(join(installedApp, "Contents/Resources/node/bin/node"), [
            replaceHelper, ...(separator < 0 ? [] : args.slice(separator + 1)),
          ], {
            timeout: 300_000, maxBuffer: 1_048_576,
            env: { ...process.env,
              [LIFECYCLE_LOCK_TOKEN_ENV]: lifecycleLock.token,
              [LIFECYCLE_LOCK_PATH_ENV]: paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
            },
          }).catch((error: Error & { stdout?: string; stderr?: string }) => {
            if (error.stdout) write(error.stdout);
            if (error.stderr) process.stderr.write(error.stderr);
            throw error;
          });
          write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          await ensureServiceDaemonReady(paths, lifecycleLock.token);
          return;
        }
        await execFileAsync("/bin/sh", [
          replaceHelper,
          candidateApp,
          installedApp,
          join(installedApp, "Contents/MacOS/placekeeper"),
          ...(smokePort === undefined ? [] : [String(smokePort)]),
        ], {
          timeout: 30_000,
          maxBuffer: 65_536,
          env: {
            ...process.env,
            [LIFECYCLE_LOCK_TOKEN_ENV]: lifecycleLock.token,
            [LIFECYCLE_LOCK_PATH_ENV]: paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
          },
        });
      },
    });
    return result.status;
  } finally {
    await lifecycleLock.release();
  }
}

export async function runDaemonCommand(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  const paths = installedSmokeDaemonPaths(args) ?? defaultDaemonPaths();
  if (args[0] === "ensure-ready") {
    const receiptPath = takeFlag(args, "--receipt");
    await ensureServiceDaemonReady(paths, process.env[LIFECYCLE_LOCK_TOKEN_ENV], receiptPath);
    write(`${JSON.stringify({ ok: true, status: "ready" })}\n`);
    return 0;
  }
  if (args[0] === "stop-ready") {
    await stopReadyCandidate(takeFlag(args, "--receipt"), paths);
    write(`${JSON.stringify({ ok: true, status: "stopped" })}\n`);
    return 0;
  }
  if (args[0] !== "coordinate-install" && args[0] !== "coordinate-host") throw new Error("Unsupported daemon command");
  try {
    const status = await coordinateInstall(args, paths, write);
    write(`${JSON.stringify({ ok: true, status })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof LifecycleLockTimeoutError) {
      error = new DaemonUpgradeRequiredError("transient-busy");
    }
    if (!(error instanceof DaemonUpgradeRequiredError)) throw error;
    write(`${JSON.stringify({
      ok: false,
      error: {
        kind: "upgrade-required",
        message: error.message,
        recoveryAction: error.recoveryAction,
      },
    })}\n`);
    return 2;
  }
}
