import { execFile } from "node:child_process";
import { lstat, readFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  DaemonUpgradeRequiredError,
  inspectDaemonCompatibility,
  MANAGEMENT_PROTOCOL_VERSION,
  managementShutdownResult,
  ProofreaderControlProtocolError,
  ProofreaderControlTimeoutError,
  requestControl,
} from "../host/launch-control.js";
import {
  DAEMON_IDENTITY_ENV,
  type CandidateDaemonReceipt,
  defaultDaemonPaths,
  daemonUnavailable,
  ensureServiceDaemonReady,
  INSTALL_ARTIFACT_IDENTITY_ENV,
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

async function stopReadyCandidate(receiptPath: string): Promise<void> {
  const paths = defaultDaemonPaths();
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

async function coordinateInstall(args: readonly string[]): Promise<"noop" | "installed"> {
  const candidateApp = takeFlag(args, "--candidate-app");
  const installedApp = takeFlag(args, "--installed-app");
  const obsoleteAction = takeFlag(args, "--obsolete-action");
  const replaceHelper = takeFlag(args, "--replace-helper");
  const candidate = await readIdentity(candidateApp);
  if (candidate === undefined) throw new Error("The candidate build identity is invalid");
  if (
    candidate.daemonIdentity !== process.env[DAEMON_IDENTITY_ENV] ||
    candidate.installArtifactIdentity !== process.env[INSTALL_ARTIFACT_IDENTITY_ENV]
  ) throw new Error("The candidate launcher identity does not match its bundle");

  const paths = defaultDaemonPaths();
  const lifecycleLock = await acquireLifecycleLock(
    paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
    { timeoutMs: 5_000 },
  );
  try {
    const installed = await readIdentity(installedApp);
    const result = await coordinateUpgrade({
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
          if (error instanceof ProofreaderControlTimeoutError) {
            throw new DaemonUpgradeRequiredError("timeout");
          }
          if (error instanceof ProofreaderControlProtocolError) {
            throw new DaemonUpgradeRequiredError(error.reason);
          }
          throw error;
        }
      },
      waitForRetirement: () => waitForSocketRetirement(paths.socketPath),
      replaceAndReady: async () => {
        await execFileAsync("/bin/sh", [
          replaceHelper,
          candidateApp,
          installedApp,
          obsoleteAction,
          join(installedApp, "Contents/MacOS/pdf-proofreader"),
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

export function parseOwnedLegacyProcess(
  lsofOutput: string,
  psOutput: string,
  expectedUid: number,
): number | undefined {
  const pids = [...lsofOutput.matchAll(/^p(\d+)$/gmu)].map((match) => Number(match[1]));
  const uids = [...lsofOutput.matchAll(/^u(\d+)$/gmu)].map((match) => Number(match[1]));
  if (pids.length !== 1 || uids.length === 0 || uids.some((uid) => uid !== expectedUid)) return undefined;
  const match = /^\s*(\d+)\s+(.+)$/u.exec(psOutput.trim());
  if (match === null || Number(match[1]) !== expectedUid) return undefined;
  const command = match[2]!;
  if (!/(?:PDF Proofreader\.app|pdf-markup).*\/service\/main\.js\s+daemon(?:\s|$)/u.test(command)) return undefined;
  return pids[0];
}

async function stopLegacyDaemon(): Promise<void> {
  const paths = defaultDaemonPaths();
  const lock = await acquireLifecycleLock(
    paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
    { timeoutMs: 5_000 },
  );
  try {
    const info = await lstat(paths.socketPath);
    const uid = process.getuid?.();
    if (uid === undefined || !info.isSocket() || info.uid !== uid) {
      throw new Error("The PDF Proofreader socket is not an owned local socket");
    }
    const { stdout: lsofOutput } = await execFileAsync(
      "/usr/sbin/lsof",
      ["-n", "-P", "-a", "-U", paths.socketPath, "-Fpu"],
      { timeout: 2_000, maxBuffer: 16_384 },
    );
    const pidMatch = /^p(\d+)$/mu.exec(lsofOutput);
    if (pidMatch === null) throw new Error("No owned PDF Proofreader daemon is listening");
    const { stdout: psOutput } = await execFileAsync(
      "/bin/ps",
      ["-p", pidMatch[1]!, "-o", "uid=", "-o", "command="],
      { timeout: 2_000, maxBuffer: 16_384 },
    );
    const pid = parseOwnedLegacyProcess(lsofOutput, psOutput, uid);
    if (pid === undefined) throw new Error("The socket listener is not a validated PDF Proofreader daemon");
    process.kill(pid, "SIGTERM");
    await waitForSocketRetirement(paths.socketPath);
  } finally {
    await lock.release();
  }
}

export async function runDaemonCommand(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args[0] === "ensure-ready") {
    const receiptPath = takeFlag(args, "--receipt");
    await ensureServiceDaemonReady(defaultDaemonPaths(), process.env[LIFECYCLE_LOCK_TOKEN_ENV], receiptPath);
    write(`${JSON.stringify({ ok: true, status: "ready" })}\n`);
    return 0;
  }
  if (args[0] === "stop-ready") {
    await stopReadyCandidate(takeFlag(args, "--receipt"));
    write(`${JSON.stringify({ ok: true, status: "stopped" })}\n`);
    return 0;
  }
  if (args[0] === "stop-legacy") {
    await stopLegacyDaemon();
    write(`${JSON.stringify({ ok: true, status: "stopped" })}\n`);
    return 0;
  }
  if (args[0] !== "coordinate-install") throw new Error("Unsupported daemon command");
  try {
    const status = await coordinateInstall(args);
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
