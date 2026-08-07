import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DraftSnapshotStore } from "./draft-snapshot.js";

export interface RetentionPolicy {
  readonly maxBytes: number;
  readonly maxInactiveAgeMs: number;
}

export interface RetentionResult {
  readonly removedSessionIds: readonly string[];
  readonly retainedActiveSessionIds: readonly string[];
  readonly overLimit: boolean;
}

export async function enforceRetention(
  recoveryRoot: string,
  activeSessionIds: ReadonlySet<string>,
  policy: RetentionPolicy,
  now = Date.now(),
): Promise<RetentionResult> {
  const entries = await readdir(recoveryRoot, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const retainedActiveSessionIds: string[] = [];
  const inactive: Array<{ id: string; path: string; modified: number; bytes: number }> = [];
  let activeBytes = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(recoveryRoot, entry.name);
    const store = new DraftSnapshotStore(path);
    const bytes = await store.allocatedBytes();
    const modified = (await stat(path)).mtimeMs;
    if (activeSessionIds.has(entry.name)) {
      retainedActiveSessionIds.push(entry.name);
      activeBytes += bytes;
    } else {
      inactive.push({ id: entry.name, path, modified, bytes });
    }
  }

  inactive.sort((left, right) => left.modified - right.modified);
  const removedSessionIds: string[] = [];
  let total = activeBytes + inactive.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of inactive) {
    if (
      now - entry.modified > policy.maxInactiveAgeMs ||
      total > policy.maxBytes
    ) {
      await rm(entry.path, { recursive: true, force: true });
      total -= entry.bytes;
      removedSessionIds.push(entry.id);
    }
  }

  return {
    removedSessionIds,
    retainedActiveSessionIds,
    overLimit: total > policy.maxBytes,
  };
}
