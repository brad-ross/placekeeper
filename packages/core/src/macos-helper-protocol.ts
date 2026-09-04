export const MACOS_HELPER_PROTOCOL_VERSION = 1 as const;
export const MACOS_HELPER_MAX_FRAME_BYTES = 256 * 1024;
export const MACOS_HELPER_RESOURCE_CHUNK_BYTES = 64 * 1024;

const ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

interface ReviewEnvelope {
  readonly protocolVersion: 1;
  readonly windowId: string;
  readonly attemptId: string;
  readonly requestId: string;
}

export type MacosReviewHelperMessage = ReviewEnvelope & (
  | { readonly type: "admit"; readonly sourcePath: string }
  | {
    readonly type: "read-resource";
    readonly resourceId: string;
    readonly generation: number;
    readonly role: "document";
    readonly offset: number;
    readonly length: number;
  }
  | { readonly type: "release" }
);

export type MacosReviewHelperResponse = ReviewEnvelope & (
  | {
    readonly type: "admitted";
    readonly provisionalId: string;
    readonly resourceId: string;
    readonly generation: number;
    readonly byteLength: number;
    readonly digest: string;
  }
  | { readonly type: "resource-bytes"; readonly sequence: number; readonly data: string; readonly done: boolean }
  | { readonly type: "released" }
  | { readonly type: "failure"; readonly code: "invalid" | "stale" | "unavailable" | "budget" }
);

export type MacosLifecycleMessage =
  | {
    readonly protocolVersion: 1;
    readonly type: "register-app";
    readonly processId: number;
    readonly startIdentity: string;
    readonly buildIdentity: string;
  }
  | { readonly protocolVersion: 1; readonly type: "activity"; readonly activeWindows: number; readonly bootstrappingWindows: number }
  | { readonly protocolVersion: 1; readonly type: "prepare-replacement" }
  | { readonly protocolVersion: 1; readonly type: "detach" };

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
  return value.protocolVersion === MACOS_HELPER_PROTOCOL_VERSION && id(value.windowId)
    && id(value.attemptId) && id(value.requestId);
}

export function parseMacosReviewHelperMessage(value: unknown): MacosReviewHelperMessage | undefined {
  if (!record(value) || !reviewEnvelope(value)) return undefined;
  const base = ["protocolVersion", "windowId", "attemptId", "requestId", "type"];
  if (value.type === "admit") {
    return exact(value, [...base, "sourcePath"]) && typeof value.sourcePath === "string"
      && value.sourcePath.startsWith("/") && value.sourcePath.length <= 16_384 && !value.sourcePath.includes("\0")
      ? value as unknown as MacosReviewHelperMessage : undefined;
  }
  if (value.type === "read-resource") {
    return exact(value, [...base, "resourceId", "generation", "role", "offset", "length"])
      && id(value.resourceId) && integer(value.generation) && value.generation > 0
      && value.role === "document" && integer(value.offset, 512 * 1024 * 1024)
      && integer(value.length, MACOS_HELPER_RESOURCE_CHUNK_BYTES) && value.length > 0
      ? value as unknown as MacosReviewHelperMessage : undefined;
  }
  return value.type === "release" && exact(value, base)
    ? value as unknown as MacosReviewHelperMessage : undefined;
}

export function parseMacosLifecycleMessage(value: unknown): MacosLifecycleMessage | undefined {
  if (!record(value) || value.protocolVersion !== MACOS_HELPER_PROTOCOL_VERSION) return undefined;
  if (value.type === "register-app") {
    return exact(value, ["protocolVersion", "type", "processId", "startIdentity", "buildIdentity"])
      && integer(value.processId) && value.processId > 0 && id(value.startIdentity) && id(value.buildIdentity)
      ? value as unknown as MacosLifecycleMessage : undefined;
  }
  if (value.type === "activity") {
    return exact(value, ["protocolVersion", "type", "activeWindows", "bootstrappingWindows"])
      && integer(value.activeWindows, 64) && integer(value.bootstrappingWindows, 64)
      && value.bootstrappingWindows <= value.activeWindows
      ? value as unknown as MacosLifecycleMessage : undefined;
  }
  if (value.type === "prepare-replacement" || value.type === "detach") {
    return exact(value, ["protocolVersion", "type"])
      ? value as unknown as MacosLifecycleMessage : undefined;
  }
  return undefined;
}

export function encodeMacosHelperFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength === 0 || body.byteLength > MACOS_HELPER_MAX_FRAME_BYTES) {
    throw new Error("macOS helper frame is too large");
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeMacosHelperFrame(frame: Uint8Array): unknown {
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.byteLength < 4) throw new Error("macOS helper frame length is missing");
  const length = bytes.readUInt32BE(0);
  if (length > MACOS_HELPER_MAX_FRAME_BYTES) throw new Error("macOS helper frame is too large");
  if (length === 0 || bytes.byteLength !== length + 4) throw new Error("macOS helper frame length is invalid");
  return JSON.parse(bytes.subarray(4).toString("utf8")) as unknown;
}

export function validMacosReviewHelperResponse(value: unknown): value is MacosReviewHelperResponse {
  if (!record(value) || !reviewEnvelope(value)) return false;
  const base = ["protocolVersion", "windowId", "attemptId", "requestId", "type"];
  if (value.type === "admitted") {
    return exact(value, [...base, "provisionalId", "resourceId", "generation", "byteLength", "digest"])
      && id(value.provisionalId) && id(value.resourceId) && integer(value.generation) && value.generation > 0
      && integer(value.byteLength, 512 * 1024 * 1024) && typeof value.digest === "string" && SHA256.test(value.digest);
  }
  if (value.type === "resource-bytes") {
    return exact(value, [...base, "sequence", "data", "done"]) && integer(value.sequence)
      && typeof value.data === "string" && value.data.length <= MACOS_HELPER_RESOURCE_CHUNK_BYTES * 2
      && typeof value.done === "boolean";
  }
  if (value.type === "failure") {
    return exact(value, [...base, "code"])
      && ["invalid", "stale", "unavailable", "budget"].includes(String(value.code));
  }
  return value.type === "released" && exact(value, base);
}
