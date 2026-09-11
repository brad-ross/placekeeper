import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestControl,
  startLaunchControlServer,
  type LaunchControlServer,
  type PlacekeeperControlRequest,
} from "../src/host/launch-control.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";

const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];
const controls: LaunchControlServer[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Chrome daemon handoff", () => {
  it("offers the existing protected draft when Chrome re-verifies the same remote source after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-recovery-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const start = () => PlacekeeperHost.start({
      recoveryRoot, browserSourceRoot, webAssets: { root: assets }, port: 0,
      browserSourceInspector: async () => ({ rewriteEligibility: { eligible: true } as const, importedItems: [] }),
    });
    let host = await start();
    hosts.push(host);
    const sourceIdentity = createHash("sha256").update("https://papers.example.test/protected.pdf").digest("hex");
    const bytes = Buffer.from("%PDF-1.7\nprotected remote\n%%EOF");
    const open = async (current: PlacekeeperHost) => {
      const sourceHandle = randomBytes(24).toString("base64url");
      await writeFile(join(browserSourceRoot, `${sourceHandle}.pdf`), bytes, { mode: 0o600 });
      return current.broker.openChromeBrowserSource({
        protocolVersion: 2,
        sourceHandle,
        sourceIdentity,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        displayName: "Protected.pdf",
      }, current.browserSources);
    };
    const opened = await open(host);
    if (opened.kind === "recovery-offered") throw new Error("Expected a new Chrome review");
    await host.broker.acceptMutation(opened.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: {
        id: randomUUID(),
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-09-03T00:00:00.000Z",
        updatedAt: "2026-09-03T00:00:00.000Z",
        payload: { position: { x: 1, y: 1, width: 18, height: 18 }, comment: "Keep me" },
      },
    });
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    host = await start();
    hosts.push(host);
    const offered = await open(host);
    expect(offered).toMatchObject({
      kind: "recovery-offered",
      choices: ["resume", "discard", "fork"],
    });
    if (offered.kind !== "recovery-offered") throw new Error("Expected protected recovery");
    const resumed = await host.broker.openReview({
      pdfPath: join(recoveryRoot, offered.recoverySessionId, "source.pdf"),
      surface: "chrome",
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: "recovery-operation-remote-0001",
    });
    if (resumed.kind === "recovery-offered") throw new Error("Expected resumed review");
    expect(host.broker.state(resumed.launch.sessionId)?.items).toHaveLength(1);
    expect(await host.broker.sessionScope(resumed.launch.sessionId)).toMatchObject({
      sourceDisposition: "remote-temporary",
    });
  });

  it("joins v2 acquisitions only when normalized source identity and verified digest both match", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-canonical-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({
      recoveryRoot, browserSourceRoot, webAssets: { root: assets }, port: 0,
      browserSourceInspector: async () => ({ rewriteEligibility: { eligible: true }, importedItems: [] }),
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const sourceIdentity = createHash("sha256").update("https://papers.example.test/paper.pdf").digest("hex");
    const open = async (bytes: Buffer) => {
      const sourceHandle = randomBytes(24).toString("base64url");
      await writeFile(join(browserSourceRoot, `${sourceHandle}.pdf`), bytes, { mode: 0o600 });
      return requestControl(socketPath, {
        kind: "chrome-open",
        request: {
          protocolVersion: 2, sourceHandle, sourceIdentity,
          byteLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          displayName: "Canonical.pdf",
        },
      });
    };
    const bytes = Buffer.from("%PDF-1.7\ncanonical\n%%EOF");
    const first = await open(bytes);
    const duplicate = await open(bytes);
    const changed = await open(Buffer.from("%PDF-1.7\nchanged\n%%EOF"));
    expect(first).toMatchObject({ kind: "chrome-open", response: { ok: true, kind: "opened" } });
    expect(duplicate).toMatchObject({ kind: "chrome-open", response: { ok: true, kind: "focused" } });
    expect(changed).toMatchObject({ kind: "chrome-open", response: { ok: true, kind: "opened" } });
    if (first.kind !== "chrome-open" || duplicate.kind !== "chrome-open" || changed.kind !== "chrome-open" ||
      !first.response.ok || !duplicate.response.ok || !changed.response.ok ||
      first.response.kind === "recovery-offered" || duplicate.response.kind === "recovery-offered" || changed.response.kind === "recovery-offered") throw new Error("Expected Chrome opens");
    expect(duplicate.response.sessionId).toBe(first.response.sessionId);
    expect(changed.response.sessionId).not.toBe(first.response.sessionId);
  });

  it("runs negotiated acquisition, activation, and bounded resources inside daemon authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-runtime-control-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({
      recoveryRoot, browserSourceRoot, webAssets: { root: assets }, port: 0,
      browserSourceInspector: async () => ({ rewriteEligibility: { eligible: true }, importedItems: [] }),
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const portId = "runtime-control-port-1";
    const connectionId = "runtime-control-connection-1";
    const exchange = (message: unknown) => requestControl(socketPath, { kind: "chrome-runtime", portId, message });
    await expect(exchange({ type: "hello", reviewRuntimeVersion: 2, protocol: "placekeeper.chrome-runtime", protocolVersion: 2, connectionId }))
      .resolves.toMatchObject({ kind: "chrome-runtime", messages: [{ type: "hello-ack" }] });
    await exchange({ type: "begin", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-acquire-1", transferId: "transfer-runtime-1", disposition: "remote-temporary", sourceUrl: "https://papers.example.test/runtime.pdf", displayName: "Runtime.pdf" });
    const bytes = await readFile(join(process.cwd(), "test/fixtures/pdfs/text-native.pdf"));
    await exchange({ type: "chunk", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-chunk-1", transferId: "transfer-runtime-1", sequence: 0, data: bytes.toString("base64") });
    const staged = await exchange({ type: "finish", lane: "acquisition", protocolVersion: 2, connectionId, requestId: "request-finish-1", transferId: "transfer-runtime-1", sequence: 1 });
    expect(staged).toMatchObject({ kind: "chrome-runtime", messages: [{ type: "projection", payload: { document: { byteLength: bytes.byteLength } } }] });
    expect(JSON.stringify(staged)).not.toMatch(/credential|sourceUrl|presentationId|taskId|bindProof/u);
    await expect(exchange({ type: "activate", lane: "lifecycle", protocolVersion: 2, connectionId, requestId: "request-activate-1", documentValidated: true }))
      .resolves.toMatchObject({ kind: "chrome-runtime", messages: [{ type: "active" }] });
    await expect(exchange({ type: "read", lane: "resource", protocolVersion: 2, connectionId, requestId: "request-resource-1", resource: "document", generation: 1, offset: 0, length: 8 }))
      .resolves.toMatchObject({ kind: "chrome-runtime", messages: [{ type: "resource-chunk", sequence: 0 }] });
    await expect(requestControl(socketPath, { kind: "chrome-runtime-detach", portId }))
      .resolves.toEqual({ kind: "chrome-runtime-detached" });
  });

  it("admits only the fixed opaque request and transfers ownership without a path", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-daemon-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const bytes = Buffer.from("%PDF-1.7\ndaemon handoff\n%%EOF");
    const sourceHandle = randomBytes(24).toString("base64url");
    const sealedPath = join(browserSourceRoot, `${sourceHandle}.pdf`);
    await writeFile(sealedPath, bytes, { mode: 0o600 });
    const request = {
      protocolVersion: 1 as const,
      sourceHandle,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      displayName: "Daemon.pdf",
    };
    const host = await PlacekeeperHost.start({
      recoveryRoot,
      browserSourceRoot,
      webAssets: { root: assets },
      port: 0,
      browserSourceInspector: async () => ({
        rewriteEligibility: { eligible: true },
        importedItems: [],
      }),
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));

    const response = await requestControl(socketPath, { kind: "chrome-open", request });
    expect(response).toMatchObject({
      kind: "chrome-open",
      response: { ok: true, kind: "opened" },
    });
    if (response.kind !== "chrome-open" || !response.response.ok ||
      response.response.kind === "recovery-offered") throw new Error("Expected open");
    expect("bindProof" in response.response).toBe(false);
    expect(await host.broker.sessionScope(response.response.sessionId)).toMatchObject({
      sourceDisposition: "remote-temporary",
      sourceDisplayName: "Daemon.pdf",
    });
    await expect(access(sealedPath)).rejects.toMatchObject({ code: "ENOENT" });

    const malformed = {
      kind: "chrome-open",
      request: { ...request, pdfPath: "/private/forbidden.pdf" },
    } as unknown as PlacekeeperControlRequest;
    await expect(requestControl(socketPath, malformed)).resolves.toEqual({
      kind: "error",
      reason: "invalid-request",
    });
  });

  it("cancels inspection and removes adopted bytes when the native client disconnects", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-cancel-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const bytes = Buffer.from("%PDF-1.7\ncancelled daemon handoff\n%%EOF");
    const sourceHandle = randomBytes(24).toString("base64url");
    await writeFile(join(browserSourceRoot, `${sourceHandle}.pdf`), bytes, { mode: 0o600 });
    const inspectionStarted = Promise.withResolvers<void>();
    const host = await PlacekeeperHost.start({
      recoveryRoot,
      browserSourceRoot,
      webAssets: { root: assets },
      port: 0,
      browserSourceInspector: async (_path, signal) => {
        inspectionStarted.resolve();
        return new Promise((_resolveInspection, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const controller = new AbortController();
    const response = requestControl(socketPath, {
      kind: "chrome-open",
      request: {
        protocolVersion: 1,
        sourceHandle,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    }, { signal: controller.signal });
    await inspectionStarted.promise;
    controller.abort(new Error("native-host-timeout"));

    await expect(response).rejects.toThrow("native-host-timeout");
    await expect.poll(async () => {
      const entries = await import("node:fs/promises").then(({ readdir }) => readdir(recoveryRoot));
      return entries.filter((name) => !name.startsWith(".")).length;
    }).toBe(0);
  });

  it("rolls back a newly opened local browser review when its reply is not delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-local-cancel-"));
    roots.push(root);
    const socketPath = join(root, "control.sock");
    const openStarted = Promise.withResolvers<void>();
    const finishOpen = Promise.withResolvers<void>();
    const discard = vi.fn(async () => undefined);
    const host = {
      broker: { discard },
      open: async () => {
        openStarted.resolve();
        await finishOpen.promise;
        return {
          ok: true as const,
          kind: "opened" as const,
          url: "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
          sessionId: "779e1d9d-58c1-4b12-8dc2-3449dad132c1",
          documentGeneration: 1,
        };
      },
    } as unknown as PlacekeeperHost;
    controls.push(await startLaunchControlServer(host, socketPath));
    const controller = new AbortController();
    const response = requestControl(socketPath, {
      kind: "launch",
      request: { pdfPath: "/private/local.pdf", surface: "browser" },
    }, { signal: controller.signal });
    await openStarted.promise;
    controller.abort(new Error("bypassed"));
    finishOpen.resolve();

    await expect(response).rejects.toThrow("bypassed");
    await vi.waitFor(() => expect(discard).toHaveBeenCalledExactlyOnceWith(
      "779e1d9d-58c1-4b12-8dc2-3449dad132c1",
    ));
  });
});
