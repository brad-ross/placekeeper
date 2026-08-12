import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface LifecycleLockRecord {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
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
}

export class LifecycleLockTimeoutError extends Error {
  constructor() {
    super("PDF Proofreader lifecycle coordination is busy");
    this.name = "LifecycleLockTimeoutError";
  }
}

function parseRecord(raw: string): LifecycleLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<LifecycleLockRecord>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      !/^[A-Za-z0-9_-]{32}$/u.test(value.token)
    ) return undefined;
    return { version: 1, pid: value.pid!, token: value.token };
  } catch {
    return undefined;
  }
}

async function readRecord(lockPath: string): Promise<LifecycleLockRecord | undefined> {
  return parseRecord(await readFile(lockPath, "utf8").catch(() => ""));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleRecord(lockPath: string, record: LifecycleLockRecord | undefined): Promise<void> {
  if (record !== undefined && processExists(record.pid)) return;
  if (record === undefined) {
    const info = await lstat(lockPath).catch(() => undefined);
    if (info === undefined || Date.now() - info.mtimeMs < 1_000) return;
  }
  const current = await readRecord(lockPath);
  if (
    (record === undefined && current === undefined) ||
    (record !== undefined && current?.token === record.token && !processExists(record.pid))
  ) await unlink(lockPath).catch(() => undefined);
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
      const record = await readRecord(lockPath);
      if (record?.token === inherited) {
        return { token: inherited, borrowed: true, release: async () => {} };
      }
    } else {
      const token = randomBytes(24).toString("base64url");
      const record: LifecycleLockRecord = { version: 1, pid: process.pid, token };
      try {
        await writeFile(lockPath, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
        let released = false;
        return {
          token,
          borrowed: false,
          release: async () => {
            if (released) return;
            released = true;
            const current = await readRecord(lockPath);
            if (current?.token === token) await unlink(lockPath).catch(() => undefined);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }

    const record = await readRecord(lockPath);
    await removeStaleRecord(lockPath, record);
    if (now() >= deadline) throw new LifecycleLockTimeoutError();
    await delay(pollMs);
  }
}
