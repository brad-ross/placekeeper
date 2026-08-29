import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
