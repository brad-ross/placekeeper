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
  readonly shutdown: () => Promise<ConditionalShutdownResult>;
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
    const reason = upgradeReason(inspected.status.activity);
    if (reason !== undefined && reason !== "transient-busy") {
      throw new DaemonUpgradeRequiredError(reason);
    }
    const deadline = Date.now() + (options.retryDurationMs ?? 5_000);
    while (true) {
      const shutdown = await options.shutdown();
      if (shutdown.status === "accepted") break;
      const refusedReason = upgradeReason(shutdown.activity) ?? "transient-busy";
      if (refusedReason !== "transient-busy" || Date.now() >= deadline) {
        throw new DaemonUpgradeRequiredError(refusedReason);
      }
      await (options.retryDelay?.() ?? new Promise((resolveDelay) => setTimeout(resolveDelay, 50)));
    }
    await options.waitForRetirement();
  }
  if (canSkipMutation && artifactIsIdentical) return { status: "noop" };
  await options.replaceAndReady();
  return { status: "installed" };
}
