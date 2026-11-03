import { readFile, readdir, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { acquireLifecycleLock } from "../host/lifecycle-lock.js";
import { backupRecoveryAndVerify, coordinateServiceSwitch } from "../host/upgrade-coordinator.js";
import { defaultDaemonPaths, daemonUnavailable, ensureServiceDaemonReady, type DaemonPaths } from "../host/service-daemon.js";
import { inspectDaemonCompatibility, managementShutdownResult, requestControl, MANAGEMENT_PROTOCOL_VERSION, DaemonUpgradeRequiredError, PlacekeeperControlProtocolError } from "../host/launch-control.js";
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from "../platform/runtime-layout.js";

async function recoveryVersions(root: string): Promise<Set<number>> {
  const versions = new Set<number>();
  async function walk(path: string): Promise<void> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (info === undefined) return;
    if (!info.isDirectory()) throw new Error("Recovery inspection refuses links and special files");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) {
        // Every recovery snapshot has a checksummed payload. Companion data is
        // copied too; unknown snapshot versions must prevent a writer switch.
        if (!entry.name.endsWith(".json")) continue;
        const value = JSON.parse(await readFile(child, "utf8")) as { payload?: { schemaVersion?: unknown } };
        if (value.payload !== undefined) {
          if (!Number.isSafeInteger(value.payload.schemaVersion)) throw new Error("Unknown protected recovery format");
          versions.add(value.payload.schemaVersion as number);
        }
      } else throw new Error("Recovery inspection refuses links and special files");
    }
  }
  await walk(root); return versions;
}

/** The selected service is changed only after compare-and-drain, a verified
 * recovery copy, and exact readiness. Closing a GUI never substitutes for this. */
export async function switchDesktopService(options: {
  readonly resources: string;
  readonly backup: string;
  readonly receipt: string;
  readonly paths?: DaemonPaths;
  readonly prepare?: import("../host/upgrade-coordinator.js").CoordinateServiceSwitchOptions["prepare"];
  readonly replaceAndReady?: (lifecycleToken: string) => Promise<void>;
}): Promise<void> {
  if (![options.resources, options.backup, options.receipt].every(isAbsolute)) throw new Error("Service selection requires absolute paths");
  const manifest = JSON.parse(await readFile(join(options.resources, "runtime-manifest.json"), "utf8")) as PackagedRuntimeManifest;
  const runtime = await resolvePackagedRuntime(options.resources, manifest, manifest);
  const paths = options.paths ?? defaultDaemonPaths();
  const lock = await acquireLifecycleLock(paths.lifecycleLockPath ?? join(paths.appSupportRoot, "lifecycle.lock"), { timeoutMs: 5_000 });
  try {
    await coordinateServiceSwitch({
      candidate: manifest,
      ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
      inspect: async () => {
        try { return await inspectDaemonCompatibility(paths.socketPath, manifest.daemonIdentity); }
        catch (error) {
          // ECONNREFUSED with an existing endpoint is not proof of retirement.
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
          if (daemonUnavailable(error)) return { kind: "uninspectable", reason: "early-close" };
          throw error;
        }
      },
      shutdown: async (preparation) => {
        const result = managementShutdownResult(await requestControl(paths.socketPath, { kind: "management", protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: "shutdown-if-idle", ...(preparation === undefined ? {} : { preparation }) }));
        if (result === undefined) throw new DaemonUpgradeRequiredError("malformed");
        return result;
      },
      waitForRetirement: async () => {
        const deadline = Date.now() + 5_000;
        while (true) {
          try { await requestControl(paths.socketPath, { kind: "management", protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: "status" }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" && !await lstat(paths.socketPath).then(() => true, () => false)) return;
            // A status connection can race the already-acknowledged server
            // shutdown. EOF is not retirement proof: keep waiting until the
            // endpoint is actually absent, without retrying initial admission.
            if (!daemonUnavailable(error) && !(error instanceof PlacekeeperControlProtocolError && error.reason === "early-close")) throw error;
          }
          if (Date.now() >= deadline) throw new DaemonUpgradeRequiredError("timeout");
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      },
      recoveryCompatible: async () => {
        const metadata = manifest.recovery;
        if (!metadata || !metadata.readableDraftSchemaVersions.includes(metadata.writtenDraftSchemaVersion)) return false;
        const versions = await recoveryVersions(paths.recoveryRoot);
        return [...versions].every(version => metadata.readableDraftSchemaVersions.includes(version));
      },
      backupAndVerify: async () => {
        // The incumbent may have finished a recovery write while draining.
        const versions = await recoveryVersions(paths.recoveryRoot);
        if (![...versions].every(version => manifest.recovery!.readableDraftSchemaVersions.includes(version))) throw new Error("Protected recovery changed to an unsupported format while draining");
        await backupRecoveryAndVerify(paths.recoveryRoot, options.backup);
      },
      replaceAndReady: async () => {
        if (options.replaceAndReady !== undefined) return options.replaceAndReady(lock.token);
        await ensureServiceDaemonReady({ ...paths, webAssetsRoot: runtime.webAssetsRoot, packagedRuntime: { root: options.resources, manifest, expectedIdentity: manifest } }, lock.token, options.receipt);
      },
    });
  } finally { await lock.release(); }
}
