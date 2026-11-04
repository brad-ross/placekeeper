import type { UpgradeAttemptCredentials } from "./upgrade-preparation.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { hashFile } from "../files/file-capabilities.js";
import { join, relative, isAbsolute, sep } from "node:path";
import { ensurePrivateDirectory, writePrivateFile } from "../platform/private-storage.js";
import {
  DaemonUpgradeRequiredError,
  type DaemonAggregateActivity,
  type DaemonCompatibilityResult,
} from "./launch-control.js";
import type { ConditionalShutdownResult } from "./daemon-lifecycle.js";

export interface PackagedBuildIdentity {
  readonly daemonIdentity: string;
  readonly installArtifactIdentity: string;
}

export type UpgradeDaemonInspection = DaemonCompatibilityResult | { readonly kind: "absent" };

export interface CoordinateUpgradeOptions {
  readonly operation?: "app-install" | "host-setup";
  readonly candidate: PackagedBuildIdentity;
  readonly installed?: PackagedBuildIdentity;
  readonly inspect: () => Promise<UpgradeDaemonInspection>;
  readonly shutdown: (preparation?: UpgradeAttemptCredentials) => Promise<ConditionalShutdownResult>;
  /** Obtains consent, protects all current hosts, and commits closure. */
  readonly prepare?: (status: import("./control-protocol.js").DaemonManagementStatus, candidate: PackagedBuildIdentity) => Promise<UpgradeAttemptCredentials>;
  /** Authenticates the exact attempt and verifies it remains committed. */
  readonly validatePreparation?: (credentials: UpgradeAttemptCredentials) => Promise<boolean>;
  readonly cancelPreparation?: (credentials: UpgradeAttemptCredentials) => Promise<void>;
  readonly preparedRetryDurationMs?: number;
  readonly waitForRetirement: () => Promise<void>;
  readonly replaceAndReady: () => Promise<void>;
  readonly retryDurationMs?: number;
  readonly retryDelay?: () => Promise<void>;
}

export function upgradeReason(activity: DaemonAggregateActivity):
  "review-presence" | "codex-task" | "transient-busy" | undefined {
  if (activity.reviewPresence > 0) return "review-presence";
  if (activity.codexTasks > 0) return "codex-task";
  if (activity.transientWork > 0) return "transient-busy";
  return undefined;
}

/** Legacy put-draft can finish after any snapshot inspection but before its
 * shutdown GC, which deletes clean snapshots without checking unfinished input.
 * Neither saved/clean status nor a read-only disk scan can authorize closure. */
export function requireCoordinatedRetirement(status: Pick<import("./control-protocol.js").DaemonManagementStatus, "upgradePreparationVersion">): void {
  if (status.upgradePreparationVersion !== 1) {
    throw new Error("This running Placekeeper version cannot safely be closed by the installer. In the current app, apply or explicitly discard unfinished drafts, save the PDFs, close review windows and browser/editor tabs, and end bound Codex tasks. Quit the current app manually, then retry after its service has stopped. Your current installation and recovery remain unchanged.");
  }
}

/** Pure ordering boundary shared by the source installer and its tests. */
export async function coordinateUpgrade(
  options: CoordinateUpgradeOptions,
): Promise<{ readonly status: "noop" | "installed" }> {
  const canSkipMutation = options.operation !== "host-setup";
  const artifactIsIdentical =
    options.installed !== undefined &&
    options.installed.installArtifactIdentity === options.candidate.installArtifactIdentity;

  const inspected = await options.inspect();
  if (inspected.kind === "uninspectable") {
    throw new DaemonUpgradeRequiredError(inspected.reason);
  }
  if (canSkipMutation && inspected.kind === "exact" && artifactIsIdentical) return { status: "noop" };
  if (inspected.kind !== "absent") {
    requireCoordinatedRetirement(inspected.status);
    let preparation: UpgradeAttemptCredentials | undefined;
    let shutdownAccepted = false;
    try {
      const reason = upgradeReason(inspected.status.activity);
      if (reason !== undefined && reason !== "transient-busy") {
        if (options.prepare) {
          if (!options.validatePreparation || !options.cancelPreparation) throw new Error("Prepared closure requires authenticated status and cancellation");
          preparation = await options.prepare(inspected.status, options.candidate);
          if (preparation.candidate.daemonIdentity !== options.candidate.daemonIdentity || preparation.candidate.installArtifactIdentity !== options.candidate.installArtifactIdentity) throw new Error("Upgrade preparation authorized a different candidate");
        }
        else throw new DaemonUpgradeRequiredError("preparation-required");
      }
      // Committed hosts close on their next poll. Browser disconnect ownership
      // then lasts five seconds, so prepared closure needs a longer boundary
      // than an ordinary idle drain and must retain the same authorization.
      const deadline = Date.now() + (preparation ? options.preparedRetryDurationMs ?? 15_000 : options.retryDurationMs ?? 5_000);
      while (true) {
        if (preparation && !await options.validatePreparation!(preparation)) throw new Error("Upgrade closure is no longer committed for this attempt");
        const shutdown = await options.shutdown(preparation);
        if (shutdown.status === "accepted") { shutdownAccepted = true; break; }
        const refusedReason = upgradeReason(shutdown.activity) ?? "transient-busy";
        if ((preparation === undefined && refusedReason !== "transient-busy") || Date.now() >= deadline) {
          throw new DaemonUpgradeRequiredError(refusedReason);
        }
        await (options.retryDelay?.() ?? new Promise((resolveDelay) => setTimeout(resolveDelay, 50)));
      }
      await options.waitForRetirement();
    } catch (error) {
      // Once shutdown is accepted, its daemon may already be gone. Cancellation
      // cannot restore that service, and retirement uncertainty stays a failure.
      if (preparation && !shutdownAccepted) {
        try { await options.cancelPreparation!(preparation); }
        catch (cancelError) { throw new AggregateError([error, cancelError], "Upgrade closure failed and cancellation could not be confirmed; keep the current installation and retry after reviewing open work"); }
      }
      throw error;
    }
  }
  if (canSkipMutation && artifactIsIdentical) return { status: "noop" };
  await options.replaceAndReady();
  return { status: "installed" };
}

export interface CoordinateServiceSwitchOptions extends Omit<CoordinateUpgradeOptions, "operation" | "installed"> {
  /** Must compare the candidate reader with every protected recovery format. */
  readonly recoveryCompatible: () => Promise<boolean>;
  /** Copies canonical recovery and verifies the copy before candidate startup. */
  readonly backupAndVerify: () => Promise<void>;
}

/** Caller holds the canonical lifecycle lease through readiness or rollback.
 * Rollback uses the same boundary: candidate retirement must be proven before
 * a compatible previous service can write to canonical recovery. */
export async function coordinateServiceSwitch(options: CoordinateServiceSwitchOptions): Promise<void> {
  const inspected = await options.inspect();
  if (inspected.kind === "uninspectable") throw new DaemonUpgradeRequiredError(inspected.reason);
  if (inspected.kind !== "absent") {
    requireCoordinatedRetirement(inspected.status);
    const reason = upgradeReason(inspected.status.activity);
    if (reason !== undefined && reason !== "transient-busy" && !options.prepare) throw new DaemonUpgradeRequiredError("preparation-required");
  }
  if (!await options.recoveryCompatible()) throw new Error("The selected service cannot read protected recovery");
  await coordinateUpgrade({
    ...options,
    operation: "host-setup",
    inspect: async () => inspected,
    replaceAndReady: async () => {
      if (!await options.recoveryCompatible()) throw new Error("Protected recovery changed to an unsupported format while draining");
      await options.backupAndVerify();
      await options.replaceAndReady();
    },
  });
}

/** Caller holds the lifecycle lease and has proven incumbent retirement.
 * The destination must be new; a failed copy is retained for inspection. */
export async function backupRecoveryAndVerify(source: string, destination: string): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(destination)) throw new Error("Recovery backup requires absolute paths");
  const relation = relative(source, destination);
  if (relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) throw new Error("Recovery backup must be outside canonical recovery");
  try { await lstat(destination); throw new Error("Recovery backup destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await ensurePrivateDirectory(destination);
  const inventory = new Map<string, string>();
  async function copy(directory: string, output: string, prefix: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory()) throw new Error("Recovery backup refuses links and special files");
    for (const name of (await readdir(directory)).sort()) {
      const input = join(directory, name); const target = join(output, name); const key = join(prefix, name);
      const entry = await lstat(input);
      if (entry.isDirectory()) { await ensurePrivateDirectory(target); inventory.set(key, "directory"); await copy(input, target, key); }
      else if (entry.isFile()) {
        const digest = createHash("sha256");
        async function* chunks(): AsyncGenerator<Uint8Array> {
          for await (const chunk of createReadStream(input)) {
            digest.update(chunk);
            yield chunk;
          }
        }
        await writePrivateFile(target, chunks());
        inventory.set(key, digest.digest("hex"));
      } else throw new Error("Recovery backup refuses links and special files");
    }
  }
  const sourceInfo = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (sourceInfo !== undefined) await copy(source, destination, "");
  async function verify(directory: string, prefix: string, expected: Map<string, string>): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name); const key = join(prefix, name);
      const info = await lstat(path); const value = expected.get(key);
      if (info.isDirectory() && value === "directory") { expected.delete(key); await verify(path, key, expected); }
      else if (info.isFile() && value === await hashFile(path)) expected.delete(key);
      else throw new Error("Recovery backup verification failed");
    }
  }
  const copied = new Map(inventory);
  await verify(destination, "", copied);
  if (copied.size !== 0) throw new Error("Recovery backup inventory is incomplete");
  if (sourceInfo !== undefined) {
    const canonical = new Map(inventory); await verify(source, "", canonical);
    if (canonical.size !== 0) throw new Error("Canonical recovery changed during backup");
  } else if (await lstat(source).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Canonical recovery appeared during backup");
}
