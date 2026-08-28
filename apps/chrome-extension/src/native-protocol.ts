export const NATIVE_HOST_NAME = "com.placekeeper.chrome";
export const NATIVE_PROTOCOL_VERSION = 1;
export const MAX_CHUNK_BYTES = 256 * 1024;

const TRANSFER_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/u;

export type StartMessage =
  | {
      readonly type: "start";
      readonly protocolVersion: 1;
      readonly transferId: string;
      readonly disposition: "remote-temporary";
      readonly displayName?: string;
    }
  | {
      readonly type: "start";
      readonly protocolVersion: 1;
      readonly transferId: string;
      readonly disposition: "local";
      readonly fileUrl: string;
    };

export interface ChunkMessage {
  readonly type: "chunk";
  readonly transferId: string;
  readonly sequence: number;
  readonly data: string;
}

export interface FinishMessage {
  readonly type: "finish";
  readonly transferId: string;
  readonly sequence: number;
}

export interface CancelMessage {
  readonly type: "cancel";
  readonly transferId: string;
  readonly reason: string;
}

export type ExtensionMessage = StartMessage | ChunkMessage | FinishMessage | CancelMessage;

export type HostMessage =
  | {
      readonly type: "ack";
      readonly transferId: string;
      readonly phase: "start" | "chunk" | "finish";
      readonly sequence?: number;
    }
  | {
      readonly type: "success";
      readonly transferId: string;
      readonly destination: string;
    }
  | {
      readonly type: "failure";
      readonly transferId: string;
      readonly reason: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join("\0") === [...keys].sort().join("\0");
}

function isTransferId(value: unknown): value is string {
  return typeof value === "string" && TRANSFER_ID.test(value);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

export function createChunkMessage(
  transferId: string,
  sequence: number,
  bytes: Uint8Array,
): ChunkMessage {
  if (!isTransferId(transferId)) throw new Error("Invalid transfer ID");
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid chunk sequence");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new Error("Invalid native-message chunk size");
  }
  return { type: "chunk", transferId, sequence, data: bytesToBase64(bytes) };
}

export function parseHostMessage(value: unknown): HostMessage | undefined {
  if (!isRecord(value) || !isTransferId(value.transferId) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "ack") {
    const phase = value.phase;
    if (phase !== "start" && phase !== "chunk" && phase !== "finish") return undefined;
    const keys = value.sequence === undefined
      ? ["type", "transferId", "phase"]
      : ["type", "transferId", "phase", "sequence"];
    if (!hasExactKeys(value, keys)) return undefined;
    if (value.sequence !== undefined && (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0)) {
      return undefined;
    }
    return value.sequence === undefined
      ? { type: "ack", transferId: value.transferId, phase }
      : { type: "ack", transferId: value.transferId, phase, sequence: Number(value.sequence) };
  }
  if (value.type === "success") {
    return hasExactKeys(value, ["type", "transferId", "destination"]) &&
        typeof value.destination === "string"
      ? { type: "success", transferId: value.transferId, destination: value.destination }
      : undefined;
  }
  if (value.type === "failure") {
    return hasExactKeys(value, ["type", "transferId", "reason"]) &&
        typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 128
      ? { type: "failure", transferId: value.transferId, reason: value.reason }
      : undefined;
  }
  return undefined;
}

export function validatePlacekeeperDestination(value: string): string | undefined {
  let destination: URL;
  try {
    destination = new URL(value);
  } catch {
    return undefined;
  }
  if (
    destination.origin !== "http://127.0.0.1:43179" ||
    destination.username !== "" ||
    destination.password !== "" ||
    destination.search !== ""
  ) return undefined;
  const match = /^\/s\/([^/]+)\/bootstrap$/u.exec(destination.pathname);
  if (match?.[1] === undefined || !SESSION_ID.test(match[1])) return undefined;
  const fragment = new URLSearchParams(destination.hash.slice(1));
  const capability = fragment.get("cap");
  if (capability === null || !CAPABILITY.test(capability) || [...fragment.keys()].length !== 1) {
    return undefined;
  }
  return destination.href;
}
