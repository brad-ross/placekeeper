const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;
const TRANSFER_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const CANCEL_REASON = /^[a-z0-9-]{1,64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export type NativeStartMessage =
  | {
      readonly type: "start";
      readonly protocolVersion: number;
      readonly transferId: string;
      readonly disposition: "remote-temporary";
      readonly displayName?: string;
    }
  | {
      readonly type: "start";
      readonly protocolVersion: number;
      readonly transferId: string;
      readonly disposition: "local";
      readonly fileUrl: string;
    };

export interface NativeChunkMessage {
  readonly type: "chunk";
  readonly transferId: string;
  readonly sequence: number;
  readonly data: string;
}

export interface NativeFinishMessage {
  readonly type: "finish";
  readonly transferId: string;
  readonly sequence: number;
}

export interface NativeCancelMessage {
  readonly type: "cancel";
  readonly transferId: string;
  readonly reason: string;
}

export type ExtensionNativeMessage =
  | NativeStartMessage
  | NativeChunkMessage
  | NativeFinishMessage
  | NativeCancelMessage;

export type NativeHostMessage =
  | {
      readonly type: "ack";
      readonly transferId: string;
      readonly phase: "start" | "chunk";
      readonly sequence?: number;
    }
  | { readonly type: "success"; readonly transferId: string; readonly destination: string }
  | { readonly type: "failure"; readonly transferId: string; readonly reason: string };

export class NativeMessagingProtocolError extends Error {
  constructor(readonly reason: "oversized" | "truncated" | "malformed") {
    super(`Chrome native message is ${reason}`);
    this.name = "NativeMessagingProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function transferId(value: unknown): value is string {
  return typeof value === "string" && TRANSFER_ID.test(value);
}

function sequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseExtensionMessage(value: unknown): ExtensionNativeMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !transferId(value.transferId)) {
    return undefined;
  }
  if (value.type === "start") {
    if (!Number.isSafeInteger(value.protocolVersion) || Number(value.protocolVersion) < 0) return undefined;
    if (value.disposition === "remote-temporary") {
      const keys = value.displayName === undefined
        ? ["type", "protocolVersion", "transferId", "disposition"]
        : ["type", "protocolVersion", "transferId", "disposition", "displayName"];
      if (
        !exactKeys(value, keys) ||
        (value.displayName !== undefined &&
          (typeof value.displayName !== "string" || value.displayName.length === 0 || value.displayName.length > 120))
      ) return undefined;
      return value.displayName === undefined
        ? {
            type: "start",
            protocolVersion: Number(value.protocolVersion),
            transferId: value.transferId,
            disposition: "remote-temporary",
          }
        : {
            type: "start",
            protocolVersion: Number(value.protocolVersion),
            transferId: value.transferId,
            disposition: "remote-temporary",
            displayName: value.displayName as string,
          };
    }
    if (
      value.disposition === "local" &&
      exactKeys(value, ["type", "protocolVersion", "transferId", "disposition", "fileUrl"]) &&
      typeof value.fileUrl === "string" && value.fileUrl.length > 0 && value.fileUrl.length <= 16_384
    ) {
      return {
        type: "start",
        protocolVersion: Number(value.protocolVersion),
        transferId: value.transferId,
        disposition: "local",
        fileUrl: value.fileUrl,
      };
    }
    return undefined;
  }
  if (value.type === "chunk") {
    if (
      !exactKeys(value, ["type", "transferId", "sequence", "data"]) ||
      !sequence(value.sequence) || typeof value.data !== "string" ||
      value.data.length === 0 || value.data.length > 350_000 || !BASE64.test(value.data)
    ) return undefined;
    return {
      type: "chunk",
      transferId: value.transferId,
      sequence: Number(value.sequence),
      data: value.data,
    };
  }
  if (
    value.type === "finish" &&
    exactKeys(value, ["type", "transferId", "sequence"]) && sequence(value.sequence)
  ) return { type: "finish", transferId: value.transferId, sequence: Number(value.sequence) };
  if (
    value.type === "cancel" &&
    exactKeys(value, ["type", "transferId", "reason"]) &&
    typeof value.reason === "string" && CANCEL_REASON.test(value.reason)
  ) return { type: "cancel", transferId: value.transferId, reason: value.reason };
  return undefined;
}

export function decodeBase64Chunk(value: string): Buffer | undefined {
  if (!BASE64.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > 256 * 1024) return undefined;
  return bytes.toString("base64") === value ? bytes : undefined;
}

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length === 0 || body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new NativeMessagingProtocolError("oversized");
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder {
  readonly #buffer = Buffer.allocUnsafe(MAX_NATIVE_MESSAGE_BYTES + 4);
  #start = 0;
  #end = 0;

  #decodeAvailable(messages: unknown[]): void {
    while (this.#end - this.#start >= 4) {
      const length = this.#buffer.readUInt32LE(this.#start);
      if (length === 0) throw new NativeMessagingProtocolError("malformed");
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new NativeMessagingProtocolError("oversized");
      if (this.#end - this.#start < length + 4) return;
      const body = this.#buffer.subarray(this.#start + 4, this.#start + length + 4);
      this.#start += length + 4;
      try {
        messages.push(JSON.parse(body.toString("utf8")) as unknown);
      } catch {
        throw new NativeMessagingProtocolError("malformed");
      }
    }
    if (this.#start === this.#end) this.#start = this.#end = 0;
  }

  push(chunk: Uint8Array): unknown[] {
    const messages: unknown[] = [];
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#end === this.#buffer.length) {
        if (this.#start === 0) throw new NativeMessagingProtocolError("oversized");
        this.#buffer.copyWithin(0, this.#start, this.#end);
        this.#end -= this.#start;
        this.#start = 0;
      }
      const length = Math.min(bytes.length - offset, this.#buffer.length - this.#end);
      bytes.copy(this.#buffer, this.#end, offset, offset + length);
      this.#end += length;
      offset += length;
      this.#decodeAvailable(messages);
    }
    this.#decodeAvailable(messages);
    return messages;
  }

  end(): void {
    if (this.#end !== this.#start) throw new NativeMessagingProtocolError("truncated");
  }
}
