import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { startPrivateControlServer, requestPrivateControl } from "../src/platform/control-transport.js";
import { establishPrivateDirectory, readPrivateFile } from "../src/platform/private-storage.js";
import { createConnection, createServer, type Socket } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { writePrivateFile } from "../src/platform/private-storage.js";
import { rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const roots: string[] = [];
async function privateTemp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pk-control-"));
  await establishPrivateDirectory(root);
  roots.push(root);
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("authenticates both endpoints before dispatch and binds the response", async () => {
  const root = await privateTemp();
  const path = join(root, "control");
  const server = await startPrivateControlServer(path, async (request) => ({ received: request }));
  try { expect(await requestPrivateControl(path, { kind: "test" })).toEqual({ received: { kind: "test" } }); }
  finally { await server.close(); }
});
it.skipIf(process.platform === "win32")("refuses exposed discovery credentials", async () => {
  const root = await privateTemp();
  const path = join(root, "control");
  const server = await startPrivateControlServer(path, async () => ({}));
  try { await chmod(path, 0o644); await expect(readPrivateFile(path, 4096)).rejects.toThrow("unsafe"); }
  finally { await chmod(path, 0o600); await server.close(); }
});

function line(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.on("data", (data: Buffer) => { text += data.toString(); if (text.includes("\n")) resolve(JSON.parse(text.slice(0, text.indexOf("\n")))); });
    socket.once("error", reject);
    socket.once("end", () => reject(new Error("closed")));
  });
}
const hmac = (secret: string, ...parts: unknown[]): string => createHmac("sha256", Buffer.from(secret, "hex")).update(JSON.stringify(parts)).digest("hex");
it("does not disclose a request to an impersonating server", async () => {
  const root = await privateTemp();
  const path = join(root, "control"); let received = "";
  const fake = createServer((socket) => {
    socket.on("data", (data: Buffer) => {
      received += data.toString();
      socket.write(`${JSON.stringify({ type: "server", epoch, challenge: "b".repeat(64), proof: "0".repeat(64) })}\n`);
    });
  });
  const epoch = "a".repeat(64);
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const address = fake.address() as { port: number };
  await writePrivateFile(path, JSON.stringify({ version: 1, port: address.port, epoch, secret: "c".repeat(64), pid: process.pid }));
  try {
    await expect(requestPrivateControl(path, { privileged: "never-send" })).rejects.toThrow("malformed");
    expect(received).not.toContain("never-send");
    expect(received).not.toContain("request");
  } finally { await new Promise<void>((resolve) => fake.close(() => resolve())); }
});
it("rejects request tampering and replay on a fresh connection", async () => {
  const root = await privateTemp();
  const path = join(root, "control"); let dispatched = 0;
  const server = await startPrivateControlServer(path, async () => { dispatched++; return {}; });
  const discovery = JSON.parse((await readPrivateFile(path, 2048)).toString());
  const client = randomBytes(32).toString("hex");
  const socket = createConnection(discovery.port, "127.0.0.1");
  const hello = line(socket); socket.write(`${JSON.stringify({ type: "hello", client })}\n`);
  const challenge = await hello;
  const authenticated = line(socket);
  socket.write(`${JSON.stringify({ type: "client", proof: hmac(discovery.secret, "client", discovery.epoch, client, challenge.challenge) })}\n`);
  await authenticated;
  const body = { kind: "first" };
  const proof = hmac(discovery.secret, "request", discovery.epoch, client, challenge.challenge, body);
  const ended = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write(`${JSON.stringify({ type: "request", body: { kind: "tampered" }, proof })}\n`);
  await ended;
  const replay = createConnection(discovery.port, "127.0.0.1");
  const helloAgain = line(replay); replay.write(`${JSON.stringify({ type: "hello", client })}\n`);
  const next = await helloAgain; expect(next.challenge).not.toEqual(challenge.challenge);
  const authenticatedAgain = line(replay);
  replay.write(`${JSON.stringify({ type: "client", proof: hmac(discovery.secret, "client", discovery.epoch, client, next.challenge) })}\n`);
  await authenticatedAgain;
  const replayEnded = new Promise<void>((resolve) => replay.once("close", () => resolve()));
  replay.write(`${JSON.stringify({ type: "request", body, proof })}\n`);
  await replayEnded;
  expect(dispatched).toBe(0);
  await server.close();
});

it("concurrent publication fails without replacing the live authority", async () => {
  const root = await privateTemp();
  const path = join(root, "control");
  const first = await startPrivateControlServer(path, async () => ({ owner: "first" }));
  try {
    await expect(startPrivateControlServer(path, async () => ({ owner: "second" }))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await requestPrivateControl(path, {})).toEqual({ owner: "first" });
  } finally { await first.close(); }
});
it("retiring a previous server does not unlink a successor discovery file", async () => {
  const root = await privateTemp();
  const path = join(root, "control");
  const first = await startPrivateControlServer(path, async () => ({}));
  await rename(path, join(root, "retired"));
  const second = await startPrivateControlServer(path, async () => ({ owner: "successor" }));
  try { await first.close(); expect(await requestPrivateControl(path, {})).toEqual({ owner: "successor" }); }
  finally { await second.close(); }
});
it.runIf(process.platform === "win32")("verifies actual Windows DACLs and refuses an Everyone read grant", async () => {
  const root = await privateTemp();
  const { ensurePrivateDirectory } = await import("../src/platform/private-storage.js");
  const privateRoot = join(root, "private"); await ensurePrivateDirectory(privateRoot);
  const path = join(privateRoot, "credential"); await writePrivateFile(path, "secret");
  expect((await readPrivateFile(path, 128)).toString()).toBe("secret");
  await promisify(execFile)(join(process.env.SystemRoot!, "System32", "icacls.exe"), [path, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
  await expect(readPrivateFile(path, 128)).rejects.toThrow();
});
it("refuses stale discovery epochs before sending the operation", async () => {
  const root = await privateTemp(); const path = join(root, "control"); let dispatched = 0;
  const server = await startPrivateControlServer(path, async () => { dispatched++; return {}; });
  const original = await readPrivateFile(path, 2048);
  const discovery = JSON.parse(original.toString());
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(path, JSON.stringify({ ...discovery, epoch: "0".repeat(64) }));
    await expect(requestPrivateControl(path, { privileged: true })).rejects.toThrow("malformed");
    expect(dispatched).toBe(0);
  } finally { await writeFile(path, original); await server.close(); }
});
it("rejects an unauthenticated operation without dispatch", async () => {
  const root = await privateTemp(); const path = join(root, "control"); let dispatched = 0;
  const server = await startPrivateControlServer(path, async () => { dispatched++; return {}; });
  const discovery = JSON.parse((await readPrivateFile(path, 2048)).toString());
  const socket = createConnection(discovery.port, "127.0.0.1");
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write(`${JSON.stringify({ type: "request", body: { privileged: true }, proof: "0".repeat(64) })}\n`);
  await closed; expect(dispatched).toBe(0); await server.close();
});
it("closes an oversized unauthenticated handshake without dispatch", async () => {
  const root = await privateTemp(); const path = join(root, "control"); let dispatched = 0;
  const server = await startPrivateControlServer(path, async () => { dispatched++; return {}; });
  const discovery = JSON.parse((await readPrivateFile(path, 2048)).toString());
  const socket = createConnection(discovery.port, "127.0.0.1");
  socket.on("error", () => {});
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write(Buffer.alloc(2049, 65)); await closed;
  expect(dispatched).toBe(0); await server.close();
});
it("bounds pending unauthenticated connections and closes them at retirement", async () => {
  const root = await privateTemp(); const path = join(root, "control");
  const server = await startPrivateControlServer(path, async () => ({}));
  const discovery = JSON.parse((await readPrivateFile(path, 2048)).toString());
  const sockets: Socket[] = [];
  try {
    for (let index = 0; index < 32; index++) {
      const socket = createConnection(discovery.port, "127.0.0.1"); sockets.push(socket);
      const hello = line(socket); socket.write(`${JSON.stringify({ type: "hello", client: randomBytes(32).toString("hex") })}\n`);
      expect((await hello).type).toBe("server");
    }
    const extra = createConnection(discovery.port, "127.0.0.1");
    await new Promise<void>((resolve) => extra.once("close", () => resolve()));
    const retired = sockets.map((socket) => new Promise<void>((resolve) => socket.once("close", () => resolve())));
    await server.close(); await Promise.all(retired);
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
  } finally { sockets.forEach((socket) => socket.destroy()); await server.close(); }
});
it("accepts a fragmented authenticated request above the handshake limit", async () => {
  const root = await privateTemp(); const path = join(root, "control");
  const server = await startPrivateControlServer(path, async (request) => request);
  try { const body = { text: "payload".repeat(8192) }; expect(await requestPrivateControl(path, body)).toEqual(body); }
  finally { await server.close(); }
});
