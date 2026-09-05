import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";

import {
  requestControl,
  startLaunchControlServer,
  type LaunchControlServer,
} from "../src/host/launch-control.js";
import { PlacekeeperHost } from "../src/host/placekeeper-host.js";
import { macosRuntimeThroughDaemon } from "../src/host/service-daemon.js";

const roots: string[] = [];
const hosts: PlacekeeperHost[] = [];
const controls: LaunchControlServer[] = [];

afterEach(async () => {
  await Promise.all(controls.splice(0).map((control) => control.close()));
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("macOS daemon runtime", () => {
  it("attaches a first-use link helper and authoritatively retires it", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-macos-link-runtime-"));
    roots.push(root);
    const recoveryRoot = join(root, "recovery");
    const browserSourceRoot = join(root, "browser-sources");
    const assets = join(root, "assets");
    const sourcePath = join(root, "linked.pdf");
    await Promise.all([mkdir(browserSourceRoot), mkdir(assets)]);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    await writeFile(sourcePath, "%PDF-1.7\nlinked review\n%%EOF");
    const host = await PlacekeeperHost.start({
      recoveryRoot,
      browserSourceRoot,
      webAssets: { root: assets },
      port: 0,
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));

    const appInstanceId = "app_instance_link_1234";
    const helperId = "helper_instance_link_1234";
    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "register-app",
        appInstanceId,
        processId: process.pid,
        startIdentity: "start_identity_link_1234",
        buildIdentity: "build_identity_link_1234",
      },
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });

    const response = await macosRuntimeThroughDaemon(appInstanceId, helperId, {
      protocolVersion: 1,
      type: "admit-link",
      windowId: "window_instance_link_1234",
      attemptId: "attempt_instance_link_1234",
      requestId: "request_admit_link_1234",
      link: encodePlacekeeperLink({ path: sourcePath, location: { kind: "page", page: 7 } }),
      confirmed: true,
    }, undefined, {
      appSupportRoot: root,
      recoveryRoot,
      socketPath,
      webAssetsRoot: assets,
      httpPort: 0,
      lifecycleLockPath: join(root, "lifecycle.lock"),
    });

    expect(response).toMatchObject({
      type: "admitted",
      displayName: "linked.pdf",
      projection: { location: { kind: "page", page: 7 } },
    });
    expect(host.macosLifecycle.ownsHelper(appInstanceId, helperId)).toBe(true);

    const detachHelper = {
      protocolVersion: 1 as const,
      type: "detach-helper" as const,
      appInstanceId,
      helperId,
    };
    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: detachHelper,
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });
    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: detachHelper,
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });
    expect(host.macosLifecycle.ownsHelper(appInstanceId, helperId)).toBe(false);
    expect(host.macosRuntime.activity()).toEqual({ helpers: 0, activeHelpers: 0, resources: 0 });
    await expect(requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "activity",
        appInstanceId,
        activeWindows: 0,
        bootstrappingWindows: 0,
      },
    })).resolves.toMatchObject({ kind: "macos-app-control", response: { type: "ack" } });

    await expect(requestControl(socketPath, {
      kind: "macos-runtime",
      appInstanceId,
      helperId,
      message: {
        protocolVersion: 1,
        type: "admit",
        windowId: "window_instance_link_5678",
        attemptId: "attempt_instance_link_5678",
        requestId: "request_admit_link_5678",
        sourcePath,
      },
    })).resolves.toMatchObject({ kind: "macos-runtime", response: { type: "failure", code: "invalid" } });
  });

  it("reconciles an admission that completes after lifecycle detachment", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-macos-detach-race-"));
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
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const appInstanceId = "app_instance_race_1234";
    const helperId = "helper_instance_race_1234";
    await requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "register-app",
        appInstanceId,
        processId: process.pid,
        startIdentity: "start_identity_race_1234",
        buildIdentity: "build_identity_race_1234",
      },
    });

    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const handle = host.macosRuntime.handle.bind(host.macosRuntime);
    vi.spyOn(host.macosRuntime, "handle").mockImplementation(async (...args) => {
      entered.resolve();
      await resume.promise;
      return handle(...args);
    });
    const admission = requestControl(socketPath, {
      kind: "macos-runtime",
      appInstanceId,
      helperId,
      message: {
        protocolVersion: 1,
        type: "admit",
        windowId: "window_instance_race_1234",
        attemptId: "attempt_instance_race_1234",
        requestId: "request_admit_race_1234",
        sourcePath: join(process.cwd(), "test/fixtures/pdfs/text-native.pdf"),
      },
    });
    await entered.promise;
    await requestControl(socketPath, {
      kind: "macos-app-control",
      message: { protocolVersion: 1, type: "detach-helper", appInstanceId, helperId },
    });
    resume.resolve();

    await expect(admission).resolves.toMatchObject({
      kind: "macos-runtime",
      response: { type: "failure", code: "unavailable" },
    });
    expect(host.macosLifecycle.ownsHelper(appInstanceId, helperId)).toBe(false);
    expect(host.macosRuntime.activity()).toEqual({ helpers: 0, activeHelpers: 0, resources: 0 });
  });

  it("releases first-use link ownership when daemon admission fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-macos-link-failure-"));
    roots.push(root);
    const assets = join(root, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "app.js"), "export function start(){}\n");
    const host = await PlacekeeperHost.start({
      recoveryRoot: join(root, "recovery"),
      browserSourceRoot: join(root, "browser-sources"),
      webAssets: { root: assets },
      port: 0,
    });
    hosts.push(host);
    const socketPath = join(root, "control.sock");
    controls.push(await startLaunchControlServer(host, socketPath));
    const appInstanceId = "app_instance_missing_1234";
    const helperId = "helper_instance_missing_1234";
    await requestControl(socketPath, {
      kind: "macos-app-control",
      message: {
        protocolVersion: 1,
        type: "register-app",
        appInstanceId,
        processId: process.pid,
        startIdentity: "start_identity_missing_1234",
        buildIdentity: "build_identity_missing_1234",
      },
    });

    await expect(requestControl(socketPath, {
      kind: "macos-runtime",
      appInstanceId,
      helperId,
      message: {
        protocolVersion: 1,
        type: "admit-link",
        windowId: "window_instance_missing_1234",
        attemptId: "attempt_instance_missing_1234",
        requestId: "request_admit_missing_1234",
        link: encodePlacekeeperLink({ path: join(root, "missing.pdf"), location: { kind: "page", page: 1 } }),
        confirmed: true,
      },
    })).resolves.toMatchObject({ kind: "macos-runtime", response: { type: "failure" } });
    expect(host.macosLifecycle.ownsHelper(appInstanceId, helperId)).toBe(false);
  });

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
