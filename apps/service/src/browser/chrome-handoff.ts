import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeBase64Chunk,
  parseExtensionMessage,
  type NativeHostMessage,
  type NativeStartMessage,
} from "./native-messaging.js";
import {
  MAX_CHROME_PDF_BYTES,
  MAX_CHROME_STAGING_BYTES,
} from "./chrome-pdf-limits.js";

export const CHROME_EXTENSION_ID = "cgegjjjhbhnfgcoipeffhogoojfoekgg";
export const CHROME_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}/`;
export const CHROME_NATIVE_PROTOCOL_VERSION = 1;

const DEFAULT_MAX_TRANSFER_BYTES = MAX_CHROME_PDF_BYTES;
const DEFAULT_MAX_AGGREGATE_BYTES = MAX_CHROME_STAGING_BYTES;
const DEFAULT_MAX_CONCURRENT_TRANSFERS = 2;
const DEFAULT_TRANSFER_DURATION_MS = 30_000;
const DEFAULT_STALE_TRANSFER_MS = 120_000;
const HANDLE = /^[A-Za-z0-9_-]{32}$/u;
const PARTIAL = /^\.[A-Za-z0-9_-]{32}\.partial$/u;

declare const sealedBrowserSource: unique symbol;
export type SealedBrowserSourceHandle = string & { readonly [sealedBrowserSource]: true };

export interface SealedBrowserSourceInspection {
  readonly disposition: "remote-temporary";
  readonly path: string;
  readonly displayName?: string;
  readonly byteLength: number;
  readonly sha256: string;
}

interface StagedTransfer {
  readonly path: string;
  readonly file: FileHandle;
  readonly digest: ReturnType<typeof createHash>;
  readonly displayName?: string;
  byteLength: number;
  closed: boolean;
}

export interface ChromeTransferStoreOptions {
  readonly root: string;
  readonly validate: (path: string) => Promise<void>;
  readonly maxConcurrentTransfers?: number;
  readonly maxTransferBytes?: number;
  readonly maxAggregateBytes?: number;
  readonly staleTransferMs?: number;
  readonly now?: () => number;
}

function sanitizedDisplayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = basename(value).replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 120);
  return sanitized === "" ? undefined : sanitized;
}

/**
 * Callers receive only an opaque handle after bytes are durable and
 * structurally valid. The daemon attaches recovery ownership to that handle;
 * browser transport never receives the private path.
 */
export class ChromeTransferStore {
  readonly root: string;
  readonly #validate: (path: string) => Promise<void>;
  readonly #maxConcurrentTransfers: number;
  readonly #maxTransferBytes: number;
  readonly #maxAggregateBytes: number;
  readonly #staleTransferMs: number;
  readonly #now: () => number;
  readonly #sealed = new Map<SealedBrowserSourceHandle, SealedBrowserSourceInspection>();

  private constructor(options: ChromeTransferStoreOptions) {
    this.root = resolve(options.root);
    this.#validate = options.validate;
    this.#maxConcurrentTransfers = options.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS;
    this.#maxTransferBytes = options.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
    this.#maxAggregateBytes = options.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES;
    this.#staleTransferMs = options.staleTransferMs ?? DEFAULT_STALE_TRANSFER_MS;
    this.#now = options.now ?? Date.now;
  }

  static async create(options: ChromeTransferStoreOptions): Promise<ChromeTransferStore> {
    const root = resolve(options.root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(root);
    const canonical = await realpath(root);
    if (
      !metadata.isDirectory() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0
    ) throw new Error("Browser source root must be a secure directory");
    const store = new ChromeTransferStore({ ...options, root: canonical });
    await store.#withAdmissionLock(() => store.#reconcileStaleSources());
    return store;
  }

  async begin(displayName?: string): Promise<StagedTransfer> {
    const safeDisplayName = sanitizedDisplayName(displayName);
    const { path, file } = await this.#withAdmissionLock(async () => {
      await this.#reconcileStaleSources();
      const sources = await this.#ownedSources();
      const partials = sources.filter((source) => source.kind === "partial");
      if (partials.length >= this.#maxConcurrentTransfers) throw new Error("host-busy");
      const reservedBytes = sources.reduce(
        (sum, source) => sum + (source.kind === "partial" ? this.#maxTransferBytes : source.size),
        0,
      );
      if (reservedBytes + this.#maxTransferBytes > this.#maxAggregateBytes) {
        throw new Error("host-byte-budget");
      }
      const path = resolve(this.root, `.${randomBytes(24).toString("base64url")}.partial`);
      const file = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      return { path, file };
    });
    return {
      path,
      file,
      digest: createHash("sha256"),
      ...(safeDisplayName === undefined ? {} : { displayName: safeDisplayName }),
      byteLength: 0,
      closed: false,
    };
  }

  async append(staged: StagedTransfer, bytes: Uint8Array): Promise<void> {
    if (staged.closed) throw new Error("staged-transfer-closed");
    if (staged.byteLength + bytes.byteLength > this.#maxTransferBytes) {
      throw new Error("host-byte-budget");
    }
    // FileHandle.write() is allowed to complete with a short write. writeFile()
    // consumes the full buffer before the chunk is acknowledged.
    await staged.file.writeFile(bytes);
    staged.digest.update(bytes);
    staged.byteLength += bytes.byteLength;
  }

  async cancel(staged: StagedTransfer): Promise<void> {
    if (!staged.closed) {
      staged.closed = true;
      await staged.file.close().catch(() => undefined);
    }
    await unlink(staged.path).catch(() => undefined);
  }

  async seal(staged: StagedTransfer): Promise<SealedBrowserSourceHandle> {
    if (staged.closed) throw new Error("staged-transfer-closed");
    staged.closed = true;
    let committedPath: string | undefined;
    try {
      await staged.file.sync();
      await staged.file.close();
      await this.#validate(staged.path);
      const handle = randomBytes(24).toString("base64url") as SealedBrowserSourceHandle;
      const sealedPath = resolve(this.root, `${handle}.pdf`);
      // link() is the no-clobber commit; unlinking the partial name leaves the
      // same durable inode owned by the opaque handle.
      await link(staged.path, sealedPath);
      committedPath = sealedPath;
      await unlink(staged.path);
      this.#sealed.set(handle, {
        disposition: "remote-temporary",
        path: sealedPath,
        ...(staged.displayName === undefined ? {} : { displayName: staged.displayName }),
        byteLength: staged.byteLength,
        sha256: staged.digest.digest("hex"),
      });
      return handle;
    } catch (error) {
      await staged.file.close().catch(() => undefined);
      await unlink(staged.path).catch(() => undefined);
      if (committedPath !== undefined) await unlink(committedPath).catch(() => undefined);
      throw error;
    }
  }

  async inspect(handle: SealedBrowserSourceHandle): Promise<SealedBrowserSourceInspection> {
    if (!HANDLE.test(handle)) throw new Error("Unknown sealed browser source");
    const source = this.#sealed.get(handle);
    if (source === undefined) throw new Error("Unknown sealed browser source");
    return source;
  }

  async remove(handle: SealedBrowserSourceHandle): Promise<void> {
    const source = this.#sealed.get(handle);
    if (source === undefined) return;
    this.#sealed.delete(handle);
    await unlink(source.path).catch(() => undefined);
  }

  async canonicalizeLocal(fileUrl: string): Promise<string> {
    let url: URL;
    try {
      url = new URL(fileUrl);
    } catch {
      throw new Error("invalid-local-source");
    }
    if (
      url.protocol !== "file:" || url.hostname !== "" || url.username !== "" ||
      url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== ""
    ) throw new Error("invalid-local-source");
    let requested: string;
    try {
      requested = fileURLToPath(url);
    } catch {
      throw new Error("invalid-local-source");
    }
    try {
      const canonical = await realpath(requested);
      const metadata = await stat(canonical);
      if (!metadata.isFile()) throw new Error("invalid-local-source");
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const header = Buffer.alloc(5);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (bytesRead !== header.length || !header.equals(Buffer.from("%PDF-"))) {
          throw new Error("invalid-local-source");
        }
      } finally {
        await file.close();
      }
      return canonical;
    } catch {
      throw new Error("invalid-local-source");
    }
  }

  async #ownedSources(): Promise<Array<{
    readonly kind: "partial" | "sealed";
    readonly path: string;
    readonly size: number;
    readonly mtimeMs: number;
  }>> {
    const sources: Array<{
      readonly kind: "partial" | "sealed";
      readonly path: string;
      readonly size: number;
      readonly mtimeMs: number;
    }> = [];
    for (const name of await readdir(this.root)) {
      if (name === ".quota-lock") continue;
      const kind = PARTIAL.test(name) ? "partial" : name.endsWith(".pdf") && HANDLE.test(name.slice(0, -4))
        ? "sealed"
        : undefined;
      if (kind === undefined) throw new Error("host-byte-budget");
      const path = resolve(this.root, name);
      const metadata = await lstat(path);
      if (
        !metadata.isFile() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0 || metadata.size > this.#maxTransferBytes
      ) throw new Error("host-byte-budget");
      sources.push({ kind, path, size: metadata.size, mtimeMs: metadata.mtimeMs });
    }
    return sources;
  }

  async #reconcileStaleSources(): Promise<void> {
    const now = this.#now();
    for (const source of await this.#ownedSources()) {
      if (now - source.mtimeMs <= this.#staleTransferMs) continue;
      await unlink(source.path);
      for (const [handle, inspection] of this.#sealed) {
        if (inspection.path === source.path) this.#sealed.delete(handle);
      }
    }
  }

  async #withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = resolve(this.root, ".quota-lock");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          return await operation();
        } finally {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const lock = await lstat(lockPath).catch(() => undefined);
        if (lock !== undefined && (!lock.isDirectory() || lock.isSymbolicLink())) {
          throw new Error("Browser source quota lock is invalid");
        }
        if (lock !== undefined && Date.now() - lock.mtimeMs > 60_000) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    throw new Error("host-busy");
  }
}

export interface ChromeTransferQuotaOptions {
  readonly maxConcurrentTransfers?: number;
  readonly maxAggregateBytes?: number;
}

export class ChromeTransferQuota {
  readonly #maxConcurrentTransfers: number;
  readonly #maxAggregateBytes: number;
  readonly #bytes = new Map<string, number>();

  constructor(options: ChromeTransferQuotaOptions = {}) {
    this.#maxConcurrentTransfers = options.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS;
    this.#maxAggregateBytes = options.maxAggregateBytes ?? DEFAULT_MAX_AGGREGATE_BYTES;
  }

  acquire(transferId: string): boolean {
    if (this.#bytes.has(transferId) || this.#bytes.size >= this.#maxConcurrentTransfers) return false;
    this.#bytes.set(transferId, 0);
    return true;
  }

  add(transferId: string, byteLength: number): boolean {
    const current = this.#bytes.get(transferId);
    if (current === undefined) return false;
    const aggregate = [...this.#bytes.values()].reduce((sum, value) => sum + value, 0);
    if (aggregate + byteLength > this.#maxAggregateBytes) return false;
    this.#bytes.set(transferId, current + byteLength);
    return true;
  }

  release(transferId: string): void {
    this.#bytes.delete(transferId);
  }
}

export interface ChromeBrowserReviewOpener {
  openLocal(canonicalPath: string, signal?: AbortSignal): Promise<string>;
  openSealed(handle: SealedBrowserSourceHandle, signal?: AbortSignal): Promise<string>;
}

export interface ChromeHandoffSessionOptions {
  readonly callerOrigin: string;
  readonly store: ChromeTransferStore;
  readonly opener: ChromeBrowserReviewOpener;
  readonly quota?: ChromeTransferQuota;
  readonly maxTransferBytes?: number;
  readonly maxDurationMs?: number;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
}

type SessionState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "remote";
      readonly start: NativeStartMessage & { readonly disposition: "remote-temporary" };
      readonly staged: StagedTransfer;
      readonly deadline: number;
      sequence: number;
      byteLength: number;
    }
  | {
      readonly kind: "local";
      readonly start: NativeStartMessage & { readonly disposition: "local" };
      readonly deadline: number;
    }
  | { readonly kind: "terminal"; readonly transferId?: string };

function validDestination(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === "43179" &&
    url.username === "" && url.password === "" && url.search === "" &&
    /^\/s\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/bootstrap$/u.test(url.pathname) &&
    /^#cap=[A-Za-z0-9_-]{43}$/u.test(url.hash);
}

export class ChromeHandoffSession {
  readonly #store: ChromeTransferStore;
  readonly #opener: ChromeBrowserReviewOpener;
  readonly #quota: ChromeTransferQuota;
  readonly #maxTransferBytes: number;
  readonly #maxDurationMs: number;
  readonly #now: () => number;
  readonly #signal: AbortSignal | undefined;
  #state: SessionState = { kind: "idle" };

  constructor(options: ChromeHandoffSessionOptions) {
    if (options.callerOrigin !== CHROME_EXTENSION_ORIGIN) throw new Error("unauthorized-origin");
    this.#store = options.store;
    this.#opener = options.opener;
    this.#quota = options.quota ?? new ChromeTransferQuota();
    this.#maxTransferBytes = options.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES;
    this.#maxDurationMs = options.maxDurationMs ?? DEFAULT_TRANSFER_DURATION_MS;
    this.#now = options.now ?? Date.now;
    this.#signal = options.signal;
  }

  async handle(raw: unknown): Promise<NativeHostMessage | undefined> {
    if (this.#signal?.aborted === true) return this.#fail("transfer-timeout");
    const message = parseExtensionMessage(raw);
    if (message === undefined) return this.#fail("invalid-message");
    if (this.#state.kind === "terminal") {
      return { type: "failure", transferId: message.transferId, reason: "transfer-closed" };
    }
    if (this.#state.kind !== "idle" && this.#now() > this.#state.deadline) {
      return this.#fail("transfer-timeout");
    }
    if (message.type === "start") return this.#start(message);
    if (this.#state.kind === "idle" || message.transferId !== this.#state.start.transferId) {
      return this.#fail("invalid-state", message.transferId);
    }
    if (message.type === "cancel") {
      await this.#cleanup();
      this.#state = { kind: "terminal", transferId: message.transferId };
      return undefined;
    }
    if (message.type === "chunk") return this.#chunk(message.sequence, message.data);
    return this.#finish(message.sequence);
  }

  async disconnect(): Promise<void> {
    await this.#cleanup();
    const transferId = this.#state.kind === "idle" || this.#state.kind === "terminal"
      ? undefined
      : this.#state.start.transferId;
    this.#state = transferId === undefined ? { kind: "terminal" } : { kind: "terminal", transferId };
  }

  async #start(message: NativeStartMessage): Promise<NativeHostMessage> {
    if (this.#state.kind !== "idle") return this.#fail("invalid-state", message.transferId);
    if (message.protocolVersion !== CHROME_NATIVE_PROTOCOL_VERSION) {
      this.#state = { kind: "terminal", transferId: message.transferId };
      return { type: "failure", transferId: message.transferId, reason: "protocol-mismatch" };
    }
    if (!this.#quota.acquire(message.transferId)) {
      this.#state = { kind: "terminal", transferId: message.transferId };
      return { type: "failure", transferId: message.transferId, reason: "host-busy" };
    }
    const deadline = this.#now() + this.#maxDurationMs;
    try {
      if (message.disposition === "local") {
        this.#state = { kind: "local", start: message, deadline };
      } else {
        this.#state = {
          kind: "remote",
          start: message,
          staged: await this.#store.begin(message.displayName),
          deadline,
          sequence: 0,
          byteLength: 0,
        };
      }
      return { type: "ack", transferId: message.transferId, phase: "start" };
    } catch (error) {
      this.#quota.release(message.transferId);
      this.#state = { kind: "terminal", transferId: message.transferId };
      return {
        type: "failure",
        transferId: message.transferId,
        reason: error instanceof Error && ["host-busy", "host-byte-budget"].includes(error.message)
          ? error.message
          : "staging-unavailable",
      };
    }
  }

  async #chunk(sequence: number, data: string): Promise<NativeHostMessage> {
    if (this.#state.kind !== "remote" || sequence !== this.#state.sequence) {
      return this.#fail("out-of-order");
    }
    const bytes = decodeBase64Chunk(data);
    if (bytes === undefined) return this.#fail("invalid-chunk");
    if (this.#state.byteLength + bytes.length > this.#maxTransferBytes) {
      return this.#fail("transfer-too-large");
    }
    if (!this.#quota.add(this.#state.start.transferId, bytes.length)) {
      return this.#fail("host-byte-budget");
    }
    try {
      await this.#store.append(this.#state.staged, bytes);
      this.#state.byteLength += bytes.length;
      this.#state.sequence += 1;
      return {
        type: "ack",
        transferId: this.#state.start.transferId,
        phase: "chunk",
        sequence,
      };
    } catch (error) {
      return this.#fail(
        error instanceof Error && error.message === "host-byte-budget"
          ? "host-byte-budget"
          : "staging-unavailable",
      );
    }
  }

  async #finish(sequence: number): Promise<NativeHostMessage> {
    const state = this.#state;
    if (state.kind === "remote" && sequence !== state.sequence) return this.#fail("out-of-order");
    if (state.kind === "local" && sequence !== 0) return this.#fail("out-of-order");
    if (state.kind !== "remote" && state.kind !== "local") return this.#fail("invalid-state");
    const transferId = state.start.transferId;
    let sealed: SealedBrowserSourceHandle | undefined;
    try {
      let destination: string;
      if (state.kind === "local") {
        destination = await abortable(
          this.#opener.openLocal(await this.#store.canonicalizeLocal(state.start.fileUrl), this.#signal),
          this.#signal,
        );
      } else {
        if (state.byteLength === 0) throw new Error("invalid-pdf");
        sealed = await this.#store.seal(state.staged);
        destination = await abortable(this.#opener.openSealed(sealed, this.#signal), this.#signal);
      }
      if (!validDestination(destination)) throw new Error("service-unavailable");
      this.#quota.release(transferId);
      this.#state = { kind: "terminal", transferId };
      return { type: "success", transferId, destination };
    } catch (error) {
      if (sealed !== undefined) await this.#store.remove(sealed);
      const reason = error instanceof Error && error.message === "invalid-local-source"
        ? "invalid-local-source"
        : error instanceof Error && error.message === "invalid-pdf"
          ? "invalid-pdf"
          : state.kind === "remote" && sealed === undefined
            ? "invalid-pdf"
            : "service-unavailable";
      return this.#fail(reason, transferId);
    }
  }

  async #cleanup(): Promise<void> {
    const state = this.#state;
    if (state.kind === "remote") await this.#store.cancel(state.staged);
    if (state.kind === "remote" || state.kind === "local") this.#quota.release(state.start.transferId);
  }

  async #fail(reason: string, fallbackTransferId?: string): Promise<NativeHostMessage> {
    const state = this.#state;
    const transferId = state.kind === "remote" || state.kind === "local"
      ? state.start.transferId
      : fallbackTransferId ?? "unknown-transfer";
    await this.#cleanup();
    this.#state = { kind: "terminal", transferId };
    return { type: "failure", transferId, reason };
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolveOperation, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolveOperation, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
