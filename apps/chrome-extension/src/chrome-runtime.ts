import {
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
  isReviewRuntimeMethodForHost,
  sanitizeChromeReviewRuntimeRequest,
  sanitizeChromeReviewRuntimeResponse,
  type ReviewRuntimeBrokerMethod,
  type ReviewRuntimeMethod,
} from "../../../packages/core/src/review-runtime-protocol.js";
import { sha256Hex } from "../../../packages/core/src/sha256.js";
import { deadlineWasSubstantiallyDelayed } from "../../../packages/core/src/suspend-aware-deadline.js";
import type { EmbeddedReviewLifecycleEvent, PdfStreamInfo } from "./handler-controller.js";
import type { NativePort } from "./chrome-api.js";
import {
  CHROME_RUNTIME_PROTOCOL,
  CHROME_RUNTIME_PROTOCOL_VERSION,
  CHROME_RUNTIME_RESOURCE_CHUNK_BYTES,
  chromeRuntimeProjectionChangeReason,
  isChromeInteractionOwnerSecret,
  parseRuntimeHostMessage,
  validateRuntimeExtensionMessage,
  type ChromeRuntimeExtensionMessage,
  type ChromeRuntimeHostMessage,
} from "./native-protocol.js";

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const INTERACTIVE_REQUEST_TIMEOUT_MS = 5 * 60_000 + 5_000;
const RELEASE_TIMEOUT_MS = 1_000;
const REFRESH_POLL_MS = 1_000;
const REFRESH_RETRY_MIN_MS = 250;
const REFRESH_RETRY_MAX_MS = 4_000;
const OWNER_CLAIM = /^[A-Za-z0-9_-]{16,128}$/u;
const OWNER_HISTORY_KEY = "__placekeeperChromeOwnerClaim";
const TERMINAL_REFRESH_FAILURES = new Set([
  "protocol-mismatch",
  "update-required",
  "disconnected",
  "invalid-host-message",
  "invalid-service-response",
  "invalid-state",
  "connection-closed",
]);
const NON_IDEMPOTENT = new Set<ReviewRuntimeBrokerMethod>([
  "command",
  "beginInteraction",
  "finalizeInteraction",
  "releaseInteraction",
  "acknowledgeInteraction",
  "chooseCopy",
  "chooseFolder",
  "chooseOriginal",
  "retrySave",
  "locateSave",
  "exportReviewedCopy",
]);

interface ReviewRuntimeMessagePort {
  readonly runtimeId: string;
  postMessage(message: unknown): unknown;
  subscribe(listener: (message: unknown) => void): () => void;
}

interface RuntimeProjection {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly activeAuthoringDraftIds: readonly string[];
  readonly state: Record<string, unknown>;
  readonly scope: Record<string, unknown>;
  readonly saveStatus: Record<string, unknown>;
  readonly canonicalLinkBase: string;
  readonly protected: boolean;
  readonly location?: unknown;
  readonly document: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly generation: number;
  };
}

export interface NativeEmbeddedReviewSession {
  readonly displayName: string;
  readonly runtimePort: ReviewRuntimeMessagePort;
  readonly protected: boolean;
  activate(signal?: AbortSignal): Promise<void>;
  confirmDocumentReady(generation: number): void;
  reportViewerFailure(): void;
  release(): Promise<void>;
  dispose(): void;
  subscribeLifecycle(listener: (event: EmbeddedReviewLifecycleEvent) => void): () => void;
}

export interface NativeEmbeddedReviewOptions {
  connectNative(): NativePort;
  fetchStream(url: string, signal?: AbortSignal): Promise<Response>;
  createId(): string;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  getExtensionURL(path: string): string;
  interactionOwnerSecret?(info: PdfStreamInfo): string | Promise<string>;
  chooseRecovery?(
    offer: { readonly choices: readonly ["resume", "discard", "fork"]; readonly offer: { readonly id: string; readonly expiresAt: string } },
    signal?: AbortSignal,
  ): Promise<"resume" | "discard" | "fork">;
  timeoutMs?: number;
  maxDocumentBytes?: number;
  now?(): number;
}

interface ChromeInteractionOwnerClaimEnvironment {
  readonly tabId: number;
  navigationType(): string | undefined;
  readHistoryState(): unknown;
  replaceHistoryState(state: unknown): void;
  readSession(key: string): string | null;
  writeSession(key: string, value: string): void;
  createSecret(): string;
  createClaimId(): string;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return record(value) ? value : {};
}

/** Binds recovery authority to one Chrome tab and one history entry. The
 * history claim is public routing metadata; the 256-bit secret stays in
 * sessionStorage and crosses only the extension/native channel. */
export function createChromeInteractionOwnerClaimStore(
  environment: ChromeInteractionOwnerClaimEnvironment,
): { ownerSecret(): string } {
  let claimed: string | undefined;
  return {
    ownerSecret() {
      if (claimed !== undefined) return claimed;
      const historyState = objectRecord(environment.readHistoryState());
      const existing = objectRecord(historyState[OWNER_HISTORY_KEY]);
      const navigationType = environment.navigationType();
      const recoverableNavigation = navigationType === "reload" || navigationType === "back_forward";
      const existingClaim = existing.tabId === environment.tabId &&
        typeof existing.claimId === "string" && OWNER_CLAIM.test(existing.claimId)
        ? existing.claimId : undefined;
      const recovered = recoverableNavigation && existingClaim !== undefined
        ? environment.readSession(`placekeeper.chrome-interaction-owner.${environment.tabId}.${existingClaim}`)
        : null;
      if (isChromeInteractionOwnerSecret(recovered)) {
        claimed = recovered;
        return claimed;
      }
      const claimId = environment.createClaimId();
      const secret = environment.createSecret();
      if (!OWNER_CLAIM.test(claimId) || !isChromeInteractionOwnerSecret(secret)) {
        throw new Error("Invalid Chrome interaction owner identity.");
      }
      environment.replaceHistoryState({
        ...historyState,
        [OWNER_HISTORY_KEY]: { tabId: environment.tabId, claimId },
      });
      environment.writeSession(
        `placekeeper.chrome-interaction-owner.${environment.tabId}.${claimId}`,
        secret,
      );
      claimed = secret;
      return secret;
    },
  };
}

interface PendingNativeRequest {
  readonly accept: (message: ChromeRuntimeHostMessage) => boolean;
  readonly resolve: (message: ChromeRuntimeHostMessage) => void;
  readonly reject: (error: Error) => void;
  readonly cleanupAbort?: () => void;
  timer: ReturnType<typeof setTimeout>;
}

type NativeExtensionBody = ChromeRuntimeExtensionMessage extends infer Message
  ? Message extends ChromeRuntimeExtensionMessage
    ? Omit<Message, "protocolVersion" | "connectionId">
    : never
  : never;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function aborted(): Error {
  return new DOMException("The embedded review was cancelled.", "AbortError");
}

class NativeRuntimeError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

function reasonError(reason: string): Error {
  if (reason === "export-conflict") {
    return new NativeRuntimeError(reason, "Review changed. Confirm the annotation name again to export the latest review.");
  }
  if (reason === "protocol-mismatch" || reason === "update-required") {
    return new NativeRuntimeError(reason, "Update the Placekeeper Chrome extension and native service, then reopen this review (protocol-mismatch).");
  }
  return new NativeRuntimeError(reason, `Chrome native runtime ${reason}.`);
}

export function chromePdfDisplayName(originalUrl: string): string {
  try {
    const decoded = decodeURIComponent(new URL(originalUrl).pathname.split("/").pop() ?? "");
    const safe = decoded
      .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return [...(safe || "document.pdf")].slice(0, 120).join("");
  } catch {
    return "document.pdf";
  }
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function concatenate(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== byteLength) throw new Error("Document byte count changed during acquisition.");
  return bytes;
}

function verifyPdfBytes(bytes: Uint8Array, projection: RuntimeProjection): void {
  if (bytes.byteLength !== projection.document.byteLength || sha256Hex(bytes) !== projection.document.sha256) {
    throw new Error("Document integrity did not match the service projection.");
  }
  if (bytes.byteLength < 5 || new TextDecoder("ascii").decode(bytes.subarray(0, 5)) !== "%PDF-") {
    throw new Error("Document validation failed before viewer activation.");
  }
}

function runtimeProjection(value: unknown): RuntimeProjection | undefined {
  if (!record(value) || !record(value.document) || !record(value.state) || !record(value.scope) ||
    !record(value.saveStatus) || typeof value.sessionId !== "string" ||
    !Number.isSafeInteger(value.generation) || !Number.isSafeInteger(value.revision) ||
    typeof value.canonicalLinkBase !== "string" || typeof value.protected !== "boolean" ||
    typeof value.document.sha256 !== "string" ||
    !Number.isSafeInteger(value.document.byteLength) || !Number.isSafeInteger(value.document.generation)) {
    return undefined;
  }
  const ids = value.activeAuthoringDraftIds;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 256 ||
    ids.some((id) => typeof id !== "string" || !OWNER_CLAIM.test(id)) ||
    new Set(ids).size !== ids.length)) return undefined;
  return {
    ...value,
    activeAuthoringDraftIds: Object.freeze(ids === undefined ? [] : [...ids]),
  } as unknown as RuntimeProjection;
}

class NativeRuntimeChannel {
  readonly connectionId: string;
  readonly #port: NativePort;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #pending = new Map<string, PendingNativeRequest>();
  readonly #events = new Set<(message: ChromeRuntimeHostMessage) => void>();
  readonly #disconnects = new Set<() => void>();
  #hello: PendingNativeRequest | undefined;
  #closed = false;
  #leaseMs = 90_000;

  constructor(port: NativePort, connectionId: string, timeoutMs: number, now: () => number) {
    this.#port = port;
    this.connectionId = connectionId;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
    port.onMessage.addListener(this.#onMessage);
    port.onDisconnect.addListener(this.#onDisconnect);
  }

  get leaseMs(): number { return this.#leaseMs; }

  subscribe(listener: (message: ChromeRuntimeHostMessage) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  subscribeDisconnect(listener: () => void): () => void {
    this.#disconnects.add(listener);
    return () => this.#disconnects.delete(listener);
  }

  async negotiate(interactionOwnerSecret?: string, signal?: AbortSignal): Promise<boolean> {
    const reply = await this.#requestInternal({
      type: "hello",
      reviewRuntimeVersion: REVIEW_RUNTIME_VERSION,
      protocol: CHROME_RUNTIME_PROTOCOL,
      protocolVersion: CHROME_RUNTIME_PROTOCOL_VERSION,
      connectionId: this.connectionId,
    }, (message) => message.type === "hello-ack", signal, true);
    if (reply.type !== "hello-ack") throw reasonError("protocol-mismatch");
    this.#leaseMs = reply.leaseMs;
    if (interactionOwnerSecret === undefined) return false;
    const requestId = this.connectionId;
    try {
      const claimed = await this.request({
        type: "claim-owner",
        lane: "lifecycle",
        requestId,
        interactionOwnerSecret,
      }, (message) => message.type === "ack" && message.lane === "lifecycle" &&
        message.requestId === requestId, signal);
      return claimed.type === "ack";
    } catch (error) {
      if (error instanceof NativeRuntimeError && error.reason === "invalid-message") return false;
      throw error;
    }
  }

  request(
    body: NativeExtensionBody,
    accept: (message: ChromeRuntimeHostMessage) => boolean,
    signal?: AbortSignal,
    timeoutMs = this.#timeoutMs,
  ): Promise<ChromeRuntimeHostMessage> {
    const message = {
      ...body,
      protocolVersion: CHROME_RUNTIME_PROTOCOL_VERSION,
      connectionId: this.connectionId,
    } as ChromeRuntimeExtensionMessage;
    if (validateRuntimeExtensionMessage(message) === undefined) {
      return Promise.reject(reasonError("invalid-extension-message"));
    }
    return this.#requestInternal(message, accept, signal, false, timeoutMs);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.onMessage.removeListener(this.#onMessage);
    this.#port.onDisconnect.removeListener(this.#onDisconnect);
    this.#failAll(reasonError("disconnected"));
    this.#port.disconnect();
  }

  readonly #onMessage = (raw: unknown): void => {
    if (this.#closed) return;
    const message = parseRuntimeHostMessage(raw);
    if (message === undefined || message.connectionId !== this.connectionId) {
      const rawVersion = record(raw) ? raw.protocolVersion : undefined;
      this.#failAll(reasonError((rawVersion !== CHROME_RUNTIME_PROTOCOL_VERSION || this.#hello !== undefined)
        ? "protocol-mismatch" : "invalid-host-message"));
      return;
    }
    if (message.type === "failure" && this.#hello !== undefined) {
      this.#failAll(reasonError("protocol-mismatch"));
      return;
    }
    if (message.type === "invalidation") {
      for (const [id, pending] of this.#pending) {
        if (!pending.accept(message)) continue;
        this.#deletePending(id);
        pending.resolve(message);
        break;
      }
      for (const listener of this.#events) listener(message);
      return;
    }
    if (message.type === "update-required") {
      const pending = message.requestId === undefined ? undefined : this.#pending.get(message.requestId);
      pending?.reject(reasonError("update-required"));
      if (message.requestId !== undefined) this.#deletePending(message.requestId);
      for (const listener of this.#events) listener(message);
      return;
    }
    if (message.type === "hello-ack") {
      const pending = this.#hello;
      if (pending?.accept(message) === true) {
        this.#hello = undefined;
        clearTimeout(pending.timer);
        pending.cleanupAbort?.();
        pending.resolve(message);
      }
      return;
    }
    if (!("requestId" in message) || message.requestId === undefined) return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    if (message.type === "failure") {
      this.#deletePending(message.requestId);
      pending.reject(reasonError(message.reason));
      return;
    }
    if (!pending.accept(message)) return;
    this.#deletePending(message.requestId);
    pending.resolve(message);
  };

  readonly #onDisconnect = (): void => {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(reasonError("disconnected"));
    for (const listener of this.#disconnects) listener();
  };

  #requestInternal(
    message: ChromeRuntimeExtensionMessage,
    accept: (message: ChromeRuntimeHostMessage) => boolean,
    signal: AbortSignal | undefined,
    hello: boolean,
    timeoutMs = this.#timeoutMs,
  ): Promise<ChromeRuntimeHostMessage> {
    if (this.#closed) return Promise.reject(reasonError("disconnected"));
    if (signal?.aborted === true) return Promise.reject(aborted());
    const id = "requestId" in message ? message.requestId : undefined;
    return new Promise((resolve, reject) => {
      let pending: PendingNativeRequest;
      const armDeadline = (): ReturnType<typeof setTimeout> => {
        const armedAt = this.#now();
        return setTimeout(() => {
          if (deadlineWasSubstantiallyDelayed(armedAt, timeoutMs, this.#now())) {
            pending.timer = armDeadline();
            return;
          }
          if (hello) this.#hello = undefined;
          else if (id !== undefined) this.#pending.delete(id);
          pending.cleanupAbort?.();
          reject(reasonError("request-timeout"));
        }, timeoutMs);
      };
      const timer = armDeadline();
      const onAbort = signal === undefined ? undefined : () => {
        clearTimeout(pending.timer);
        if (hello) this.#hello = undefined;
        else if (id !== undefined) this.#pending.delete(id);
        reject(aborted());
      };
      if (onAbort !== undefined) signal!.addEventListener("abort", onAbort, { once: true });
      pending = {
        accept,
        resolve,
        reject,
        timer,
        ...(onAbort === undefined ? {} : {
          cleanupAbort: () => signal!.removeEventListener("abort", onAbort),
        }),
      };
      if (hello) this.#hello = pending;
      else if (id !== undefined) this.#pending.set(id, pending);
      this.#port.postMessage(message);
    });
  }

  #deletePending(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.cleanupAbort?.();
  }

  #failAll(error: Error): void {
    if (this.#hello !== undefined) {
      clearTimeout(this.#hello.timer);
      this.#hello.cleanupAbort?.();
      this.#hello.reject(error);
      this.#hello = undefined;
    }
    for (const [id, pending] of this.#pending) {
      this.#deletePending(id);
      pending.reject(error);
    }
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array> | undefined): Promise<void> {
  if (reader === undefined) return;
  const deadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000));
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result === "timeout") {
        await reader.cancel("fallback-drain-timeout").catch(() => undefined);
        return;
      }
      if (result.done) return;
    }
  } catch {
    // Chrome owns the fallback network error surface.
  }
}

async function readRemote(
  response: Response,
  channel: NativeRuntimeChannel,
  transferId: string,
  createId: () => string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ readonly chunks: Uint8Array[]; readonly byteLength: number }> {
  if (!response.ok || response.body === null) throw new Error("The PDF response was unavailable.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let sequence = 0;
  try {
    while (true) {
      if (signal?.aborted === true) throw aborted();
      const read = await reader.read();
      if (read.done) break;
      for (let offset = 0; offset < read.value.byteLength; offset += CHROME_RUNTIME_RESOURCE_CHUNK_BYTES) {
        const chunk = read.value
          .subarray(offset, Math.min(offset + CHROME_RUNTIME_RESOURCE_CHUNK_BYTES, read.value.byteLength))
          .slice();
        byteLength += chunk.byteLength;
        if (byteLength > maxBytes) throw new Error("The PDF exceeds Placekeeper's Chrome size limit.");
        chunks.push(chunk);
        const requestId = createId();
        const currentSequence = sequence++;
        await channel.request({
          type: "chunk",
          lane: "acquisition",
          requestId,
          transferId,
          sequence: currentSequence,
          data: base64FromBytes(chunk),
        }, (message) => message.type === "ack" && message.lane === "acquisition" &&
          message.requestId === requestId && message.sequence === currentSequence, signal);
      }
    }
    return { chunks, byteLength };
  } catch (error) {
    if (signal?.aborted === true) await reader.cancel("bypassed").catch(() => undefined);
    else await drain(reader);
    throw error;
  }
}

async function readProjectedDocument(
  channel: NativeRuntimeChannel,
  projection: RuntimeProjection,
  createId: () => string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (projection.document.byteLength > maxBytes) {
    throw new NativeRuntimeError("invalid-service-response", "The PDF exceeds Placekeeper's Chrome size limit.");
  }
  const requestId = createId();
  let reply = await channel.request({
    type: "read",
    lane: "resource",
    requestId,
    resource: "document",
    generation: projection.generation,
    offset: 0,
    length: CHROME_RUNTIME_RESOURCE_CHUNK_BYTES,
  }, (message) => message.type === "resource-chunk" && message.requestId === requestId &&
    message.sequence === 0, signal);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (reply.type === "resource-chunk") {
    let bytes: Uint8Array;
    try {
      bytes = bytesFromBase64(reply.data);
    } catch {
      throw new NativeRuntimeError("invalid-service-response", "The native document resource was malformed.");
    }
    if (bytes.byteLength === 0 || byteLength + bytes.byteLength > projection.document.byteLength) {
      throw new NativeRuntimeError("invalid-service-response", "The native document resource was malformed.");
    }
    chunks.push(bytes);
    byteLength += bytes.byteLength;
    if (reply.done) break;
    const previousSequence = reply.sequence;
    reply = await channel.request({
      type: "ack",
      lane: "resource",
      requestId,
      sequence: previousSequence,
    }, (message) => message.type === "resource-chunk" && message.requestId === requestId &&
      message.sequence === previousSequence + 1, signal);
  }
  if (byteLength !== projection.document.byteLength) {
    throw new NativeRuntimeError("invalid-service-response", "The native document resource ended at the wrong length.");
  }
  return concatenate(chunks, byteLength);
}

function reviewResponse(
  request: Record<string, unknown>,
  projection: RuntimeProjection,
  ok: boolean,
  payload: unknown,
): Record<string, unknown> {
  return {
    protocol: REVIEW_RUNTIME_PROTOCOL,
    version: REVIEW_RUNTIME_VERSION,
    kind: "response",
    runtimeId: request.runtimeId,
    sessionId: typeof request.sessionId === "string" ? request.sessionId : projection.sessionId,
    generation: Number.isSafeInteger(request.generation) ? request.generation : projection.generation,
    revision: Number.isSafeInteger(request.revision) ? request.revision : projection.revision,
    requestId: request.requestId,
    ok,
    payload,
  };
}

export function createNativeEmbeddedReview(options: NativeEmbeddedReviewOptions) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxDocumentBytes = options.maxDocumentBytes ?? MAX_DOCUMENT_BYTES;
  return async (info: PdfStreamInfo, signal?: AbortSignal): Promise<NativeEmbeddedReviewSession> => {
    let response: Response | undefined;
    const connectionId = options.createId();
    const transferId = options.createId();
    const port = options.connectNative();
    const channel = new NativeRuntimeChannel(port, connectionId, timeoutMs, options.now ?? Date.now);
    let acquisitionStarted = false;
    let projection: RuntimeProjection | undefined;
    let documentUrl: string | undefined;
    let released = false;
    try {
      const interactionOwnerSecret = await options.interactionOwnerSecret?.(info);
      const ownerProofAvailable = await channel.negotiate(interactionOwnerSecret, signal);
      const local = new URL(info.originalUrl).protocol === "file:";
      if (!local) {
        try {
          response = await options.fetchStream(info.streamUrl, signal);
        } catch {
          throw new Error("The one-shot PDF stream was unavailable.");
        }
      }
      const beginId = options.createId();
      const displayName = chromePdfDisplayName(info.originalUrl);
      // Once begin is sent the service may have staged a claim even if its ack
      // is lost, so every subsequent failure must explicitly cancel it.
      acquisitionStarted = true;
      await channel.request(local ? {
        type: "begin",
        lane: "acquisition",
        requestId: beginId,
        transferId,
        disposition: "local",
        fileUrl: info.originalUrl,
      } : {
        type: "begin",
        lane: "acquisition",
        requestId: beginId,
        transferId,
        disposition: "remote-temporary",
        sourceUrl: info.originalUrl,
        displayName,
      }, (message) => message.type === "ack" && message.lane === "acquisition" &&
        message.requestId === beginId, signal);
      const retained = local
        ? undefined
        : await readRemote(response!, channel, transferId, options.createId, maxDocumentBytes, signal);
      const finishId = options.createId();
      let finish = await channel.request({
        type: "finish",
        lane: "acquisition",
        requestId: finishId,
        transferId,
        sequence: retained?.chunks.length ?? 0,
      }, (message) => (message.type === "projection" || message.type === "recovery-offered") &&
        message.requestId === finishId, signal);
      if (finish.type === "recovery-offered") {
        if (!ownerProofAvailable) throw reasonError("update-required");
        if (options.chooseRecovery === undefined) throw new Error("Protected recovery requires a user choice.");
        const decision = await options.chooseRecovery({
          choices: finish.choices,
          offer: finish.offer,
        }, signal);
        const recoveryRequestId = options.createId();
        finish = await channel.request({
          type: "recover",
          lane: "lifecycle",
          requestId: recoveryRequestId,
          decision,
          offer: finish.offer,
          idempotencyKey: options.createId(),
        }, (message) => message.type === "projection" && message.requestId === recoveryRequestId, signal);
      }
      if (finish.type !== "projection") throw new Error("The service did not return a review projection.");
      projection = runtimeProjection(finish.payload);
      if (projection === undefined) throw new Error("The service returned an invalid review projection.");
      const documentBytes = local
        ? await readProjectedDocument(channel, projection, options.createId, maxDocumentBytes, signal)
        : concatenate(retained!.chunks, retained!.byteLength);
      verifyPdfBytes(documentBytes, projection);
      // Drop the retained stream-chunk references before Blob snapshots the
      // verified contiguous buffer, keeping peak overhead to one extra PDF.
      retained?.chunks.splice(0);
      // concatenate() always allocates this exact owned ArrayBuffer. Passing it
      // directly avoids retaining a third full-document copy near the 64-MiB gate.
      documentUrl = options.createObjectURL(new Blob([
        documentBytes.buffer as ArrayBuffer,
      ], { type: "application/pdf" }));
      const pdfiumWasm = options.getExtensionURL("shared/pdfium.wasm");
      const worker = options.getExtensionURL("shared/pdfium-worker.js");
      const initialBootstrap = sanitizeChromeReviewRuntimeResponse("bootstrap", {
        ...projection,
        resources: { document: documentUrl, pdfiumWasm, worker },
      });
      if (!record(initialBootstrap)) throw new Error("The handler could not assemble a safe review bootstrap.");

      let bootstrap = initialBootstrap;
      let active = false;
      let protectedReview = projection.protected;
      let adoptedDocumentUrl: string | undefined = documentUrl;
      let pendingDocumentUrl: string | undefined;
      const operationKeys = new Map<string, string>();
      let disposed = false;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      let refreshPoll: ReturnType<typeof setInterval> | undefined;
      let refreshRetry: ReturnType<typeof setTimeout> | undefined;
      let refreshRetryAttempt = 0;
      let refreshInFlight = false;
      let refreshRequested = false;
      let runtimeInvokes = 0;
      let pendingRefreshes = 0;
      const deferredRuntimeRequests: Record<string, unknown>[] = [];
      const runtimeListeners = new Set<(message: unknown) => void>();
      const lifecycleListeners = new Set<(event: EmbeddedReviewLifecycleEvent) => void>();
      let lifecycleFailurePublished = false;
      const emitRuntime = (message: unknown) => {
        for (const listener of runtimeListeners) listener(message);
      };
      const stopRefreshTimers = () => {
        if (refreshPoll !== undefined) clearInterval(refreshPoll);
        if (refreshRetry !== undefined) clearTimeout(refreshRetry);
        refreshPoll = undefined;
        refreshRetry = undefined;
      };
      const publishLifecycleFailure = () => {
        if (released || disposed || lifecycleFailurePublished) return;
        lifecycleFailurePublished = true;
        if (keepalive !== undefined) clearInterval(keepalive);
        stopRefreshTimers();
        for (const listener of lifecycleListeners) listener({
          type: "disconnected",
          protected: protectedReview,
        });
      };
      const terminalRefreshFailure = (error: unknown): boolean => error instanceof NativeRuntimeError &&
        TERMINAL_REFRESH_FAILURES.has(error.reason);
      const confirmDocumentReady = (generation: number) => {
        if (released || disposed || lifecycleFailurePublished || !Number.isSafeInteger(generation) ||
          generation !== projection!.generation ||
          documentUrl === undefined || documentUrl !== pendingDocumentUrl) return;
        const retired = adoptedDocumentUrl;
        adoptedDocumentUrl = documentUrl;
        pendingDocumentUrl = undefined;
        if (retired !== undefined && retired !== documentUrl) options.revokeObjectURL(retired);
        if (refreshRequested) requestRefresh();
      };
      const performRefresh = async () => {
        if (released || disposed || lifecycleFailurePublished) return;
        pendingRefreshes += 1;
        let createdDocumentUrl: string | undefined;
        try {
          const requestId = options.createId();
          const reply = await channel.request({
            type: "refresh",
            lane: "lifecycle",
            requestId,
          }, (candidate) => candidate.type === "projection" && candidate.requestId === requestId);
          if (released || disposed || lifecycleFailurePublished) return;
          if (reply.type !== "projection") {
            throw new NativeRuntimeError("invalid-service-response", "The service did not refresh the review.");
          }
          const next = runtimeProjection(reply.payload);
          const previous = projection!;
          if (next === undefined || next.sessionId !== previous.sessionId ||
            next.generation < previous.generation ||
            (next.generation === previous.generation && next.revision < previous.revision)) {
            throw new NativeRuntimeError("invalid-service-response", "The service returned a stale review projection.");
          }
          const reason = chromeRuntimeProjectionChangeReason(previous, next);
          if (reason === undefined) return;
          let nextDocumentUrl = documentUrl;
          if (next.generation !== previous.generation || next.document.sha256 !== previous.document.sha256 ||
            next.document.byteLength !== previous.document.byteLength) {
            const bytes = await readProjectedDocument(channel, next, options.createId, maxDocumentBytes);
            try {
              verifyPdfBytes(bytes, next);
            } catch {
              throw new NativeRuntimeError("invalid-service-response", "The refreshed PDF resource was invalid.");
            }
            if (released || disposed || lifecycleFailurePublished) return;
            nextDocumentUrl = options.createObjectURL(new Blob([
              bytes.buffer as ArrayBuffer,
            ], { type: "application/pdf" }));
            createdDocumentUrl = nextDocumentUrl;
          }
          if (nextDocumentUrl === undefined) {
            throw new NativeRuntimeError("invalid-service-response", "The refreshed PDF resource was unavailable.");
          }
          const nextBootstrap = sanitizeChromeReviewRuntimeResponse("bootstrap", {
            ...next,
            resources: {
              document: nextDocumentUrl,
              pdfiumWasm,
              worker,
            },
          });
          if (!record(nextBootstrap)) {
            throw new NativeRuntimeError("invalid-service-response", "The refreshed review projection was unsafe.");
          }
          if (released || disposed || lifecycleFailurePublished) return;
          if (nextDocumentUrl !== documentUrl) {
            if (pendingDocumentUrl !== undefined && pendingDocumentUrl !== adoptedDocumentUrl) {
              options.revokeObjectURL(pendingDocumentUrl);
            }
            pendingDocumentUrl = nextDocumentUrl;
            createdDocumentUrl = undefined;
          }
          documentUrl = nextDocumentUrl;
          projection = next;
          bootstrap = nextBootstrap;
          if (next.protected || reason === "save" || next.revision > previous.revision) protectedReview = true;
          emitRuntime({
            protocol: REVIEW_RUNTIME_PROTOCOL,
            version: REVIEW_RUNTIME_VERSION,
            kind: "event",
            event: "session-invalidated",
            runtimeId: connectionId,
            payload: {
              sessionId: next.sessionId,
              generation: next.generation,
              revision: next.revision,
              reason: reason === "generation" ? "generation"
                : reason === "revision" ? "revision"
                  : reason === "presence" ? "presence" : "freshness",
              ...(next.generation === previous.generation ? {} : {
                previousGeneration: previous.generation,
              }),
            },
          });
        } finally {
          if (createdDocumentUrl !== undefined) options.revokeObjectURL(createdDocumentUrl);
          pendingRefreshes = Math.max(0, pendingRefreshes - 1);
          if (pendingRefreshes === 0 && deferredRuntimeRequests.length > 0) {
            const queued = deferredRuntimeRequests.splice(0);
            queueMicrotask(() => {
              for (const request of queued) runtimePort.postMessage(request);
            });
          }
        }
      };
      const scheduleRefreshRetry = () => {
        if (released || disposed || lifecycleFailurePublished || refreshRetry !== undefined) return;
        const delay = Math.min(REFRESH_RETRY_MAX_MS,
          REFRESH_RETRY_MIN_MS * (2 ** Math.min(refreshRetryAttempt, 4)));
        refreshRetryAttempt += 1;
        refreshRetry = setTimeout(() => {
          refreshRetry = undefined;
          requestRefresh();
        }, delay);
        refreshRetry.unref?.();
      };
      const runRefresh = async () => {
        if (refreshInFlight || released || disposed || lifecycleFailurePublished) return;
        if (pendingDocumentUrl !== undefined) {
          refreshRequested = true;
          return;
        }
        if (refreshRetry !== undefined) {
          refreshRequested = true;
          return;
        }
        if (runtimeInvokes !== 0) {
          refreshRequested = true;
          return;
        }
        refreshInFlight = true;
        refreshRequested = false;
        try {
          await performRefresh();
          refreshRetryAttempt = 0;
          if (refreshRetry !== undefined) {
            clearTimeout(refreshRetry);
            refreshRetry = undefined;
          }
        } catch (error) {
          if (terminalRefreshFailure(error)) publishLifecycleFailure();
          else scheduleRefreshRetry();
        } finally {
          refreshInFlight = false;
          if (refreshRequested) queueMicrotask(() => void runRefresh());
        }
      };
      function requestRefresh(): void {
        if (refreshInFlight || runtimeInvokes !== 0 || pendingDocumentUrl !== undefined ||
          refreshRetry !== undefined) {
          refreshRequested = true;
          return;
        }
        void runRefresh();
      }
      const publishInvalidation = (message: ChromeRuntimeHostMessage) => {
        if (message.type !== "invalidation") return;
        requestRefresh();
      };
      const unsubscribeNative = channel.subscribe((message) => {
        if (message.type === "invalidation") {
          publishInvalidation(message);
          return;
        }
        if (message.type === "update-required") {
          if (released || lifecycleFailurePublished) return;
          lifecycleFailurePublished = true;
          if (keepalive !== undefined) clearInterval(keepalive);
          stopRefreshTimers();
          for (const listener of lifecycleListeners) listener({
            type: "update-required",
            protected: protectedReview,
          });
        }
      });
      const unsubscribeDisconnect = channel.subscribeDisconnect(() => {
        publishLifecycleFailure();
      });

      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        if (keepalive !== undefined) clearInterval(keepalive);
        stopRefreshTimers();
        const requestId = options.createId();
        await channel.request({
          type: "detach",
          lane: "lifecycle",
          requestId,
        }, (message) => message.type === "ack" && message.lane === "lifecycle" &&
          message.requestId === requestId, AbortSignal.timeout(Math.min(RELEASE_TIMEOUT_MS, timeoutMs)),
        Math.min(RELEASE_TIMEOUT_MS, timeoutMs)).catch(() => undefined);
        channel.close();
      };

      const runtimePort: ReviewRuntimeMessagePort = {
        runtimeId: connectionId,
        subscribe(listener) {
          runtimeListeners.add(listener);
          return () => runtimeListeners.delete(listener);
        },
        postMessage(raw) {
          if (!record(raw) || raw.protocol !== REVIEW_RUNTIME_PROTOCOL ||
            raw.version !== REVIEW_RUNTIME_VERSION || raw.runtimeId !== connectionId ||
            typeof raw.requestId !== "string") return;
          if (raw.kind === "cancel") return;
          if (raw.kind !== "request" || !isReviewRuntimeMethodForHost("chrome", raw.method)) return;
          const method = raw.method as ReviewRuntimeMethod;
          if (method === "bootstrap") {
            queueMicrotask(() => emitRuntime(reviewResponse(raw, projection!, true, bootstrap)));
            return;
          }
          if (method === "presence") {
            queueMicrotask(() => emitRuntime(reviewResponse(raw, projection!, true, {})));
            return;
          }
          if (method === "detach") {
            void release().then(() => emitRuntime(reviewResponse(raw, projection!, true, {})));
            return;
          }
          const payload = sanitizeChromeReviewRuntimeRequest(method, raw.payload);
          if (payload === undefined || !active || released || disposed || lifecycleFailurePublished) {
            queueMicrotask(() => emitRuntime(reviewResponse(raw, projection!, false, {})));
            return;
          }
          if (pendingRefreshes > 0) {
            deferredRuntimeRequests.push(raw);
            return;
          }
          const requestId = options.createId();
          const operationFingerprint = NON_IDEMPOTENT.has(method)
            ? canonicalJson([method, payload])
            : undefined;
          const idempotencyKey = operationFingerprint === undefined
            ? undefined
            : operationKeys.get(operationFingerprint) ?? raw.requestId;
          if (operationFingerprint !== undefined) {
            operationKeys.set(operationFingerprint, idempotencyKey!);
            // A missing reply cannot prove that a side effect did not commit.
            protectedReview = true;
          }
          runtimeInvokes += 1;
          void channel.request({
            type: "invoke",
            lane: "runtime",
            requestId,
            generation: Number.isSafeInteger(raw.generation) ? raw.generation as number : projection!.generation,
            revision: Number.isSafeInteger(raw.revision) ? raw.revision as number : projection!.revision,
            method,
            payload,
            ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          }, (message) => message.type === "result" && message.requestId === requestId &&
            message.method === method, undefined,
          method === "chooseFolder" || method === "locateSave"
            ? INTERACTIVE_REQUEST_TIMEOUT_MS
            : timeoutMs).then((result) => {
              if (result.type !== "result") throw new Error("Unexpected native runtime response.");
              const safe = sanitizeChromeReviewRuntimeResponse(method, result.payload);
              if (safe === undefined) throw new Error("Invalid native runtime response.");
              if (operationFingerprint !== undefined) operationKeys.delete(operationFingerprint);
              if (method === "command" && record(safe) && safe.accepted !== false &&
                Number.isSafeInteger(safe.revision)) {
                projection = {
                  ...projection!,
                  state: safe,
                  revision: safe.revision as number,
                };
                bootstrap = { ...bootstrap, state: safe, revision: safe.revision };
                protectedReview = true;
              } else if (method === "finalizeInteraction" && record(safe) &&
                Number.isSafeInteger(safe.reviewRevision)) {
                projection = { ...projection!, revision: safe.reviewRevision as number };
                bootstrap = { ...bootstrap, revision: safe.reviewRevision };
                protectedReview = true;
              } else if (["chooseCopy", "chooseOriginal", "retrySave", "locateSave"].includes(method)) {
                bootstrap = { ...bootstrap, saveStatus: safe };
                protectedReview = true;
              } else if (method === "exportReviewedCopy") {
                protectedReview = true;
              } else if (method === "saveStatus") {
                bootstrap = { ...bootstrap, saveStatus: safe };
              } else if (method === "scope" && record(safe)) {
                bootstrap = { ...bootstrap, scope: safe };
              }
              emitRuntime(reviewResponse(raw, projection!, true, safe));
            }, (error: unknown) => {
              emitRuntime(reviewResponse(raw, projection!, false,
                error instanceof Error && error.message.startsWith("Review changed.") ? { kind: "export-conflict" } : {}));
            }).finally(() => {
              runtimeInvokes = Math.max(0, runtimeInvokes - 1);
              if (runtimeInvokes === 0 && refreshRequested) requestRefresh();
            });
          return;
        },
      };

      return {
        displayName,
        runtimePort,
        get protected() { return protectedReview; },
        confirmDocumentReady,
        reportViewerFailure: publishLifecycleFailure,
        subscribeLifecycle(listener) {
          lifecycleListeners.add(listener);
          return () => lifecycleListeners.delete(listener);
        },
        async activate(activateSignal?: AbortSignal) {
          if (active) return;
          const requestId = options.createId();
          const reply = await channel.request({
            type: "activate",
            lane: "lifecycle",
            requestId,
            documentValidated: true,
          }, (message) => message.type === "active" && message.requestId === requestId, activateSignal);
          if (released || disposed || lifecycleFailurePublished) return;
          if (reply.type !== "active") throw new Error("The service did not activate the review.");
          const next = runtimeProjection(reply.payload);
          const previous = projection!;
          if (next === undefined || next.sessionId !== previous.sessionId ||
            next.generation < previous.generation ||
            (next.generation === previous.generation && next.revision < previous.revision)) {
            throw new NativeRuntimeError("invalid-service-response", "The service returned an invalid active projection.");
          }
          let nextDocumentUrl = documentUrl;
          let createdDocumentUrl: string | undefined;
          const abandonCreatedDocument = () => {
            if (createdDocumentUrl === undefined) return;
            options.revokeObjectURL(createdDocumentUrl);
            createdDocumentUrl = undefined;
          };
          try {
            if (next.generation !== previous.generation || next.document.sha256 !== previous.document.sha256 ||
              next.document.byteLength !== previous.document.byteLength) {
              const bytes = await readProjectedDocument(channel, next, options.createId, maxDocumentBytes, activateSignal);
              if (released || disposed || lifecycleFailurePublished) return;
              try {
                verifyPdfBytes(bytes, next);
              } catch {
                throw new NativeRuntimeError("invalid-service-response", "The active PDF resource was invalid.");
              }
              nextDocumentUrl = options.createObjectURL(new Blob([
                bytes.buffer as ArrayBuffer,
              ], { type: "application/pdf" }));
              createdDocumentUrl = nextDocumentUrl;
              if (released || disposed || lifecycleFailurePublished) {
                abandonCreatedDocument();
                return;
              }
            }
            if (nextDocumentUrl === undefined) {
              throw new NativeRuntimeError("invalid-service-response", "The active PDF resource was unavailable.");
            }
            const nextBootstrap = sanitizeChromeReviewRuntimeResponse("bootstrap", {
              ...next,
              resources: { document: nextDocumentUrl, pdfiumWasm, worker },
            });
            if (!record(nextBootstrap)) {
              throw new NativeRuntimeError("invalid-service-response", "The active review projection was unsafe.");
            }
            if (released || disposed || lifecycleFailurePublished) {
              abandonCreatedDocument();
              return;
            }
            if (nextDocumentUrl !== documentUrl) {
              pendingDocumentUrl = nextDocumentUrl;
              createdDocumentUrl = undefined;
            }
            documentUrl = nextDocumentUrl;
            projection = next;
            bootstrap = nextBootstrap;
          } catch (error) {
            abandonCreatedDocument();
            throw error;
          }
          if (released || disposed || lifecycleFailurePublished) return;
          if (next.protected) protectedReview = true;
          active = true;
          const reason = chromeRuntimeProjectionChangeReason(previous, next);
          if (reason !== undefined) {
            emitRuntime({
              protocol: REVIEW_RUNTIME_PROTOCOL,
              version: REVIEW_RUNTIME_VERSION,
              kind: "event",
              event: "session-invalidated",
              runtimeId: connectionId,
              payload: {
                sessionId: next.sessionId,
                generation: next.generation,
                revision: next.revision,
                reason: reason === "generation" ? "generation"
                  : reason === "revision" ? "revision"
                    : reason === "presence" ? "presence" : "freshness",
                ...(next.generation === previous.generation ? {} : {
                  previousGeneration: previous.generation,
                }),
              },
            });
          }
          keepalive = setInterval(() => {
            if (released) return;
            const id = options.createId();
            void channel.request({
              type: "keepalive",
              lane: "lifecycle",
              requestId: id,
            }, (message) => (message.type === "ack" && message.requestId === id) ||
              message.type === "invalidation").catch((error: unknown) => {
                if (terminalRefreshFailure(error)) publishLifecycleFailure();
                else requestRefresh();
              });
          }, Math.max(1_000, Math.floor(channel.leaseMs / 2)));
          keepalive.unref?.();
          refreshPoll = setInterval(() => requestRefresh(), REFRESH_POLL_MS);
          refreshPoll.unref?.();
        },
        release,
        dispose() {
          if (disposed) return;
          disposed = true;
          unsubscribeNative();
          unsubscribeDisconnect();
          runtimeListeners.clear();
          lifecycleListeners.clear();
          if (keepalive !== undefined) clearInterval(keepalive);
          stopRefreshTimers();
          const resources = new Set([adoptedDocumentUrl, pendingDocumentUrl, documentUrl]);
          for (const resource of resources) {
            if (resource !== undefined) options.revokeObjectURL(resource);
          }
          adoptedDocumentUrl = undefined;
          pendingDocumentUrl = undefined;
          documentUrl = undefined;
          channel.close();
        },
      };
    } catch (error) {
      if (acquisitionStarted) {
        const requestId = options.createId();
        await channel.request({
          type: "cancel",
          lane: "acquisition",
          requestId,
          transferId,
          reason: signal?.aborted === true ? "bypassed" : "handoff-failed",
        }, (message) => message.type === "ack" && message.requestId === requestId).catch(() => undefined);
      }
      if (response?.body !== null && response?.body !== undefined && !response.body.locked) {
        await drain(response.body.getReader());
      }
      if (documentUrl !== undefined) options.revokeObjectURL(documentUrl);
      channel.close();
      throw error;
    }
  };
}
