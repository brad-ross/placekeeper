import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  requestControl,
  startLaunchControlServer,
  type LaunchControlServer,
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

describe("macOS daemon runtime", () => {
  it("keeps app lifecycle, review authority, resources, and link construction on closed private lanes", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-macos-runtime-control-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({
      recoveryRoot,
      browserSourceRoot,
      webAssets: { root: assets },
      port: 0,
      browserSourceInspector: async () => ({ rewriteEligibility: { eligible: true }, importedItems: [] }),
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));

    const appInstanceId = "app_instance_1234";
    const helperId = "helper_instance_1234";
    const windowId = "window_instance_1234";
    const attemptId = "attempt_instance_1234";
    const exchange = (message: unknown) => requestControl(socketPath, {
      kind: "macos-runtime",
      appInstanceId,
      helperId,
      message,
    });
    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "register-app",
        appInstanceId,
        processId: process.pid,
        startIdentity: "start_identity_1234",
        buildIdentity: "build_identity_1234",
      },
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });

    const sourcePath = join(process.cwd(), "test/fixtures/pdfs/text-native.pdf");
    const bytes = await readFile(sourcePath);
    const admitted = await exchange({
      protocolVersion: 1,
      type: "admit",
      windowId,
      attemptId,
      requestId: "request_admit_1234",
      sourcePath,
    });
    expect(admitted).toMatchObject({
      kind: "macos-runtime",
      response: {
        type: "admitted",
        byteLength: bytes.byteLength,
        displayName: "text-native.pdf",
        projection: { scope: { launchSurface: "macos" } },
      },
    });
    expect(JSON.stringify(admitted)).not.toMatch(/sourceRootPath|canonicalLinkBase|credential|bindProof|capability/u);
    if (admitted.kind !== "macos-runtime" || admitted.response.type !== "admitted") {
      throw new Error("Expected macOS admission");
    }

    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "activity",
        appInstanceId,
        activeWindows: 1,
        bootstrappingWindows: 1,
      },
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });
    await expect(exchange({
      protocolVersion: 1,
      type: "activate",
      windowId,
      attemptId,
      requestId: "request_activate_1234",
      documentValidated: true,
    })).resolves.toMatchObject({ kind: "macos-runtime", response: { type: "active" } });
    await expect(exchange({
      protocolVersion: 1,
      type: "read-resource",
      windowId,
      attemptId,
      requestId: "request_resource_1234",
      resourceId: admitted.response.resourceId,
      generation: admitted.response.generation,
      role: "document",
      offset: 0,
      length: Math.min(bytes.byteLength, 65_536),
    })).resolves.toMatchObject({ kind: "macos-runtime", response: { type: "resource-bytes" } });
    await expect(exchange({
      protocolVersion: 1,
      type: "copy-link",
      windowId,
      attemptId,
      requestId: "request_link_1234",
      location: { kind: "page", page: 2 },
    })).resolves.toMatchObject({
      kind: "macos-runtime",
      response: { type: "placekeeper-link", link: expect.stringMatching(/^placekeeper:\/\//u) },
    });

    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: { protocolVersion: 1, type: "detach", appInstanceId, reason: "controlled-exit" },
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });
    expect(host.macosRuntime.activity()).toEqual({ helpers: 0, activeHelpers: 0, resources: 0 });
    expect(host.macosLifecycle.activity()).toEqual({ appInstances: 0, registeredWindows: 0, bootstrappingWindows: 0 });
  });

  it("rejects review authority before app registration and rejects cross-lane fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-macos-runtime-reject-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({ recoveryRoot, browserSourceRoot, webAssets: { root: assets }, port: 0 });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const sourcePath = join(process.cwd(), "test/fixtures/pdfs/text-native.pdf");

    await expect(requestControl(socketPath, {
      kind: "macos-runtime",
      appInstanceId: "app_instance_5678",
      helperId: "helper_instance_5678",
      message: {
        protocolVersion: 1,
        type: "admit",
        windowId: "window_instance_5678",
        attemptId: "attempt_instance_5678",
        requestId: "request_admit_5678",
        sourcePath,
      },
    })).resolves.toMatchObject({ kind: "macos-runtime", response: { type: "failure", code: "invalid" } });
    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "register-app",
        appInstanceId: "app_instance_5678",
        processId: process.pid,
        startIdentity: "start_identity_5678",
        buildIdentity: "build_identity_5678",
        sourcePath,
      },
    } as never)).resolves.toEqual({ kind: "error", reason: "invalid-request" });
  });
});
