import {
  REVIEW_RUNTIME_PROTOCOL,
  REVIEW_RUNTIME_VERSION,
  isReviewRuntimeMethodForHost,
  sanitizeMacosReviewRuntimeRequest,
  sanitizeMacosReviewRuntimeResponse,
} from "./review-runtime-protocol.js";

export const MACOS_SHELL_PROTOCOL_VERSION = 1 as const;

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const MANIFEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface MacosRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const MACOS_REVIEW_COMMAND_IDS = [
  "undo",
  "redo",
  "navigate-back",
  "navigate-forward",
  "find",
  "open-annotations",
  "save-options",
  "fit-width",
  "zoom-in",
  "zoom-out",
] as const;

export type MacosReviewCommandId = typeof MACOS_REVIEW_COMMAND_IDS[number];

export type MacosPageMessage =
  | {
    readonly protocolVersion: 1;
    readonly type: "shell-ready";
    readonly layoutRevision: number;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "visible-shell-ready";
    readonly layoutRevision: number;
    readonly geometryIdentity: string;
    readonly frameSequence: number;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "drag-regions";
    readonly layoutRevision: number;
    readonly geometryIdentity: string;
    readonly transitioning: boolean;
    readonly regions: readonly MacosRect[];
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "runtime-message";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly message: unknown;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "document-ready";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly generation: number;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "runtime-error";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly stage: "bootstrap" | "document" | "runtime";
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "command-snapshot";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly revision: number;
    readonly focusContext: "review" | "editable" | "dialog";
    readonly commands: readonly {
      readonly id: MacosReviewCommandId;
      readonly label: string;
      readonly enabled: boolean;
      readonly shortcut?: string;
    }[];
  };

export interface MacosDocumentResource {
  readonly url: string;
  readonly generation: number;
  readonly mime: "application/pdf";
  readonly byteLength: number;
  readonly digest: string;
}

export type MacosNativeMessage =
  | {
    readonly protocolVersion: 1;
    readonly type: "presentation-transition";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly geometryIdentity: string;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "bootstrap";
    readonly document: {
      readonly displayName: string;
      readonly resource: MacosDocumentResource;
    };
    readonly geometry: {
      readonly identity: string;
      readonly trafficLightInset: number;
      readonly trafficLightBounds: readonly MacosRect[];
      readonly trailingInset: number;
    };
    readonly runtimeId?: string;
    readonly attemptId?: string;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "commit-visible";
    readonly geometryIdentity: string;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "geometry-changed";
    readonly geometry: {
      readonly identity: string;
      readonly trafficLightInset: number;
      readonly trafficLightBounds: readonly MacosRect[];
      readonly trailingInset: number;
    };
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "fatal-error";
    readonly code: "shell-unavailable" | "helper-unavailable" | "resource-invalid";
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "runtime-message";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly message: unknown;
  }
  | {
    readonly protocolVersion: 1;
    readonly type: "invoke-command";
    readonly runtimeId: string;
    readonly attemptId: string;
    readonly command: MacosReviewCommandId;
    readonly snapshotRevision: number;
    readonly token: number;
  };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function safeFinite(value: unknown, maximum = 100_000): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function opaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function safeCommandString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function reviewCommandId(value: unknown): value is MacosReviewCommandId {
  return MACOS_REVIEW_COMMAND_IDS.includes(value as MacosReviewCommandId);
}

function runtimeIdentity(value: Record<string, unknown>): boolean {
  return typeof value.sessionId === "string" && SESSION_ID.test(value.sessionId)
    && safeInteger(value.generation) && safeInteger(value.revision);
}

function validPageRuntimeMessage(value: unknown, runtimeId: string): boolean {
  if (!record(value) || value.protocol !== REVIEW_RUNTIME_PROTOCOL || value.version !== REVIEW_RUNTIME_VERSION
    || value.runtimeId !== runtimeId || !opaqueId(value.requestId)) return false;
  if (value.kind === "cancel") {
    return exact(value, ["protocol", "version", "kind", "runtimeId", "requestId"]);
  }
  if (value.kind !== "request" || !isReviewRuntimeMethodForHost("macos", value.method)) return false;
  const bootstrap = value.method === "bootstrap";
  const keys = bootstrap
    ? ["protocol", "version", "kind", "runtimeId", "requestId", "method", "payload"]
    : [
        "protocol", "version", "kind", "runtimeId", "requestId", "sessionId", "generation",
        "revision", "method", "payload",
      ];
  return exact(value, keys) && (bootstrap || runtimeIdentity(value))
    && sanitizeMacosReviewRuntimeRequest(value.method, value.payload) !== undefined;
}

function validNativeRuntimeMessage(value: unknown, runtimeId: string): boolean {
  if (!record(value) || value.protocol !== REVIEW_RUNTIME_PROTOCOL || value.version !== REVIEW_RUNTIME_VERSION
    || value.runtimeId !== runtimeId) return false;
  if (value.kind === "event") {
    if (!exact(value, ["protocol", "version", "kind", "runtimeId", "event", "payload"])
      || value.event !== "session-invalidated" || !record(value.payload)
      || !runtimeIdentity(value.payload)) return false;
    return exact(value.payload, [
      "sessionId", "generation", "revision", "reason",
      ...(value.payload.previousGeneration === undefined ? [] : ["previousGeneration"]),
    ]) && ["generation", "revision", "freshness"].includes(String(value.payload.reason))
      && (value.payload.previousGeneration === undefined || safeInteger(value.payload.previousGeneration));
  }
  if (value.kind !== "response" || !opaqueId(value.requestId) || !runtimeIdentity(value)
    || !isReviewRuntimeMethodForHost("macos", value.method) || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    return exact(value, [
      "protocol", "version", "kind", "runtimeId", "sessionId", "generation", "revision",
      "requestId", "method", "ok", "payload",
    ]) && sanitizeMacosReviewRuntimeResponse(value.method, value.payload) !== undefined;
  }
  return exact(value, [
    "protocol", "version", "kind", "runtimeId", "sessionId", "generation", "revision",
    "requestId", "method", "ok", "error",
  ]) && record(value.error) && exact(value.error, ["kind"]) && value.error.kind === "rejected";
}

function rect(value: unknown): value is MacosRect {
  return record(value) && exact(value, ["x", "y", "width", "height"])
    && safeFinite(value.x) && safeFinite(value.y)
    && safeFinite(value.width) && value.width > 0
    && safeFinite(value.height) && value.height > 0;
}

export function parseMacosPageMessage(value: unknown): MacosPageMessage | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_SHELL_PROTOCOL_VERSION) return undefined;
  if (value.type === "shell-ready") {
    return exact(value, ["protocolVersion", "type", "layoutRevision"])
      && safeInteger(value.layoutRevision) ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "visible-shell-ready") {
    return exact(value, [
      "protocolVersion", "type", "layoutRevision", "geometryIdentity", "frameSequence",
    ]) && safeInteger(value.layoutRevision) && opaqueId(value.geometryIdentity)
      && safeInteger(value.frameSequence) && value.frameSequence > 0
      ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "drag-regions") {
    return exact(value, [
      "protocolVersion", "type", "layoutRevision", "geometryIdentity", "transitioning", "regions",
    ]) && safeInteger(value.layoutRevision) && opaqueId(value.geometryIdentity)
      && typeof value.transitioning === "boolean"
      && Array.isArray(value.regions) && value.regions.length <= 32 && value.regions.every(rect)
      && (!value.transitioning || value.regions.length === 0)
      ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "runtime-message") {
    if (!(exact(value, ["protocolVersion", "type", "runtimeId", "attemptId", "message"])
      && opaqueId(value.runtimeId) && opaqueId(value.attemptId)
      && validPageRuntimeMessage(value.message, value.runtimeId))) return undefined;
    const message = value.message as Record<string, unknown>;
    if (message.kind !== "request") return value as unknown as MacosPageMessage;
    if (!isReviewRuntimeMethodForHost("macos", message.method)) return undefined;
    return {
      ...value,
      message: {
        ...message,
        payload: sanitizeMacosReviewRuntimeRequest(message.method, message.payload),
      },
    } as unknown as MacosPageMessage;
  }
  if (value.type === "document-ready") {
    return exact(value, ["protocolVersion", "type", "runtimeId", "attemptId", "generation"])
      && opaqueId(value.runtimeId) && opaqueId(value.attemptId)
      && safeInteger(value.generation) && value.generation > 0
      ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "runtime-error") {
    return exact(value, ["protocolVersion", "type", "runtimeId", "attemptId", "stage"])
      && opaqueId(value.runtimeId) && opaqueId(value.attemptId)
      && ["bootstrap", "document", "runtime"].includes(String(value.stage))
      ? value as unknown as MacosPageMessage : undefined;
  }
  if (value.type === "command-snapshot") {
    if (!(exact(value, [
      "protocolVersion", "type", "runtimeId", "attemptId", "revision", "focusContext", "commands",
    ]) && opaqueId(value.runtimeId) && opaqueId(value.attemptId) && safeInteger(value.revision)
      && ["review", "editable", "dialog"].includes(String(value.focusContext))
      && Array.isArray(value.commands) && value.commands.length === MACOS_REVIEW_COMMAND_IDS.length)) {
      return undefined;
    }
    const seen = new Set<MacosReviewCommandId>();
    for (const command of value.commands) {
      if (!record(command) || !exact(command, [
        "id", "label", "enabled", ...(command.shortcut === undefined ? [] : ["shortcut"]),
      ]) || !reviewCommandId(command.id) || seen.has(command.id)
        || !safeCommandString(command.label, 80) || typeof command.enabled !== "boolean"
        || (command.shortcut !== undefined && !safeCommandString(command.shortcut, 40))) return undefined;
      seen.add(command.id);
    }
    return value as unknown as MacosPageMessage;
  }
  return undefined;
}

function safeDisplayName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255
    && !/[\u0000-\u001f/\\]/u.test(value);
}

export function parseMacosBundleURL(value: unknown): { readonly manifestKey: string } | undefined {
  if (typeof value !== "string" || value.length > 512 || /(?:^|[/\\])\.\.(?:[/\\]|$)|%2e|%2f|%5c/iu.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "placekeeper-app:" || url.hostname !== "bundle" || url.username !== ""
      || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return undefined;
    const manifestKey = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    if (!MANIFEST_KEY.test(manifestKey) || manifestKey.includes("//") || manifestKey.split("/").includes("..")) {
      return undefined;
    }
    return { manifestKey };
  } catch {
    return undefined;
  }
}

export function parseMacosResourceURL(value: unknown): {
  readonly resourceId: string;
  readonly generation: number;
  readonly role: "document";
} | undefined {
  if (typeof value !== "string" || value.length > 512 || /%2f|%5c/iu.test(value)) return undefined;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    const generationText = url.searchParams.get("generation");
    const generation = generationText === null || !/^[1-9]\d{0,8}$/u.test(generationText)
      ? undefined : Number(generationText);
    const resourceId = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    if (url.protocol !== "placekeeper-resource:" || url.hostname !== "document"
      || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== ""
      || keys.length !== 2 || keys[0] !== "generation" || keys[1] !== "role"
      || url.searchParams.get("role") !== "document" || generation === undefined
      || !opaqueId(resourceId)) return undefined;
    return { resourceId, generation, role: "document" };
  } catch {
    return undefined;
  }
}

export function parseMacosNativeMessage(value: unknown): MacosNativeMessage | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_SHELL_PROTOCOL_VERSION) return undefined;
  if (value.type === "presentation-transition") {
    return exact(value, ["protocolVersion", "type", "runtimeId", "attemptId", "geometryIdentity"])
      && opaqueId(value.runtimeId) && opaqueId(value.attemptId) && opaqueId(value.geometryIdentity)
      ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type === "commit-visible") {
    return exact(value, ["protocolVersion", "type", "geometryIdentity"])
      && opaqueId(value.geometryIdentity) ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type === "geometry-changed") {
    return exact(value, ["protocolVersion", "type", "geometry"]) && record(value.geometry)
      && exact(value.geometry, ["identity", "trafficLightInset", "trafficLightBounds", "trailingInset"])
      && opaqueId(value.geometry.identity) && safeFinite(value.geometry.trafficLightInset, 1_000)
      && Array.isArray(value.geometry.trafficLightBounds)
      && value.geometry.trafficLightBounds.length <= 3
      && value.geometry.trafficLightBounds.every(rect)
      && safeFinite(value.geometry.trailingInset, 1_000)
      ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type === "fatal-error") {
    return exact(value, ["protocolVersion", "type", "code"])
      && ["shell-unavailable", "helper-unavailable", "resource-invalid"].includes(String(value.code))
      ? value as unknown as MacosNativeMessage : undefined;
  }
  if (value.type === "runtime-message") {
    if (!(exact(value, ["protocolVersion", "type", "runtimeId", "attemptId", "message"])
      && opaqueId(value.runtimeId) && opaqueId(value.attemptId)
      && validNativeRuntimeMessage(value.message, value.runtimeId))) return undefined;
    const message = value.message as Record<string, unknown>;
    if (message.kind !== "response" || message.ok !== true) return value as unknown as MacosNativeMessage;
    if (!isReviewRuntimeMethodForHost("macos", message.method)) return undefined;
    return {
      ...value,
      message: {
        ...message,
        payload: sanitizeMacosReviewRuntimeResponse(message.method, message.payload),
      },
    } as unknown as MacosNativeMessage;
  }
  if (value.type === "invoke-command") {
    return exact(value, [
      "protocolVersion", "type", "runtimeId", "attemptId", "command", "snapshotRevision", "token",
    ]) && opaqueId(value.runtimeId) && opaqueId(value.attemptId)
      && reviewCommandId(value.command) && safeInteger(value.snapshotRevision)
      && value.snapshotRevision > 0 && safeInteger(value.token) && value.token > 0
      ? value as unknown as MacosNativeMessage : undefined;
  }
  const hasRuntimeIdentity = value.runtimeId !== undefined || value.attemptId !== undefined;
  const bootstrapKeys = !hasRuntimeIdentity
    ? ["protocolVersion", "type", "document", "geometry"]
    : ["protocolVersion", "type", "document", "geometry", "runtimeId", "attemptId"];
  if (value.type !== "bootstrap" || !exact(value, bootstrapKeys)
    || (hasRuntimeIdentity && (!opaqueId(value.runtimeId) || !opaqueId(value.attemptId)))
    || !record(value.document) || !record(value.geometry)) return undefined;
  const resource = value.document.resource;
  if (!exact(value.document, ["displayName", "resource"]) || !safeDisplayName(value.document.displayName)
    || !record(resource) || !exact(resource, ["url", "generation", "mime", "byteLength", "digest"])
    || resource.mime !== "application/pdf" || !safeInteger(resource.generation) || resource.generation < 1
    || !safeInteger(resource.byteLength, 512 * 1024 * 1024) || resource.byteLength < 5
    || typeof resource.digest !== "string" || !SHA256.test(resource.digest)) return undefined;
  const parsedResource = parseMacosResourceURL(resource.url);
  if (parsedResource === undefined || parsedResource.generation !== resource.generation
    || !exact(value.geometry, ["identity", "trafficLightInset", "trafficLightBounds", "trailingInset"])
    || !opaqueId(value.geometry.identity) || !safeFinite(value.geometry.trafficLightInset, 1_000)
    || !Array.isArray(value.geometry.trafficLightBounds)
    || value.geometry.trafficLightBounds.length > 3
    || !value.geometry.trafficLightBounds.every(rect)
    || !safeFinite(value.geometry.trailingInset, 1_000)) return undefined;
  return value as unknown as MacosNativeMessage;
}
