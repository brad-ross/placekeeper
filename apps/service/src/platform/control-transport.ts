import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { ensurePrivateDirectory, readPrivateFile, writePrivateFile } from "./private-storage.js";
const MAX_BYTES = 16 * 1024 * 1024;
const nonce = (): string => randomBytes(32).toString("hex");
const validNonce = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
interface Discovery { version: 1; port: number; epoch: string; secret: string; pid: number }
export class PrivateControlError extends Error {
  constructor(readonly reason: "malformed" | "oversized" | "early-close" | "timeout") { super(`Private control ${reason}`); }
}
function tag(secret: string, ...parts: unknown[]): string {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(parts)).digest("hex");
}
function verify(expected: string, actual: unknown): void {
  if (!validNonce(actual) || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"))) throw new PrivateControlError("malformed");
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PrivateControlError("malformed");
  return value as Record<string, unknown>;
}
function channel(socket: Socket, timeoutMs: number, maxBytes = MAX_BYTES) {
  let assembly = Buffer.alloc(2048); let fragmentBytes = 0;
  const lines: Buffer[] = []; let queuedBytes = 0;
  let activeLimit = Math.min(maxBytes, 2048);
  let pending: { resolve(value: unknown): void; reject(error: unknown): void } | undefined;
  let failure: Error | undefined;
  const fail = (error: Error): void => { failure = error; pending?.reject(error); pending = undefined; socket.destroy(); };
  socket.on("error", (error) => fail(error));
  socket.on("end", () => fail(new PrivateControlError("early-close")));
  socket.on("close", () => { clearTimeout(timer); pending?.reject(failure ?? new PrivateControlError("early-close")); pending = undefined; });
  const timer = setTimeout(() => fail(new PrivateControlError("timeout")), timeoutMs);
  const consume = (): void => {
    if (pending === undefined || lines.length === 0) return;
    const waiter = pending; pending = undefined;
    const line = lines.shift()!; queuedBytes -= line.length;
    try { waiter.resolve(JSON.parse(line.toString("utf8")) as unknown); }
    catch { const error = new PrivateControlError("malformed"); waiter.reject(error); fail(error); }
  };
  socket.on("data", (data: Buffer) => {
    let offset = 0;
    while (offset < data.length) {
      const newline = data.indexOf(10, offset); const end = newline < 0 ? data.length : newline;
      const fragment = data.subarray(offset, end);
      const required = fragmentBytes + fragment.length;
      if (required + queuedBytes > activeLimit) { fail(new PrivateControlError("oversized")); return; }
      if (required > assembly.length) {
        const grown = Buffer.alloc(Math.min(activeLimit, Math.max(required, assembly.length * 2)));
        assembly.copy(grown, 0, 0, fragmentBytes); assembly = grown;
      }
      fragment.copy(assembly, fragmentBytes); fragmentBytes = required;
      if (newline < 0) return;
      const line = Buffer.from(assembly.subarray(0, fragmentBytes)); fragmentBytes = 0;
      lines.push(line); queuedBytes += line.length;
      if (lines.length > 2) { fail(new PrivateControlError("malformed")); return; }
      consume(); offset = newline + 1;
    }
  });
  return {
    read: (limit = maxBytes): Promise<unknown> => new Promise((resolve, reject) => {
      if (failure !== undefined) { reject(failure); return; }
      activeLimit = Math.min(limit, maxBytes);
      if (fragmentBytes + queuedBytes > activeLimit) { const error = new PrivateControlError("oversized"); reject(error); fail(error); return; }
      pending = { resolve, reject }; consume();
    }),
    write: (value: unknown): void => {
      const bytes = `${JSON.stringify(value)}\n`;
      if (Buffer.byteLength(bytes) > maxBytes) throw new PrivateControlError("oversized");
      socket.write(bytes);
    },
    finish: (): Promise<void> => new Promise((resolve, reject) => {
      if (socket.destroyed) { reject(failure ?? new PrivateControlError("early-close")); return; }
      socket.once("error", reject);
      socket.once("close", () => reject(failure ?? new PrivateControlError("early-close")));
      socket.end(() => { clearTimeout(timer); resolve(); });
    }),
  };
}
export async function readControlDiscovery(path: string): Promise<Discovery> {
  let parsed: unknown;
  try { parsed = JSON.parse((await readPrivateFile(path, 2048)).toString("utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new PrivateControlError("malformed");
  }
  const value = record(parsed);
  if (value.version !== 1 || !Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535 ||
      !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0 || !validNonce(value.epoch) || !validNonce(value.secret)) throw new PrivateControlError("malformed");
  return value as unknown as Discovery;
}
export async function requestPrivateControl(path: string, request: unknown, options: { timeoutMs?: number; maxMessageBytes?: number; signal?: AbortSignal } = {}): Promise<unknown> {
  options.signal?.throwIfAborted();
  const discovery = await readControlDiscovery(path);
  options.signal?.throwIfAborted();
  const socket = createConnection({ host: "127.0.0.1", port: discovery.port });
  const io = channel(socket, options.timeoutMs ?? 5000, options.maxMessageBytes);
  const abort = (): void => { socket.destroy(options.signal?.reason); };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const client = nonce();
    io.write({ type: "hello", client });
    const hello = record(await io.read(2048));
    if (hello.type !== "server" || hello.epoch !== discovery.epoch || !validNonce(hello.challenge)) throw new PrivateControlError("malformed");
    const challenge = hello.challenge;
    verify(tag(discovery.secret, "server", discovery.epoch, client, challenge), hello.proof);
    io.write({ type: "client", proof: tag(discovery.secret, "client", discovery.epoch, client, challenge) });
    const ready = record(await io.read(2048));
    if (ready.type !== "ready") throw new PrivateControlError("malformed");
    verify(tag(discovery.secret, "ready", discovery.epoch, client, challenge), ready.proof);
    io.write({ type: "request", body: request, proof: tag(discovery.secret, "request", discovery.epoch, client, challenge, request) });
    const response = record(await io.read());
    if (response.type !== "response") throw new PrivateControlError("malformed");
    verify(tag(discovery.secret, "response", discovery.epoch, client, challenge, response.body), response.proof);
    return response.body;
  } finally { options.signal?.removeEventListener("abort", abort); socket.destroy(); }
}
export async function startPrivateControlServer(path: string, handler: (request: unknown, signal: AbortSignal) => Promise<unknown>, afterResponse?: (response: unknown) => Promise<void>, onUndeliveredResponse?: (response: unknown, request: unknown) => Promise<void>) {
  await ensurePrivateDirectory(dirname(path));
  const epoch = nonce(); const secret = nonce();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    const lifetime = new AbortController();
    socket.once("close", () => lifetime.abort());
    const io = channel(socket, 10 * 60_000);
    const handshakeTimer = setTimeout(() => socket.destroy(), 5000);
    socket.once("close", () => clearTimeout(handshakeTimer));
    void (async () => {
      const hello = record(await io.read(2048));
      if (hello.type !== "hello" || !validNonce(hello.client)) throw new PrivateControlError("malformed");
      const client = hello.client; const challenge = nonce();
      io.write({ type: "server", epoch, challenge, proof: tag(secret, "server", epoch, client, challenge) });
      const authorization = record(await io.read(2048));
      if (authorization.type !== "client") throw new PrivateControlError("malformed");
      verify(tag(secret, "client", epoch, client, challenge), authorization.proof);
      io.write({ type: "ready", proof: tag(secret, "ready", epoch, client, challenge) });
      const frame = record(await io.read());
      if (frame.type !== "request") throw new PrivateControlError("malformed");
      verify(tag(secret, "request", epoch, client, challenge, frame.body), frame.proof);
      clearTimeout(handshakeTimer);
      const response = await handler(frame.body, lifetime.signal);
      try {
        lifetime.signal.throwIfAborted();
        io.write({ type: "response", body: response, proof: tag(secret, "response", epoch, client, challenge, response) });
        await io.finish();
      } catch (error) { await onUndeliveredResponse?.(response, frame.body); throw error; }
      await afterResponse?.(response);
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Private control address unavailable");
  const staged = `${path}.${epoch}.tmp`;
  try {
    await writePrivateFile(staged, JSON.stringify({ version: 1, port: address.port, epoch, secret, pid: process.pid }));
    await link(staged, path);
  } catch (error) { for (const socket of sockets) socket.destroy(); server.close(); throw error; }
  finally { await unlink(staged).catch(() => undefined); }
  const identity = await lstat(path);
  const closed = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  return { socketPath: path, closed: closed.promise, close: (): Promise<void> => closing ??= (async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const current = await lstat(path).catch(() => undefined);
    if (current?.ino === identity.ino && current?.dev === identity.dev && (await readControlDiscovery(path)).epoch === epoch) await unlink(path);
    closed.resolve();
  })() };
}
