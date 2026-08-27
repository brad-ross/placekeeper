import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

const DEFAULT_PRESENCE_GRACE_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2;
const MAX_APPLICATION_FRAME_BYTES = 1_024;
const MAX_BUFFERED_FRAME_BYTES = MAX_APPLICATION_FRAME_BYTES + 32;

interface ControlClient {
  readonly socket: Duplex;
  buffer: Buffer;
  lastPongAt: number;
  lastApplicationFrameAt?: number;
  heartbeat?: ReturnType<typeof setInterval>;
}

export interface SessionControlRegistryOptions {
  readonly now?: () => number;
  readonly presenceGraceMs?: number;
  readonly heartbeat?: boolean;
}

function serverFrame(opcode: number, payload = Buffer.alloc(0)): Buffer {
  if (payload.byteLength <= 125) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.byteLength]), payload]);
  }
  if (payload.byteLength <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }
  throw new RangeError("Server control frame exceeds the bounded payload size");
}

export class SessionControlRegistry {
  readonly #clients = new Map<string, Set<ControlClient>>();
  readonly #writes = new Map<string, Set<AbortController>>();
  readonly #graceExpiresAt = new Map<string, number>();
  readonly #now: () => number;
  readonly #presenceGraceMs: number;
  readonly #heartbeat: boolean;

  constructor(options: SessionControlRegistryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#presenceGraceMs = options.presenceGraceMs ?? DEFAULT_PRESENCE_GRACE_MS;
    this.#heartbeat = options.heartbeat ?? true;
    if (!Number.isSafeInteger(this.#presenceGraceMs) || this.#presenceGraceMs <= 0) {
      throw new RangeError("presenceGraceMs must be a positive safe integer");
    }
  }

  noteAuthenticatedPage(sessionId: string): void {
    if ((this.#clients.get(sessionId)?.size ?? 0) === 0) {
      this.#graceExpiresAt.set(sessionId, this.#now() + this.#presenceGraceMs);
    }
  }

  registerSocket(sessionId: string, socket: Duplex, initialData?: Buffer): () => void {
    const clients = this.#clients.get(sessionId) ?? new Set<ControlClient>();
    this.#graceExpiresAt.delete(sessionId);
    const client: ControlClient = {
      socket,
      buffer: Buffer.alloc(0),
      lastPongAt: this.#now(),
    };
    clients.add(client);
    this.#clients.set(sessionId, clients);
    let registered = true;
    const unregister = (): void => {
      if (!registered) return;
      registered = false;
      if (client.heartbeat !== undefined) clearInterval(client.heartbeat);
      clients.delete(client);
      if (clients.size === 0 && this.#clients.get(sessionId) === clients) {
        this.#clients.delete(sessionId);
        this.#graceExpiresAt.set(sessionId, this.#now() + this.#presenceGraceMs);
      }
    };
    const reject = (): void => {
      socket.destroy();
    };
    const receive = (chunk: Buffer | string): void => {
      if (!registered) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      client.buffer = Buffer.concat([client.buffer, bytes]);
      if (client.buffer.byteLength > MAX_BUFFERED_FRAME_BYTES) return reject();
      while (client.buffer.byteLength >= 2) {
        const first = client.buffer[0]!;
        const second = client.buffer[1]!;
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        const encodedLength = second & 0x7f;
        let offset = 2;
        if (!final || !masked || encodedLength === 127) return reject();
        if (client.buffer.byteLength < offset + (encodedLength === 126 ? 2 : 0)) return;
        const payloadLength = encodedLength === 126
          ? client.buffer.readUInt16BE(offset)
          : encodedLength;
        if (encodedLength === 126) offset += 2;
        if (payloadLength > MAX_APPLICATION_FRAME_BYTES || (opcode >= 0x8 && payloadLength > 125)) {
          return reject();
        }
        if (client.buffer.byteLength < offset + 4 + payloadLength) return;
        const mask = client.buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(client.buffer.subarray(offset, offset + payloadLength));
        client.buffer = client.buffer.subarray(offset + payloadLength);
        for (let index = 0; index < payload.byteLength; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
        if (opcode === 0x8) {
          socket.end(serverFrame(0x8));
          return;
        }
        if (opcode === 0x9) {
          socket.write(serverFrame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) {
          client.lastPongAt = this.#now();
          continue;
        }
        if (opcode !== 0x1) return reject();
        const now = this.#now();
        if (client.lastApplicationFrameAt !== undefined && now - client.lastApplicationFrameAt < 1_000) {
          return reject();
        }
        client.lastApplicationFrameAt = now;
        try {
          const value = JSON.parse(payload.toString("utf8")) as unknown;
          if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "presence") {
            return reject();
          }
        } catch {
          return reject();
        }
      }
    };
    socket.on("data", receive);
    socket.once("close", unregister);
    socket.once("error", unregister);
    if (initialData !== undefined && initialData.byteLength > 0) receive(initialData);
    if (this.#heartbeat) {
      client.heartbeat = setInterval(() => {
        if (this.#now() - client.lastPongAt >= HEARTBEAT_TIMEOUT_MS) {
          reject();
          return;
        }
        socket.write(serverFrame(0x9, randomBytes(8)));
      }, HEARTBEAT_INTERVAL_MS);
      client.heartbeat.unref?.();
    }
    return unregister;
  }

  beginWrite(sessionId: string): { signal: AbortSignal; complete: () => void } {
    const controller = new AbortController();
    const writes = this.#writes.get(sessionId) ?? new Set<AbortController>();
    writes.add(controller);
    this.#writes.set(sessionId, writes);
    return {
      signal: controller.signal,
      complete: () => {
        writes.delete(controller);
        if (writes.size === 0) this.#writes.delete(sessionId);
      },
    };
  }

  activity(): { readonly reviewPresence: number; readonly transientWork: number } {
    const now = this.#now();
    for (const [sessionId, expiresAt] of this.#graceExpiresAt) {
      if (expiresAt <= now) this.#graceExpiresAt.delete(sessionId);
    }
    let connected = 0;
    for (const clients of this.#clients.values()) connected += clients.size;
    let writes = 0;
    for (const pending of this.#writes.values()) writes += pending.size;
    return {
      reviewPresence: connected + this.#graceExpiresAt.size,
      transientWork: writes,
    };
  }

  publishSuccessor(
    sessionId: string,
    event: { readonly previousGeneration: number; readonly documentGeneration: number },
  ): void {
    const payload = Buffer.from(JSON.stringify({
      kind: "document-successor",
      previousGeneration: event.previousGeneration,
      documentGeneration: event.documentGeneration,
    }), "utf8");
    if (payload.byteLength > MAX_APPLICATION_FRAME_BYTES) {
      throw new RangeError("Document successor invalidation exceeds the control-frame limit");
    }
    const frame = serverFrame(0x1, payload);
    for (const client of this.#clients.get(sessionId) ?? []) {
      try {
        client.socket.write(frame);
      } catch {
        client.socket.destroy();
      }
    }
  }

  cancel(sessionId: string): void {
    for (const controller of this.#writes.get(sessionId) ?? []) {
      controller.abort(new Error("Review session ended"));
    }
    this.#writes.delete(sessionId);
    this.#graceExpiresAt.delete(sessionId);
    for (const client of this.#clients.get(sessionId) ?? []) client.socket.destroy();
    this.#clients.delete(sessionId);
  }

  closeAllSockets(): void {
    for (const clients of this.#clients.values()) {
      for (const client of clients) client.socket.destroy();
    }
    this.#clients.clear();
    this.#graceExpiresAt.clear();
  }
}
