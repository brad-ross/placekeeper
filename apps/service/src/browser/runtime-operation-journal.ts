import { createHash, randomBytes } from "node:crypto";
import { chmod, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { syncDirectory } from "../files/durability.js";
import { ensurePrivateDirectory } from "../recovery/source-snapshot.js";
import { trackRecoveryTemporaryPath } from "../recovery/temporary-path-registry.js";
import { canonicalJson } from "../runtime/canonical-json.js";

interface OperationRecord {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
  durable: boolean;
}

interface StoredOperation {
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly status: "pending" | "completed";
  readonly result?: unknown;
}

export interface RuntimeJournalScope {
  /** Existing broker-owned recovery directory; journal writes never recreate it. */
  readonly directory: string;
  readonly prefix: "chrome" | "macos";
  readonly legacyCanonicalKey?: string;
}

interface JournalLocation {
  readonly directory: string;
  readonly path: string;
  readonly legacyPath?: string;
  readonly scope?: RuntimeJournalScope;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Durable replay follows the recovery session lifetime. Only backed results
 * can leave memory; pending evidence is never evicted from disk to make room. */
export class ChromeRuntimeOperationJournal {
  readonly #records = new Map<string, OperationRecord>();
  readonly #admissions = new Map<string, Promise<void>>();
  readonly #root: string | undefined;
  readonly #scope: ((canonicalKey: string) => RuntimeJournalScope) | undefined;
  readonly #maxCachedOperations: number;

  constructor(options: {
    readonly root?: string;
    readonly scope?: (canonicalKey: string) => RuntimeJournalScope;
    readonly maxCachedOperations?: number;
  } = {}) {
    this.#root = options.root;
    this.#scope = options.scope;
    this.#maxCachedOperations = options.maxCachedOperations ?? 256;
    if (!Number.isSafeInteger(this.#maxCachedOperations) || this.#maxCachedOperations < 1) {
      throw new RangeError("maxCachedOperations must be a positive safe integer");
    }
  }

  retentionStatus(): { readonly cachedOperations: number; readonly admissions: number } {
    return { cachedOperations: this.#records.size, admissions: this.#admissions.size };
  }

  releaseCanonical(canonicalKey: string): void {
    const prefix = `${canonicalKey}\0`;
    for (const key of this.#records.keys()) {
      if (key.startsWith(prefix)) this.#records.delete(key);
    }
  }

  async commit<T>(canonicalKey: string, operationKey: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
    const key = `${canonicalKey}\0${operationKey}`;
    const location = this.#location(canonicalKey, operationKey);
    const fingerprint = digest(canonicalJson(payload));
    const predecessor = this.#admissions.get(key) ?? Promise.resolve();
    const { promise: admission, resolve: releaseAdmission } = Promise.withResolvers<void>();
    this.#admissions.set(key, admission);
    await predecessor;
    try {
      this.#assertScope(canonicalKey, location);
      const cached = this.#records.get(key);
      if (cached !== undefined) {
        if (cached.fingerprint !== fingerprint) throw new Error("idempotency-conflict");
        return await cached.result as T;
      }
      const stored = location === undefined ? undefined : await this.#read(location.path);
      const legacy = stored === undefined && location?.legacyPath !== undefined
        ? await this.#read(location.legacyPath)
        : undefined;
      this.#assertScope(canonicalKey, location);
      const persisted = stored ?? legacy;
      if (legacy !== undefined && location !== undefined) {
        // Publish the exact old outcome (including unknown/pending) durably
        // before retiring its unscoped file. A crash can only leave two copies.
        await this.#persist(canonicalKey, location, legacy);
        await rm(location.legacyPath!, { force: true });
      }
      if (persisted !== undefined) {
        const result = persisted.status === "completed"
          ? Promise.resolve(persisted.result)
          : Promise.reject(new Error("operation-outcome-unknown"));
        result.catch(() => undefined);
        this.#remember(key, { fingerprint: persisted.fingerprint, result, durable: true });
        // Cache pressure may evict this durable record immediately. Its replay
        // decision must use the evidence we just read, regardless of residency.
        if (persisted.fingerprint !== fingerprint) throw new Error("idempotency-conflict");
        return await result as T;
      }
      if (location !== undefined) {
        await this.#persist(canonicalKey, location, { schemaVersion: 1, fingerprint, status: "pending" });
      }
      this.#assertScope(canonicalKey, location);
      const result = operation();
      const record: OperationRecord = { fingerprint, result, durable: false };
      this.#records.set(key, record);
      try {
        const resolved = await result;
        if (location !== undefined) {
          await this.#persist(canonicalKey, location, {
            schemaVersion: 1, fingerprint, status: "completed", result: resolved,
          });
          record.durable = true;
        }
        this.#trim();
        return resolved;
      } catch (error) {
        this.#records.delete(key);
        throw error;
      }
    } finally {
      releaseAdmission();
      if (this.#admissions.get(key) === admission) this.#admissions.delete(key);
    }
  }

  #location(canonicalKey: string, operationKey: string): JournalLocation | undefined {
    const stem = digest(`${canonicalKey}\0${operationKey}`);
    const scope = this.#scope?.(canonicalKey);
    if (scope !== undefined) return {
      scope,
      directory: scope.directory,
      path: join(scope.directory, `.${scope.prefix}-operation-${stem}.json`),
      ...(this.#root === undefined || scope.legacyCanonicalKey === undefined ? {} : {
        legacyPath: join(this.#root, `${digest(`${scope.legacyCanonicalKey}\0${operationKey}`)}.json`),
      }),
    };
    return this.#root === undefined ? undefined : {
      directory: this.#root, path: join(this.#root, `${stem}.json`),
    };
  }

  #assertScope(canonicalKey: string, location: JournalLocation | undefined): void {
    if (location?.scope === undefined) return;
    const current = this.#scope!(canonicalKey);
    if (current.directory !== location.directory || current.prefix !== location.scope.prefix) {
      throw new Error("canonical-review-unavailable");
    }
  }

  #remember(key: string, record: OperationRecord): void {
    this.#records.delete(key);
    this.#records.set(key, record);
    this.#trim();
  }

  #trim(): void {
    for (const [key, record] of this.#records) {
      if (this.#records.size <= this.#maxCachedOperations) return;
      if (record.durable) this.#records.delete(key);
    }
  }

  async #read(path: string): Promise<StoredOperation | undefined> {
    try {
      const bytes = await readFile(path);
      if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("operation-journal-invalid");
      const value = JSON.parse(bytes.toString("utf8")) as Partial<StoredOperation>;
      if (value.schemaVersion !== 1 || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
        (value.status !== "pending" && value.status !== "completed")) {
        throw new Error("operation-journal-invalid");
      }
      return value as StoredOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #persist(canonicalKey: string, location: JournalLocation, value: StoredOperation): Promise<void> {
    this.#assertScope(canonicalKey, location);
    if (location.scope === undefined) await ensurePrivateDirectory(location.directory);
    else await chmod(location.directory, 0o700);
    const temporary = join(location.directory, `.runtime-operation-${randomBytes(12).toString("hex")}.tmp`);
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.byteLength > 8 * 1024 * 1024) throw new Error("operation-result-too-large");
    const stopTracking = trackRecoveryTemporaryPath(temporary);
    let handle: FileHandle | undefined;
    try {
      this.#assertScope(canonicalKey, location);
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.#assertScope(canonicalKey, location);
      await rename(temporary, location.path);
      await chmod(location.path, 0o600);
      await syncDirectory(location.directory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      stopTracking();
    }
  }
}
