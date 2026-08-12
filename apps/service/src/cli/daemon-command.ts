import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import {
  DaemonUpgradeRequiredError,
  inspectDaemonCompatibility,
  MANAGEMENT_PROTOCOL_VERSION,
  ProofreaderControlProtocolError,
  ProofreaderControlTimeoutError,
  requestControl,
} from "../host/launch-control.js";
import {
  DAEMON_IDENTITY_ENV,
  defaultDaemonPaths,
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

function unavailable(error: unknown): boolean {
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes((error as NodeJS.ErrnoException).code ?? "");
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
    let runningDaemonIdentity: string | undefined;
    const installed = await readIdentity(installedApp);
    const result = await coordinateUpgrade({
      candidate,
      ...(installed === undefined ? {} : { installed }),
      inspect: async () => {
        try {
          const result = await inspectDaemonCompatibility(paths.socketPath, candidate.daemonIdentity);
          if (result.kind === "exact" || result.kind === "incompatible") {
            runningDaemonIdentity = result.status.daemonIdentity;
          }
          return result;
        } catch (error) {
          if (unavailable(error)) return { kind: "absent" };
          throw error;
        }
      },
      shutdown: async () => {
        let response;
        try {
          response = await requestControl(paths.socketPath, {
            kind: "management",
            protocolVersion: MANAGEMENT_PROTOCOL_VERSION,
            operation: "shutdown-if-idle",
            candidateDaemonIdentity: runningDaemonIdentity === candidate.daemonIdentity
              ? `${candidate.daemonIdentity[0] === "0" ? "1" : "0"}${candidate.daemonIdentity.slice(1)}`
              : candidate.daemonIdentity,
          });
        } catch (error) {
          if (unavailable(error)) return { status: "accepted" };
          if (error instanceof ProofreaderControlTimeoutError) {
            throw new DaemonUpgradeRequiredError("timeout");
          }
          if (error instanceof ProofreaderControlProtocolError) {
            throw new DaemonUpgradeRequiredError(error.reason);
          }
          throw error;
        }
        if (response.kind !== "management" || response.operation !== "shutdown-if-idle") {
          throw new DaemonUpgradeRequiredError("malformed");
        }
        return response.result;
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
    await ensureServiceDaemonReady();
    write(`${JSON.stringify({ ok: true, status: "ready" })}\n`);
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
