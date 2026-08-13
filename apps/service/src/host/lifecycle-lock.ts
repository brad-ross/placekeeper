import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface LifecycleLockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
}

interface StoredLifecycleLockRecord extends LifecycleLockRecord {
  readonly markerPath: string;
}

interface LifecycleLockObservation {
  readonly record?: StoredLifecycleLockRecord;
  readonly markerPath?: string;
}

export interface LifecycleLockLease {
  readonly token: string;
  readonly borrowed: boolean;
  release(): Promise<void>;
}

export interface LifecycleLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly inheritedToken?: string;
  readonly now?: () => number;
  /** Deterministic race hook used only by lifecycle-lock tests. */
  readonly afterStaleMarkerRemoved?: () => Promise<void> | void;
}

export class LifecycleLockTimeoutError extends Error {
  constructor() {
    super("Placekeeper lifecycle coordination is busy");
    this.name = "LifecycleLockTimeoutError";
  }
}

const OWNER_PREFIX = "owner-";
const OWNER_SUFFIX = ".json";

function ownerFilename(token: string): string {
  return `${OWNER_PREFIX}${token}${OWNER_SUFFIX}`;
}

function parseRecord(raw: string, expectedToken: string): LifecycleLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LifecycleLockRecord>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      value.token !== expectedToken ||
      !/^[A-Za-z0-9_-]{32}$/u.test(value.token)
    ) return undefined;
    return { version: 1, pid: value.pid!, token: value.token };
  } catch {
    return undefined;
  }
}

async function inspectLock(lockPath: string): Promise<LifecycleLockObservation> {
  const entries = await readdir(lockPath, { withFileTypes: true }).catch(() => []);
  const markers = entries.filter((entry) =>
    entry.isFile() && entry.name.startsWith(OWNER_PREFIX) && entry.name.endsWith(OWNER_SUFFIX));
  if (markers.length !== 1) return {};
  const marker = markers[0]!;
  const token = marker.name.slice(OWNER_PREFIX.length, -OWNER_SUFFIX.length);
  const markerPath = join(lockPath, marker.name);
  if (!/^[A-Za-z0-9_-]{32}$/u.test(token)) return { markerPath };
  const record = parseRecord(await readFile(markerPath, "utf8").catch(() => ""), token);
  return record === undefined
    ? { markerPath }
    : { markerPath, record: { ...record, markerPath } };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Remove only the marker that was proven stale. The final rmdir is atomic and
 * fails with ENOTEMPTY if another contender has already published a new token,
 * so an earlier reclaimer can never delete a later owner's lease. */
async function removeStaleRecord(
  lockPath: string,
  observation: LifecycleLockObservation,
  now: () => number,
  afterStaleMarkerRemoved?: () => Promise<void> | void,
): Promise<void> {
  const record = observation.record;
  if (record !== undefined && processExists(record.pid)) return;
  if (record === undefined) {
    const inspectedPath = observation.markerPath ?? lockPath;
    const info = await lstat(inspectedPath).catch(() => undefined);
    if (info === undefined || now() - info.mtimeMs < 1_000) return;
    if (observation.markerPath !== undefined) {
      await unlink(observation.markerPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await afterStaleMarkerRemoved?.();
    }
  } else {
    await unlink(record.markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await afterStaleMarkerRemoved?.();
  }
  await rmdir(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** A small cross-process lease used to linearize install, launch, and startup.
 * A child may borrow only the exact opaque token already present on disk. */
export async function acquireLifecycleLock(
  lockPath: string,
  options: LifecycleLockOptions = {},
): Promise<LifecycleLockLease> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 25;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    const inherited = options.inheritedToken;
    if (inherited !== undefined) {
      const observation = await inspectLock(lockPath);
      if (observation.record?.token === inherited) {
        return { token: inherited, borrowed: true, release: async () => {} };
      }
    } else {
      const token = randomBytes(24).toString("base64url");
      const record: LifecycleLockRecord = { version: 1, pid: process.pid, token };
      try {
        await mkdir(lockPath, { mode: 0o700 });
        const markerPath = join(lockPath, ownerFilename(token));
        try {
          await writeFile(markerPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
        } catch (error) {
          await rmdir(lockPath).catch(() => undefined);
          throw error;
        }
        let released = false;
        return {
          token,
          borrowed: false,
          release: async () => {
            if (released) return;
            released = true;
            await unlink(markerPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
            await rmdir(lockPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
            });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    const observation = await inspectLock(lockPath);
    await removeStaleRecord(
      lockPath,
      observation,
      now,
      options.afterStaleMarkerRemoved,
    );
    if (now() >= deadline) throw new LifecycleLockTimeoutError();
    await delay(pollMs);
  }
}
