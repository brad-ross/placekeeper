import { encodePlacekeeperLinkFragment, decodePlacekeeperLinkFragment, type PlacekeeperLinkLocation } from "./placekeeper-link.js";
import { isReviewRuntimeMethodForHost, sanitizeChromeReviewRuntimeRequest, type ReviewRuntimeMethod, } from "./review-runtime-protocol.js";
export const CODEX_MCP_PROTOCOL = "placekeeper.codex-mcp" as const;
export const CODEX_MCP_PROTOCOL_VERSION = 1 as const;
export const CODEX_DISPLAY_TOOL = "mcp__placekeeper__display_review" as const;
export const CODEX_REVIEW_UI_RESOURCE = "ui://placekeeper/review-v1.html" as const;
export const CODEX_RESOURCE_CHUNK_BYTES = 256 * 1024;
export const CODEX_MAX_ENCODED_RESPONSE_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;
const REVIEW_ID = /^[A-Za-z0-9_-]{1,256}$/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closed(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function id(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function isCodexCapability(value: unknown): value is string {
  return typeof value === "string" && SECRET.test(value);
}

function generation(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function expiry(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
}

/** Service-minted launch material. It grants staging only; task identity comes from the hook. */
export interface CodexNativeLaunchSuccess {
  readonly ok: true;
  readonly kind: "opened" | "focused";
  readonly surface: "codex-native";
  readonly sessionId: string;
  readonly documentGeneration: number;
  readonly bindProof: string;
  readonly handoff: {
    readonly token: string;
    readonly expiresAt: string;
  };
}

export function parseCodexNativeLaunchSuccess(value: unknown): CodexNativeLaunchSuccess | undefined {
  if (!record(value) ||
    !closed(value, ["ok", "kind", "surface", "sessionId", "documentGeneration", "bindProof", "handoff"]) ||
    value.ok !== true ||
    (value.kind !== "opened" &&
      value.kind !== "focused") ||
    value.surface !== "codex-native" ||
    typeof value.sessionId !== "string" ||
    !REVIEW_ID.test(value.sessionId) ||
    !generation(value.documentGeneration) ||
    !isCodexCapability(value.bindProof) ||
    !record(value.handoff) ||
    !closed(value.handoff, ["token", "expiresAt"]) ||
    !isCodexCapability(value.handoff.token) ||
    !expiry(value.handoff.expiresAt)) {
    return undefined;
  }
  return {
    ok: true,
    kind: value.kind,
    surface: "codex-native",
    sessionId: value.sessionId,
    documentGeneration: value.documentGeneration,
    bindProof: value.bindProof,
    handoff: { token: value.handoff.token, expiresAt: value.handoff.expiresAt },
  };
}

export interface CodexDisplayRequest {
  readonly handoff: string;
}

export function parseCodexDisplayRequest(value: unknown): CodexDisplayRequest | undefined {
  return record(value) && closed(value, ["handoff"]) && isCodexCapability(value.handoff) ? { handoff: value.handoff } : undefined;
}

/** Correlation only: never usable as a resource, readiness or mutation capability. */
export interface CodexDisplayReceipt {
  readonly protocolVersion: 1;
  readonly status: "pending";
  readonly receiptId: string;
  readonly attemptId: string;
  readonly generation: number;
}

export function parseCodexDisplayReceipt(value: unknown): CodexDisplayReceipt | undefined {
  return record(value) &&
    closed(value, ["protocolVersion", "status", "receiptId", "attemptId", "generation"]) &&
    value.protocolVersion === 1 &&
    value.status === "pending" &&
    id(value.receiptId) &&
    id(value.attemptId) &&
    generation(value.generation)
    ? {
        protocolVersion: 1,
        status: "pending",
        receiptId: value.receiptId,
        attemptId: value.attemptId,
        generation: value.generation,
      }
    : undefined;
}

/** Only this per-invocation private _meta value may initialize the cached UI shell. */
export interface CodexPendingPresentation {
  readonly protocolVersion: 1;
  readonly runtimeId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly receiptId: string;
  readonly pendingCapability: string;
}

export function parseCodexPendingPresentation(value: unknown): CodexPendingPresentation | undefined {
  if (!record(value) ||
    !closed(value, ["protocolVersion", "runtimeId", "attemptId", "generation", "receiptId", "pendingCapability"]) ||
    value.protocolVersion !== 1 ||
    !id(value.runtimeId) ||
    !id(value.attemptId) ||
    !id(value.receiptId) ||
    !generation(value.generation) ||
    !isCodexCapability(value.pendingCapability)) {
    return undefined;
  }
  return {
    protocolVersion: 1,
    runtimeId: value.runtimeId,
    attemptId: value.attemptId,
    generation: value.generation,
    receiptId: value.receiptId,
    pendingCapability: value.pendingCapability
  };
}
interface AppEnvelope {
  readonly protocolVersion: 1;
  readonly runtimeId: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly generation: number;
  readonly capability: string;
}

export type CodexAppRequest = AppEnvelope & ({
  readonly authority: "pending";
  readonly method: "ready" | "status";
  readonly payload: Record<string, never>;
} | {
  readonly authority: "presentation";
  readonly method: ReviewRuntimeMethod | "resource" | "watermark" | "renew" | "createLink";
  readonly payload: unknown;
} | {
  readonly authority: "reconnect";
  readonly method: "reconnect";
  readonly payload: Record<string, never>;
});
export function parseCodexAppRequest(value: unknown): CodexAppRequest | undefined {
  if (!record(value) ||
    !closed(value, ["protocolVersion", "runtimeId", "attemptId", "requestId", "generation", "capability", "authority", "method", "payload"]) ||
    value.protocolVersion !== 1 ||
    !id(value.runtimeId) ||
    !id(value.attemptId) ||
    !id(value.requestId) ||
    !generation(value.generation) ||
    !isCodexCapability(value.capability) ||
    !record(value.payload)) {
    return undefined;
  }
  const envelope: AppEnvelope = {
    protocolVersion: 1,
    runtimeId: value.runtimeId,
    attemptId: value.attemptId,
    requestId: value.requestId,
    generation: value.generation,
    capability: value.capability,
  };
  if (value.authority === "pending" &&
    (value.method === "ready" ||
      value.method === "status") &&
    Object.keys(value.payload).length === 0)
    return { ...envelope, authority: "pending", method: value.method, payload: {} };
  if (value.authority === "reconnect" &&
    value.method === "reconnect" &&
    Object.keys(value.payload).length === 0)
    return { ...envelope, authority: "reconnect", method: "reconnect", payload: {} };
  if (value.authority !== "presentation") {
    return undefined;
  }
  if ((value.method === "watermark" || value.method === "renew") &&
    Object.keys(value.payload).length === 0)
    return { ...envelope, authority: "presentation", method: value.method, payload: {} };
  if (value.method === "createLink") {
    const location = value.payload.location;
    if (!closed(value.payload, ["location"]) || !record(location) ||
      !closed(location, location.kind === "item" ? ["kind", "page", "itemId"] : location.kind === "destination" ? ["kind", "page", "mode", "params"] : ["kind", "page"]) ||
      !["page", "item", "destination"].includes(String(location.kind))) return undefined;
    try {
      const parsed = decodePlacekeeperLinkFragment(encodePlacekeeperLinkFragment(location as unknown as PlacekeeperLinkLocation));
      return { ...envelope, authority: "presentation", method: "createLink", payload: { location: parsed } };
    } catch { return undefined; }
  }
  if (value.method === "resource") {
    const p = value.payload;
    if (!closed(p, ["handle", "offset", "length"]) ||
      !id(p.handle) ||
      !Number.isSafeInteger(p.offset) ||
      (p.offset as number) < 0 ||
      !Number.isSafeInteger(p.length) ||
      (p.length as number) < 1 ||
      (p.length as number) > CODEX_RESOURCE_CHUNK_BYTES) {
      return undefined;
    }
    return {
      ...envelope,
      authority: "presentation",
      method: "resource",
      payload: { handle: p.handle, offset: p.offset, length: p.length },
    };
  }
  if (!isReviewRuntimeMethodForHost("codex", value.method)) {
    return undefined;
  }
  const payload = sanitizeChromeReviewRuntimeRequest(value.method, value.payload);
  return payload === undefined ? undefined : { ...envelope, authority: "presentation", method: value.method, payload };
}

export type CodexAdmissionFailure =
  | "invalid"
  | "expired"
  | "replayed"
  | "owner-mismatch"
  | "stale-generation"
  | "revoked"
  | "unavailable";
/** Interactive native pickers have a five-minute process budget. Transport
 * deadlines include bounded completion slack; ordinary requests keep defaults. */
export function codexPickerTimeouts(request: CodexAppRequest): { socketMs: number; sdkMs: number } | undefined {
  return request.authority === "presentation" && (request.method === "chooseFolder" || request.method === "locateSave")
    ? { socketMs: 310_000, sdkMs: 315_000 } : undefined;
}

/** Closed operation outcome, never an arbitrary service exception message. */
export class NativeOperationError extends Error {
  readonly reason = "export-conflict" as const;
  constructor() { super("native-export-conflict"); this.name = "NativeOperationError"; }
}

export type CodexAppResponse = {
  readonly status: "pending";
} | {
  readonly status: "active";
  readonly presentationCapability: string;
  readonly reconnectTicket: string;
  readonly runtimeId: string;
  readonly attemptId: string;
  readonly generation: number;
} | {
  readonly status: "ok";
  readonly payload: unknown;
} | {
  readonly status: "operation-error";
  readonly reason: "export-conflict";
} | {
  readonly status: "denied";
  readonly reason: CodexAdmissionFailure;
};
export interface CodexResourceDescriptor {
  readonly handle: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: "application/pdf" | "application/wasm" | "text/javascript";
}

export function parseCodexResourceChunk(value: unknown): {
  readonly offset: number;
  readonly dataBase64: string;
  readonly done: boolean;
} | undefined {
  if (!record(value) ||
    !closed(value, ["offset", "dataBase64", "done"]) ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0 ||
    typeof value.dataBase64 !== "string" ||
    value.dataBase64.length > Math.ceil(CODEX_RESOURCE_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.dataBase64) ||
    typeof value.done !== "boolean") {
    return undefined;
  }
  const size = value.dataBase64.length / 4 * 3 - (value.dataBase64.endsWith("==") ? 2 : value.dataBase64.endsWith("=") ? 1 : 0);
  if (size > CODEX_RESOURCE_CHUNK_BYTES || JSON.stringify(value).length > CODEX_MAX_ENCODED_RESPONSE_BYTES) {
    return undefined;
  }
  return {
    offset: value.offset as number,
    dataBase64: value.dataBase64,
    done: value.done
  };
}

export function parseCodexResourceDescriptor(value: unknown): CodexResourceDescriptor | undefined {
  if (!record(value) ||
    !closed(value, ["handle", "byteLength", "sha256", "mediaType"]) ||
    !id(value.handle) ||
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    (value.mediaType !== "application/pdf" &&
      value.mediaType !== "application/wasm" &&
      value.mediaType !== "text/javascript")) {
    return undefined;
  }
  return {
    handle: value.handle,
    byteLength: value.byteLength as number,
    sha256: value.sha256,
    mediaType: value.mediaType
  };
}

export function parseCodexAppResponse(value: unknown): CodexAppResponse | undefined {
  if (!record(value)) {
    return undefined;
  }
  if (value.status === "operation-error" && value.reason === "export-conflict" && closed(value, ["status", "reason"]))
    return { status: "operation-error", reason: "export-conflict" };
  if (value.status === "pending" && closed(value, ["status"]))
    return {
      status: "pending"
    };
  if (value.status === "denied" &&
    closed(value, ["status", "reason"]) &&
    ["invalid", "expired", "replayed", "owner-mismatch", "stale-generation", "revoked", "unavailable"].includes(String(value.reason)))
    return {
      status: "denied",
      reason: value.reason as CodexAdmissionFailure
    };
  if (value.status === "active" &&
    closed(value, ["status", "presentationCapability", "reconnectTicket", "runtimeId", "attemptId", "generation"]) &&
    isCodexCapability(value.presentationCapability) &&
    isCodexCapability(value.reconnectTicket) &&
    id(value.runtimeId) &&
    id(value.attemptId) &&
    generation(value.generation))
    return {
      status: "active",
      presentationCapability: value.presentationCapability,
      reconnectTicket: value.reconnectTicket,
      runtimeId: value.runtimeId,
      attemptId: value.attemptId,
      generation: value.generation
    };
  // Operation payloads must additionally pass their method-specific runtime/resource validator.
  if (value.status === "ok" &&
    closed(value, ["status", "payload"]) &&
    Object.hasOwn(value, "payload"))
    return {
      status: "ok",
      payload: value.payload
    };
  return undefined;
}
