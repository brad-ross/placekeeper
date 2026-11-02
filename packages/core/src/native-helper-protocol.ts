import {
  decodePlacekeeperLink,
  encodePlacekeeperLinkFragment,
  PLACEKEEPER_LINK_MAX_LENGTH,
  type PlacekeeperLinkLocation,
} from "./placekeeper-link.js";
import {
  isReviewRuntimeMethodForHost,
  sanitizeNativeReviewRuntimeRequest,
  sanitizeNativeReviewRuntimeResponse,
  type ReviewRuntimeBrokerMethod,
  type NativeRuntimeHost,
} from "./review-runtime-protocol.js";

export const NATIVE_HELPER_PROTOCOL_VERSION = 1 as const;
export const NATIVE_HELPER_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const NATIVE_HELPER_MAX_STREAM_BYTES = 16 * 1024 * 1024;
export const NATIVE_HELPER_RESOURCE_CHUNK_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface ReviewEnvelope {
  readonly protocolVersion: 1;
  readonly windowId: string;
  readonly attemptId: string;
  readonly requestId: string;
}

export interface NativeRuntimeProjection {
  readonly sessionId: string;
  readonly generation: number;
  readonly revision: number;
  readonly state: unknown;
  readonly scope: unknown;
  readonly saveStatus: unknown;
  readonly activeAuthoringDraftIds: readonly string[];
  readonly protected: boolean;
  readonly location?: unknown;
  readonly document: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly generation: number;
  };
}

export type NativeReviewHelperMessage = ReviewEnvelope & (
  | { readonly type: "admit"; readonly sourcePath: string }
  | { readonly type: "admit-link"; readonly link: string; readonly confirmed: true }
  | { readonly type: "activate"; readonly documentValidated: true }
  | { readonly type: "refresh" }
  | { readonly type: "keepalive" }
  | {
      readonly type: "recover";
      readonly decision: "resume" | "discard" | "fork";
      readonly offer: { readonly id: string; readonly expiresAt: string };
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "invoke";
      readonly generation: number;
      readonly revision: number;
      readonly method: ReviewRuntimeBrokerMethod;
      readonly payload: unknown;
      readonly idempotencyKey?: string;
    }
  | {
      readonly type: "read-resource";
      readonly resourceId: string;
      readonly generation: number;
      readonly role: "document";
      readonly offset: number;
      readonly length: number;
    }
  | {
      readonly type: "adopt-resource";
      readonly resourceId: string;
      readonly generation: number;
      readonly byteLength: number;
      readonly digest: string;
    }
  | { readonly type: "copy-link"; readonly location: PlacekeeperLinkLocation }
  | { readonly type: "release" }
);

export type NativeReviewHelperResponse = ReviewEnvelope & (
  | {
      readonly type: "admitted";
      readonly provisionalId: string;
      readonly resourceId: string;
      readonly generation: number;
      readonly byteLength: number;
      readonly digest: string;
      readonly displayName: string;
      readonly projection: NativeRuntimeProjection;
    }
  | { readonly type: "active" | "refreshed"; readonly projection: NativeRuntimeProjection }
  | {
      readonly type: "recovery-offered";
      readonly choices: readonly ["resume", "discard", "fork"];
      readonly offer: { readonly id: string; readonly expiresAt: string };
    }
  | {
      readonly type: "invalidation";
      readonly generation: number;
      readonly revision: number;
      readonly reason: "revision" | "generation" | "save" | "recovery" | "presence";
    }
  | { readonly type: "result"; readonly method: ReviewRuntimeBrokerMethod; readonly payload: unknown }
  | { readonly type: "resource-bytes"; readonly sequence: number; readonly data: string; readonly done: boolean }
  | { readonly type: "resource-adopted"; readonly generation: number }
  | { readonly type: "placekeeper-link"; readonly link: string }
  | { readonly type: "released" }
  | { readonly type: "failure"; readonly code: "invalid" | "stale" | "unavailable" | "budget" | "recovery" }
);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function reviewEnvelope(value: Record<string, unknown>): boolean {
  return value.protocolVersion === NATIVE_HELPER_PROTOCOL_VERSION && id(value.windowId)
    && id(value.attemptId) && id(value.requestId);
}

function safeLocation(value: unknown): value is PlacekeeperLinkLocation {
  try {
    encodePlacekeeperLinkFragment(value as PlacekeeperLinkLocation);
    return record(value) && !Object.keys(value).some((key) => !["kind", "page", "itemId", "mode", "params"].includes(key));
  } catch {
    return false;
  }
}

export function parseNativeReviewHelperMessage(host: NativeRuntimeHost, value: unknown): NativeReviewHelperMessage | undefined {
  if (!record(value) || !reviewEnvelope(value)) return undefined;
  const base = ["protocolVersion", "windowId", "attemptId", "requestId", "type"];
  if (value.type === "admit") {
    return exact(value, [...base, "sourcePath"]) && typeof value.sourcePath === "string"
      && (value.sourcePath.startsWith("/") || (host === "electron" && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u.test(value.sourcePath))) && value.sourcePath.length <= 16_384 && !value.sourcePath.includes("\0")
      ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  if (value.type === "admit-link") {
    if (!exact(value, [...base, "link", "confirmed"]) || value.confirmed !== true
      || typeof value.link !== "string" || value.link.length > PLACEKEEPER_LINK_MAX_LENGTH) return undefined;
    try {
      decodePlacekeeperLink(value.link);
      return value as unknown as NativeReviewHelperMessage;
    } catch {
      return undefined;
    }
  }
  if (value.type === "activate") {
    return exact(value, [...base, "documentValidated"]) && value.documentValidated === true
      ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  if (value.type === "refresh" || value.type === "keepalive" || value.type === "release") {
    return exact(value, base) ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  if (value.type === "recover") {
    return exact(value, [...base, "decision", "offer", "idempotencyKey"])
      && (value.decision === "resume" || value.decision === "discard" || value.decision === "fork")
      && record(value.offer) && exact(value.offer, ["id", "expiresAt"])
      && typeof value.offer.id === "string" && OPERATION_ID.test(value.offer.id)
      && typeof value.offer.expiresAt === "string" && Number.isFinite(Date.parse(value.offer.expiresAt))
      && typeof value.idempotencyKey === "string" && OPERATION_ID.test(value.idempotencyKey)
      ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  if (value.type === "invoke") {
    const keys = value.idempotencyKey === undefined
      ? [...base, "generation", "revision", "method", "payload"]
      : [...base, "generation", "revision", "method", "payload", "idempotencyKey"];
    if (!exact(value, keys) || !isReviewRuntimeMethodForHost(host, value.method)
      || value.method === "bootstrap" || value.method === "presence" || value.method === "detach"
      || !integer(value.generation) || value.generation < 1 || !integer(value.revision)
      || (value.idempotencyKey !== undefined
        && (typeof value.idempotencyKey !== "string" || !OPERATION_ID.test(value.idempotencyKey)))) return undefined;
    const payload = sanitizeNativeReviewRuntimeRequest(host, value.method, value.payload);
    return payload === undefined ? undefined : { ...value, payload } as unknown as NativeReviewHelperMessage;
  }
  if (value.type === "read-resource") {
    return exact(value, [...base, "resourceId", "generation", "role", "offset", "length"])
      && id(value.resourceId) && integer(value.generation) && value.generation > 0
      && value.role === "document" && integer(value.offset, 512 * 1024 * 1024)
      && integer(value.length, NATIVE_HELPER_RESOURCE_CHUNK_BYTES) && value.length > 0
      ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  if (value.type === "adopt-resource") {
    return exact(value, [...base, "resourceId", "generation", "byteLength", "digest"])
      && id(value.resourceId) && integer(value.generation) && value.generation > 0
      && integer(value.byteLength, 512 * 1024 * 1024) && value.byteLength >= 5
      && typeof value.digest === "string" && SHA256.test(value.digest)
      ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  if (value.type === "copy-link") {
    return exact(value, [...base, "location"]) && safeLocation(value.location)
      ? value as unknown as NativeReviewHelperMessage : undefined;
  }
  return undefined;
}

export function sanitizeNativeRuntimeProjection(host: NativeRuntimeHost, value: unknown): NativeRuntimeProjection | undefined {
  if (!record(value) || !record(value.document) || !exact(value.document, ["sha256", "byteLength", "generation"])
    || typeof value.document.sha256 !== "string" || !SHA256.test(value.document.sha256)
    || !integer(value.document.byteLength, 512 * 1024 * 1024) || value.document.byteLength < 5
    || !integer(value.document.generation) || value.document.generation < 1
    || value.document.generation !== value.generation || typeof value.protected !== "boolean") return undefined;
  const projected = sanitizeNativeReviewRuntimeResponse(host, "bootstrap", {
    ...value,
    resources: {
      document: "placekeeper-resource://document/host-issued",
      pdfiumWasm: "placekeeper-app://bundle/assets/pdfium.wasm",
      worker: "placekeeper-app://bundle/assets/pdfium-worker.js",
    },
  });
  if (!record(projected)) return undefined;
  const { resources: _resources, ...safe } = projected;
  return { ...safe, document: { ...value.document } } as unknown as NativeRuntimeProjection;
}

export function encodeNativeHelperFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength === 0 || body.byteLength > NATIVE_HELPER_MAX_FRAME_BYTES) {
    throw new Error("Native helper frame is too large");
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeNativeHelperFrame(frame: Uint8Array): unknown {
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.byteLength < 4) throw new Error("Native helper frame length is missing");
  const length = bytes.readUInt32BE(0);
  if (length > NATIVE_HELPER_MAX_FRAME_BYTES) throw new Error("Native helper frame is too large");
  if (length === 0 || bytes.byteLength !== length + 4) throw new Error("Native helper frame length is invalid");
  return JSON.parse(bytes.subarray(4).toString("utf8")) as unknown;
}

export function validNativeReviewHelperResponse(host: NativeRuntimeHost, value: unknown): value is NativeReviewHelperResponse {
  if (!record(value) || !reviewEnvelope(value)) return false;
  const base = ["protocolVersion", "windowId", "attemptId", "requestId", "type"];
  if (value.type === "admitted") {
    return exact(value, [
      ...base, "provisionalId", "resourceId", "generation", "byteLength", "digest", "displayName", "projection",
    ]) && id(value.provisionalId) && id(value.resourceId) && integer(value.generation) && value.generation > 0
      && integer(value.byteLength, 512 * 1024 * 1024) && value.byteLength >= 5
      && typeof value.digest === "string" && SHA256.test(value.digest)
      && typeof value.displayName === "string" && value.displayName.length > 0 && value.displayName.length <= 255
      && sanitizeNativeRuntimeProjection(host, value.projection) !== undefined;
  }
  if (value.type === "active" || value.type === "refreshed") {
    return exact(value, [...base, "projection"]) && sanitizeNativeRuntimeProjection(host, value.projection) !== undefined;
  }
  if (value.type === "recovery-offered") {
    return exact(value, [...base, "choices", "offer"])
      && Array.isArray(value.choices) && value.choices.length === 3
      && value.choices[0] === "resume" && value.choices[1] === "discard" && value.choices[2] === "fork"
      && record(value.offer) && exact(value.offer, ["id", "expiresAt"])
      && typeof value.offer.id === "string" && OPERATION_ID.test(value.offer.id)
      && typeof value.offer.expiresAt === "string" && Number.isFinite(Date.parse(value.offer.expiresAt));
  }
  if (value.type === "invalidation") {
    return exact(value, [...base, "generation", "revision", "reason"])
      && integer(value.generation) && value.generation > 0 && integer(value.revision)
      && ["revision", "generation", "save", "recovery", "presence"].includes(String(value.reason));
  }
  if (value.type === "result") {
    return exact(value, [...base, "method", "payload"])
      && isReviewRuntimeMethodForHost(host, value.method)
      && value.method !== "bootstrap" && value.method !== "presence" && value.method !== "detach"
      && sanitizeNativeReviewRuntimeResponse(host, value.method, value.payload) !== undefined;
  }
  if (value.type === "resource-bytes") {
    return exact(value, [...base, "sequence", "data", "done"]) && integer(value.sequence)
      && typeof value.data === "string" && value.data.length <= NATIVE_HELPER_RESOURCE_CHUNK_BYTES * 2
      && BASE64.test(value.data) && typeof value.done === "boolean";
  }
  if (value.type === "resource-adopted") {
    return exact(value, [...base, "generation"]) && integer(value.generation) && value.generation > 0;
  }
  if (value.type === "placekeeper-link") {
    if (!exact(value, [...base, "link"]) || typeof value.link !== "string") return false;
    try { decodePlacekeeperLink(value.link); return true; } catch { return false; }
  }
  if (value.type === "failure") {
    return exact(value, [...base, "code"])
      && ["invalid", "stale", "unavailable", "budget", "recovery"].includes(String(value.code));
  }
  return value.type === "released" && exact(value, base);
}
