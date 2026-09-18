import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
  it("recovers one local Chrome draft and terminal receipt only for the same tab secret across daemon restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-owner-recovery-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    const pdf = join(root, "Owner recovery.pdf");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(pdf, "%PDF-1.7\nowner recovery\n%%EOF");
    const start = () => PlacekeeperHost.start({
      recoveryRoot, browserSourceRoot, webAssets: { root: assets }, port: 0,
      browserSourceInspector: async () => ({ rewriteEligibility: { eligible: true } as const, importedItems: [] }),
    });
    const secret = "s".repeat(43);
    const otherSecret = "o".repeat(43);
    const exchange = async (host: PlacekeeperHost, portId: string, message: Record<string, unknown>) =>
      host.chromeRuntime.handle(portId, message);
    const open = async (
      host: PlacekeeperHost,
      portId: string,
      connectionId: string,
      interactionOwnerSecret: string,
      recoveryOperationId: string,
    ) => {
      await exchange(host, portId, {
        type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime",
        protocolVersion: 2, connectionId,
      });
      const base = { protocolVersion: 2, connectionId };
      await exchange(host, portId, {
        ...base, type: "claim-owner", lane: "lifecycle", requestId: `claim-${connectionId}`,
        interactionOwnerSecret,
      });
      const transferId = `transfer-${connectionId}`;
      await exchange(host, portId, {
        ...base, type: "begin", lane: "acquisition", requestId: `begin-${connectionId}`,
        transferId, disposition: "local", fileUrl: pathToFileURL(pdf).href,
      });
      let result = await exchange(host, portId, {
        ...base, type: "finish", lane: "acquisition", requestId: `finish-${connectionId}`,
        transferId, sequence: 0,
      });
      const offered = result[0];
      if (offered?.type === "recovery-offered") {
        result = await exchange(host, portId, {
          ...base, type: "recover", lane: "lifecycle", requestId: `recover-${connectionId}`,
          decision: "resume", offer: offered.offer, idempotencyKey: recoveryOperationId,
        });
      }
      const staged = result[0];
      if (staged?.type !== "projection") throw new Error("Expected staged Chrome projection");
      await exchange(host, portId, {
        ...base, type: "activate", lane: "lifecycle", requestId: `activate-${connectionId}`,
        documentValidated: true,
      });
      return {
        generation: (staged.payload as { generation: number }).generation,
        revision: (staged.payload as { revision: number }).revision,
      };
    };
    const invoke = async (
      host: PlacekeeperHost,
      portId: string,
      connectionId: string,
      generation: number,
      revision: number,
      method: string,
      payload: Record<string, unknown>,
      operation: string,
    ) => (await exchange(host, portId, {
      type: "invoke", lane: "runtime", protocolVersion: 2, connectionId,
      requestId: `request-${operation}`, generation, revision, method, payload,
      idempotencyKey: `operation-${operation}`,
    }))[0];

    let host = await start();
    hosts.push(host);
    const first = await open(host, "owner-port-before-restart", "owner-connection-before", secret, "recovery-owner-before-0001");
    const begun = await invoke(host, "owner-port-before-restart", "owner-connection-before",
      first.generation, first.revision, "beginInteraction",
      { interactionToken: "interaction-owner-restart", order: 1, generation: 1 }, "owner-begin-before");
    if (begun?.type !== "result") throw new Error("Expected Chrome interaction admission");
    const ownerViewId = (begun.payload as { ownerViewId: string }).ownerViewId;
    const draftId = "00000000-0000-4000-8000-000000000888";
    const command = await invoke(host, "owner-port-before-restart", "owner-connection-before",
      1, 0, "command", {
        type: "put-draft", expectedRevision: 0, expectedDraftRevision: -1,
        draft: {
          id: draftId, ownerViewId, baseGeneration: 1, revision: 0, kind: "highlight",
          pageIndex: 0, text: "Chrome restart draft",
          anchor: { kind: "selection", pageIndex: 0, quote: "owner", prefix: "", suffix: "",
            rect: { x: 1, y: 1, width: 5, height: 5 }, segmentRects: [{ x: 1, y: 1, width: 5, height: 5 }] },
          disposition: { kind: "resolved", generation: 1 }, status: "protected",
          createdAt: "2026-09-16T00:00:00.000Z", updatedAt: "2026-09-16T00:00:00.000Z",
        },
      }, "owner-put-draft");
    expect(command).toMatchObject({ type: "result", payload: { revision: 1 } });
    await host.chromeRuntime.detach("owner-port-before-restart");
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    host = await start();
    hosts.push(host);
    const resumed = await open(host, "owner-port-after-restart", "owner-connection-after", secret, "recovery-owner-after-0001");
    const unrelated = await open(host, "other-port-after-restart", "other-connection-after", otherSecret, "recovery-other-after-0001");
    await invoke(host, "other-port-after-restart", "other-connection-after",
      unrelated.generation, unrelated.revision, "beginInteraction",
      { interactionToken: "interaction-other-restart", order: 1, generation: 1 }, "other-begin-after");
    expect(await invoke(host, "other-port-after-restart", "other-connection-after",
      1, 1, "finalizeInteraction", {
        interactionToken: "interaction-other-restart", order: 2, outcome: "applied",
        draftId, expectedDraftRevision: 0,
      }, "other-finalize-after")).toMatchObject({ type: "failure", reason: "operation-rejected" });

    await invoke(host, "owner-port-after-restart", "owner-connection-after",
      resumed.generation, resumed.revision, "beginInteraction",
      { interactionToken: "interaction-owner-restart", order: 1, generation: 1 }, "owner-begin-after");
    const receipt = await invoke(host, "owner-port-after-restart", "owner-connection-after",
      1, 1, "finalizeInteraction", {
        interactionToken: "interaction-owner-restart", order: 2, outcome: "applied",
        draftId, expectedDraftRevision: 0,
      }, "owner-finalize-after");
    expect(receipt).toMatchObject({ type: "result", payload: { status: "finalized", reviewRevision: 2 } });
    await host.chromeRuntime.detach("owner-port-after-restart");
    await host.chromeRuntime.detach("other-port-after-restart");
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);

    host = await start();
    hosts.push(host);
    const replayed = await open(host, "owner-port-replay", "owner-connection-replay", secret, "recovery-owner-replay-0001");
    expect(await invoke(host, "owner-port-replay", "owner-connection-replay",
      replayed.generation, replayed.revision, "finalizeInteraction", {
        interactionToken: "interaction-owner-restart", order: 1, outcome: "applied",
        draftId, expectedDraftRevision: 0,
      }, "owner-finalize-replay")).toMatchObject({
      type: "result", payload: { status: "finalized", reviewRevision: 2 },
    });
    expect(await invoke(host, "owner-port-replay", "owner-connection-replay",
      replayed.generation, replayed.revision, "acknowledgeInteraction",
      { interactionToken: "interaction-owner-restart", order: 2 }, "owner-ack-replay"))
      .toMatchObject({ type: "result", payload: { status: "released" } });
  });

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
    await expect(exchange({ type: "hello", reviewRuntimeVersion: 3, protocol: "placekeeper.chrome-runtime", protocolVersion: 2, connectionId }))
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
