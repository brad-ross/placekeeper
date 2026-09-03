import {
  isReviewRuntimeMethodForHost,
  sanitizeChromeReviewRuntimeRequest,
  sanitizeChromeReviewRuntimeResponse,
  type ReviewRuntimeBrokerMethod,
} from "./review-runtime-protocol.js";

export const CHROME_RUNTIME_PROTOCOL = "placekeeper.chrome-runtime" as const;
export const CHROME_RUNTIME_PROTOCOL_VERSION = 2 as const;
export const CHROME_RUNTIME_RESOURCE_CHUNK_BYTES = 192 * 1024;

const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const OPERATION_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const FORBIDDEN_HOST_KEY = /(?:authorization|bindProof|capability|credential|headers|originalUrl|presentationId|sourceRoot|sourceUrl|syncTex|taskId)/iu;

export type ChromeRuntimeLane = "acquisition" | "runtime" | "resource" | "lifecycle";

interface RuntimeEnvelope {
  readonly protocolVersion: 2;
  readonly connectionId: string;
}

export interface ChromeRuntimeHello extends RuntimeEnvelope {
  readonly type: "hello";
  readonly protocol: typeof CHROME_RUNTIME_PROTOCOL;
}

export type ChromeRuntimeExtensionMessage = ChromeRuntimeHello | (RuntimeEnvelope & (
  | { readonly lane: "acquisition"; readonly type: "begin"; readonly requestId: string; readonly transferId: string; readonly disposition: "remote-temporary"; readonly sourceUrl: string; readonly displayName?: string }
  | { readonly lane: "acquisition"; readonly type: "begin"; readonly requestId: string; readonly transferId: string; readonly disposition: "local"; readonly fileUrl: string }
  | { readonly lane: "acquisition"; readonly type: "chunk"; readonly requestId: string; readonly transferId: string; readonly sequence: number; readonly data: string }
  | { readonly lane: "acquisition"; readonly type: "finish"; readonly requestId: string; readonly transferId: string; readonly sequence: number }
  | { readonly lane: "acquisition"; readonly type: "cancel"; readonly requestId: string; readonly transferId: string; readonly reason: string }
  | { readonly lane: "runtime"; readonly type: "invoke"; readonly requestId: string; readonly generation: number; readonly revision: number; readonly method: ReviewRuntimeBrokerMethod; readonly payload: unknown; readonly idempotencyKey?: string }
  | { readonly lane: "resource"; readonly type: "read"; readonly requestId: string; readonly resource: "document"; readonly generation: number; readonly offset: number; readonly length: number }
  | { readonly lane: "resource"; readonly type: "ack"; readonly requestId: string; readonly sequence: number }
  | { readonly lane: "resource"; readonly type: "cancel"; readonly requestId: string }
  | { readonly lane: "lifecycle"; readonly type: "activate"; readonly requestId: string; readonly documentValidated: true }
  | { readonly lane: "lifecycle"; readonly type: "refresh"; readonly requestId: string }
  | { readonly lane: "lifecycle"; readonly type: "recover"; readonly requestId: string; readonly decision: "resume" | "discard" | "fork"; readonly offer: { readonly id: string; readonly expiresAt: string }; readonly idempotencyKey: string }
  | { readonly lane: "lifecycle"; readonly type: "keepalive"; readonly requestId: string }
  | { readonly lane: "lifecycle"; readonly type: "detach"; readonly requestId: string }
));

export type ChromeRuntimeHostMessage = RuntimeEnvelope & (
  | { readonly type: "hello-ack"; readonly protocol: typeof CHROME_RUNTIME_PROTOCOL; readonly leaseMs: number }
  | { readonly lane: ChromeRuntimeLane; readonly type: "ack"; readonly requestId: string; readonly sequence?: number }
  | { readonly lane: "lifecycle"; readonly type: "projection"; readonly requestId: string; readonly payload: unknown }
  | { readonly lane: "lifecycle"; readonly type: "active"; readonly requestId: string; readonly payload: unknown }
  | { readonly lane: "lifecycle"; readonly type: "recovery-offered"; readonly requestId: string; readonly choices: readonly ["resume", "discard", "fork"]; readonly offer: { readonly id: string; readonly expiresAt: string } }
  | { readonly lane: "runtime"; readonly type: "result"; readonly requestId: string; readonly method: ReviewRuntimeBrokerMethod; readonly payload: unknown }
  | { readonly lane: "runtime"; readonly type: "invalidation"; readonly revision: number; readonly generation: number; readonly reason: "revision" | "generation" | "save" | "recovery" }
  | { readonly lane: "resource"; readonly type: "resource-chunk"; readonly requestId: string; readonly sequence: number; readonly data: string; readonly done: boolean }
  | { readonly lane: ChromeRuntimeLane; readonly type: "failure"; readonly requestId?: string; readonly reason: string }
  | { readonly lane: "lifecycle"; readonly type: "update-required"; readonly requestId?: string }
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validEnvelope(value: Record<string, unknown>): boolean {
  return value.protocolVersion === CHROME_RUNTIME_PROTOCOL_VERSION && safeId(value.connectionId);
}

function safeHttpSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16_384) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" &&
      url.password === "" && url.href === value;
  } catch { return false; }
}

function safeFileSource(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 16_384) return false;
  try {
    const url = new URL(value);
    return url.protocol === "file:" && url.hostname === "" && url.username === "" &&
      url.password === "" && url.search === "" && url.hash === "";
  } catch { return false; }
}

export function parseChromeRuntimeExtensionMessage(value: unknown): ChromeRuntimeExtensionMessage | undefined {
  if (!record(value) || !validEnvelope(value) || typeof value.type !== "string") return undefined;
  if (value.type === "hello") {
    return exact(value, ["type", "protocol", "protocolVersion", "connectionId"]) &&
      value.protocol === CHROME_RUNTIME_PROTOCOL ? value as unknown as ChromeRuntimeHello : undefined;
  }
  if (typeof value.lane !== "string" || !safeId(value.requestId)) return undefined;
  const base = ["type", "lane", "protocolVersion", "connectionId", "requestId"];
  if (value.lane === "acquisition" && value.type === "begin" && safeId(value.transferId)) {
    if (value.disposition === "remote-temporary") {
      const keys = value.displayName === undefined
        ? [...base, "transferId", "disposition", "sourceUrl"]
        : [...base, "transferId", "disposition", "sourceUrl", "displayName"];
      if (!exact(value, keys) || !safeHttpSource(value.sourceUrl) ||
        (value.displayName !== undefined && (typeof value.displayName !== "string" || value.displayName.length < 1 || value.displayName.length > 120))) return undefined;
      return value as unknown as ChromeRuntimeExtensionMessage;
    }
    if (value.disposition === "local" && exact(value, [...base, "transferId", "disposition", "fileUrl"]) && safeFileSource(value.fileUrl)) {
      return value as unknown as ChromeRuntimeExtensionMessage;
    }
    return undefined;
  }
  if (value.lane === "acquisition" && value.type === "chunk") {
    return exact(value, [...base, "transferId", "sequence", "data"]) && safeId(value.transferId) &&
      safeInteger(value.sequence) && typeof value.data === "string" && value.data.length <= 350_000 &&
      BASE64.test(value.data) ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "acquisition" && value.type === "finish") {
    return exact(value, [...base, "transferId", "sequence"]) && safeId(value.transferId) && safeInteger(value.sequence)
      ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "acquisition" && value.type === "cancel") {
    return exact(value, [...base, "transferId", "reason"]) && safeId(value.transferId) &&
      typeof value.reason === "string" && /^[a-z0-9-]{1,64}$/u.test(value.reason)
      ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "runtime" && value.type === "invoke") {
    const keys = value.idempotencyKey === undefined
      ? [...base, "generation", "revision", "method", "payload"]
      : [...base, "generation", "revision", "method", "payload", "idempotencyKey"];
    if (!exact(value, keys) || !isReviewRuntimeMethodForHost("chrome", value.method) ||
      value.method === "bootstrap" || value.method === "presence" || value.method === "detach" ||
      !safeInteger(value.generation) || !safeInteger(value.revision) ||
      (value.idempotencyKey !== undefined && (typeof value.idempotencyKey !== "string" || !OPERATION_KEY.test(value.idempotencyKey)))) return undefined;
    const payload = sanitizeChromeReviewRuntimeRequest(value.method, value.payload);
    return payload === undefined
      ? undefined
      : { ...value, payload } as unknown as ChromeRuntimeExtensionMessage;
  }
  if (value.lane === "resource" && value.type === "read") {
    return exact(value, [...base, "resource", "generation", "offset", "length"]) && value.resource === "document" &&
      safeInteger(value.generation) && (value.generation as number) > 0 && safeInteger(value.offset) &&
      safeInteger(value.length) && (value.length as number) > 0 && (value.length as number) <= CHROME_RUNTIME_RESOURCE_CHUNK_BYTES
      ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "resource" && value.type === "ack") {
    return exact(value, [...base, "sequence"]) && safeInteger(value.sequence) ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "resource" && value.type === "cancel") {
    return exact(value, base) ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "lifecycle" && value.type === "activate") {
    return exact(value, [...base, "documentValidated"]) && value.documentValidated === true
      ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "lifecycle" && value.type === "recover") {
    return exact(value, [...base, "decision", "offer", "idempotencyKey"]) &&
      (value.decision === "resume" || value.decision === "discard" || value.decision === "fork") &&
      record(value.offer) && exact(value.offer, ["id", "expiresAt"]) &&
      typeof value.offer.id === "string" && OPERATION_KEY.test(value.offer.id) &&
      typeof value.offer.expiresAt === "string" && Number.isFinite(Date.parse(value.offer.expiresAt)) &&
      typeof value.idempotencyKey === "string" && OPERATION_KEY.test(value.idempotencyKey)
      ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  if (value.lane === "lifecycle" && (value.type === "refresh" || value.type === "keepalive" || value.type === "detach")) {
    return exact(value, base) ? value as unknown as ChromeRuntimeExtensionMessage : undefined;
  }
  return undefined;
}

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item, depth + 1));
  if (!record(value)) return false;
  return Object.entries(value).some(([key, item]) => FORBIDDEN_HOST_KEY.test(key) || containsForbiddenKey(item, depth + 1));
}

/** Validates the service-owned portion of a Chrome bootstrap. Resource URLs
 * are deliberately absent here: the handler adds its digest-bound Blob and
 * exact packaged worker/WASM URLs before invoking the U2 bootstrap sanitizer. */
export function sanitizeChromeRuntimeProjection(value: unknown): unknown | undefined {
  if (!record(value) || !exact(value, [
    "sessionId", "generation", "revision", "state", "scope", "saveStatus",
    "canonicalLinkBase", "protected", "location", "document",
  ].filter((key) => key !== "location" || value.location !== undefined)) ||
    !record(value.document) ||
    !exact(value.document, ["sha256", "byteLength", "generation"]) ||
    typeof value.protected !== "boolean" ||
    !SHA256.test(String(value.document.sha256)) || !safeInteger(value.document.byteLength) ||
    (value.document.byteLength as number) < 1 || !safeInteger(value.document.generation) ||
    value.document.generation !== value.generation) return undefined;
  const projected = sanitizeChromeReviewRuntimeResponse("bootstrap", {
    ...value,
    resources: { document: "blob:handler-issued", pdfiumWasm: "chrome-extension://packaged/pdfium.wasm", worker: "chrome-extension://packaged/pdfium-worker.js" },
  });
  if (!record(projected)) return undefined;
  const { resources: _resources, ...safe } = projected;
  if (containsForbiddenKey(safe)) return undefined;
  return { ...safe, document: { ...value.document } };
}

export function parseChromeRuntimeHostMessage(value: unknown): ChromeRuntimeHostMessage | undefined {
  if (!record(value) || !validEnvelope(value) || typeof value.type !== "string" || containsForbiddenKey(value)) return undefined;
  if (value.type === "hello-ack") {
    return exact(value, ["type", "protocol", "protocolVersion", "connectionId", "leaseMs"]) &&
      value.protocol === CHROME_RUNTIME_PROTOCOL && safeInteger(value.leaseMs) && (value.leaseMs as number) >= 1_000
      ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  if (typeof value.lane !== "string") return undefined;
  if (value.type === "failure") {
    const keys = value.requestId === undefined
      ? ["type", "lane", "protocolVersion", "connectionId", "reason"]
      : ["type", "lane", "protocolVersion", "connectionId", "requestId", "reason"];
    return exact(value, keys) && (value.requestId === undefined || safeId(value.requestId)) &&
      typeof value.reason === "string" && /^[a-z0-9-]{1,64}$/u.test(value.reason)
      ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  if (value.type === "update-required") {
    const keys = value.requestId === undefined
      ? ["type", "lane", "protocolVersion", "connectionId"]
      : ["type", "lane", "protocolVersion", "connectionId", "requestId"];
    return value.lane === "lifecycle" && exact(value, keys) && (value.requestId === undefined || safeId(value.requestId))
      ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  if (value.type === "resource-chunk") {
    return value.lane === "resource" && exact(value, ["type", "lane", "protocolVersion", "connectionId", "requestId", "sequence", "data", "done"]) &&
      safeId(value.requestId) && safeInteger(value.sequence) && typeof value.data === "string" &&
      value.data.length <= 350_000 && BASE64.test(value.data) && typeof value.done === "boolean"
      ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  if (value.type === "ack") {
    const keys = value.sequence === undefined
      ? ["type", "lane", "protocolVersion", "connectionId", "requestId"]
      : ["type", "lane", "protocolVersion", "connectionId", "requestId", "sequence"];
    return exact(value, keys) && safeId(value.requestId) &&
      (value.sequence === undefined || safeInteger(value.sequence)) ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  if (value.type === "projection" || value.type === "active") {
    if (value.lane !== "lifecycle" || !exact(value, ["type", "lane", "protocolVersion", "connectionId", "requestId", "payload"]) || !safeId(value.requestId)) return undefined;
    const payload = sanitizeChromeRuntimeProjection(value.payload);
    return payload === undefined
      ? undefined : { ...value, payload } as unknown as ChromeRuntimeHostMessage;
  }
  if (value.type === "recovery-offered") {
    return value.lane === "lifecycle" &&
      exact(value, ["type", "lane", "protocolVersion", "connectionId", "requestId", "choices", "offer"]) &&
      safeId(value.requestId) && Array.isArray(value.choices) && value.choices.length === 3 &&
      value.choices[0] === "resume" && value.choices[1] === "discard" && value.choices[2] === "fork" &&
      record(value.offer) && exact(value.offer, ["id", "expiresAt"]) &&
      typeof value.offer.id === "string" && OPERATION_KEY.test(value.offer.id) &&
      typeof value.offer.expiresAt === "string" && Number.isFinite(Date.parse(value.offer.expiresAt))
      ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  if (value.type === "result") {
    if (value.lane !== "runtime" || !exact(value, ["type", "lane", "protocolVersion", "connectionId", "requestId", "method", "payload"]) ||
      !safeId(value.requestId) || !isReviewRuntimeMethodForHost("chrome", value.method) || value.method === "bootstrap") return undefined;
    const payload = sanitizeChromeReviewRuntimeResponse(value.method, value.payload);
    return payload === undefined
      ? undefined : { ...value, payload } as unknown as ChromeRuntimeHostMessage;
  }
  if (value.type === "invalidation") {
    return value.lane === "runtime" && exact(value, ["type", "lane", "protocolVersion", "connectionId", "revision", "generation", "reason"]) &&
      safeInteger(value.revision) && safeInteger(value.generation) && ["revision", "generation", "save", "recovery"].includes(String(value.reason))
      ? value as unknown as ChromeRuntimeHostMessage : undefined;
  }
  return undefined;
}
