import { switchDesktopService } from "./desktop-service-switch.js";
import { createInterface } from "node:readline/promises";
import type { UpgradeAttemptCredentials, UpgradePreparationRequest, UpgradePreparationStatus } from "../host/upgrade-preparation.js";
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

function desktopResources(appPath: string): string {
  return join(appPath, process.platform === "darwin" ? "Contents/Resources/desktop" : "resources/desktop");
}
function desktopLauncher(appPath: string): string {
  return process.platform === "darwin" ? join(appPath, "Contents/MacOS/placekeeper")
    : join(desktopResources(appPath), "bin", `placekeeper${process.platform === "win32" ? ".exe" : ""}`);
}

async function readIdentity(appPath: string): Promise<PackagedBuildIdentity | undefined> {
  try {
    const raw = await readFile(join(desktopResources(appPath), "runtime-manifest.json"), "utf8").catch(() => readFile(join(appPath, "Contents/Resources/build-identity.json"), "utf8"));
    const value = JSON.parse(raw) as Partial<PackagedBuildIdentity>;
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
        await waitForProcessRetirement(receipt.pid);
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

async function coordinateLifecycleMutation(
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
  if (!hostSetup && await lstat(join(desktopResources(candidateApp), "runtime-manifest.json")).then(() => true, () => false)) {
    const backupRoot = join(paths.appSupportRoot, "installer", `recovery-backup-${Date.now()}`);
    await switchDesktopService({
      resources: desktopResources(candidateApp), backup: backupRoot,
      prepare: async (status, selected) => {
        const request = async (request: UpgradePreparationRequest): Promise<UpgradePreparationStatus> => {
          const response = await requestControl(paths.socketPath, { kind: "upgrade-preparation", request });
          if (response.kind !== "upgrade-preparation" || response.result.phase === "none" || !("token" in response.result)) throw new Error("Upgrade preparation response is invalid");
          return response.result;
        };
        const preview = await request({ operation: "preview", installedDaemonIdentity: status.daemonIdentity, candidate: selected });
        const credentials: UpgradeAttemptCredentials = { attemptId: preview.attemptId, token: preview.token, candidate: preview.candidate };
        try {
          if (!process.stdin.isTTY) throw new Error("Active reviews need approval to close. Run the source installer in an interactive terminal, or close reviews and retry.");
          const terminal = createInterface({ input: process.stdin, output: process.stderr });
          let accepted = false;
          try { accepted = /^y(?:es)?$/iu.test((await terminal.question("Installing Placekeeper will close active reviews after protecting pending edits and drafts. Close reviews and continue? [y/N] ")).trim()); }
          finally { terminal.close(); }
          let preparation = await request({ operation: "begin", credentials, consent: accepted });
          if (!accepted) throw new Error("Installation canceled; current reviews remain available");
          const deadline = Date.now() + 120_000;
          while (preparation.phase === "preparing" && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
            preparation = await request({ operation: "status", credentials });
          }
          if (preparation.phase !== "ready") throw new Error("Pending review work could not be protected; installation stopped");
          if ((await request({ operation: "commit", credentials })).phase !== "committed") throw new Error("Review closure was not committed");
          return credentials;
        } catch (error) { await request({ operation: "cancel", credentials }).catch(() => undefined); throw error; }
      },
      receipt: join(paths.appSupportRoot, "installer", `install-ready-${Date.now()}.json`), paths,
      replaceAndReady: async (lifecycleToken) => {
        if (!replaceHelper.endsWith(".mjs")) throw new Error("Desktop installation requires the portable replacement helper");
        await execFileAsync(process.execPath, [replaceHelper, candidateApp, installedApp, desktopLauncher(installedApp),
          ...(smokePort === undefined ? [] : [String(smokePort), ...(paths.isolatedTestRoot === undefined ? [] : [paths.isolatedTestRoot])])], { timeout: 300_000, maxBuffer: 65_536, env: { ...process.env,
          [LIFECYCLE_LOCK_TOKEN_ENV]: lifecycleToken,
          PLACEKEEPER_INSTALL_BACKUP_ROOT: backupRoot,
          [LIFECYCLE_LOCK_PATH_ENV]: paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"),
        } });
      },
    });
    return "installed";
  }

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
          if (daemonUnavailable(error)) throw new DaemonUpgradeRequiredError("early-close");
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
  if (args[0] === "switch-service") {
    if (args.length !== 7) throw new Error("Use daemon switch-service --resources <root> --backup <new-path> --receipt <new-path>");
    try {
      await switchDesktopService({ resources: takeFlag(args, "--resources"), backup: takeFlag(args, "--backup"), receipt: takeFlag(args, "--receipt"), paths });
      write(`${JSON.stringify({ ok: true, status: "ready" })}\n`);
      return 0;
    } catch (failure) {
      const error = failure instanceof LifecycleLockTimeoutError ? new DaemonUpgradeRequiredError("transient-busy") : failure;
      write(`${JSON.stringify({ ok: false, error: {
        kind: error instanceof DaemonUpgradeRequiredError ? "upgrade-required" : "input-unavailable",
        message: error instanceof Error ? error.message : "The selected service did not become ready. Recovery was retained.",
        recoveryAction: error instanceof DaemonUpgradeRequiredError ? error.recoveryAction : "Inspect the selected installation and retained recovery backup, then retry service selection",
      } })}\n`);
      return 2;
    }
  }
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
    const status = await coordinateLifecycleMutation(args, paths, write);
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
