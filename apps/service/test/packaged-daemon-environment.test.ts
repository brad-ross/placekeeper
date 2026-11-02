import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PackagedRuntimeManifest } from "../src/platform/runtime-layout.js";
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), inspect: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn }));
vi.mock("../src/host/launch-control.js", async original => ({ ...await original<typeof import("../src/host/launch-control.js")>(), inspectDaemonCompatibility: mocks.inspect }));
import { ensureServiceDaemonReady } from "../src/host/service-daemon.js";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
it("starts a selected packaged daemon with its verified PDFium asset and no inherited checkout lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pk-packaged-daemon-env-"));
  const nodePath = `node/bin/node${process.platform === "win32" ? ".exe" : ""}`;
  for (const folder of ["node/bin", "service", "web"]) await mkdir(join(root, folder), { recursive: true });
  for (const [path, content] of [[nodePath, "independent node"], ["service/main.js", "service"], ["web/pdfium.wasm", "trusted packaged wasm"]]) await writeFile(join(root, path!), content!);
  const manifest: PackagedRuntimeManifest = {
    schemaVersion: 1, target: { platform: process.platform, arch: process.arch }, daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64),
    node: { path: nodePath, sha256: hash("independent node"), version: "24" },
    service: { path: "service/main.js", sha256: hash("service"), version: "test" },
    webAssets: { path: "web", files: [{ path: "pdfium.wasm", sha256: hash("trusted packaged wasm") }] },
  };
  vi.stubEnv("PLACEKEEPER_PDFIUM_WASM", "/checkout/stale-reader/pdfium.wasm");
  let environment: NodeJS.ProcessEnv = {};
  mocks.spawn.mockImplementation((_command, _args, options) => {
    environment = options.env as NodeJS.ProcessEnv;
    const child = Object.assign(new EventEmitter(), { pid: 43210, exitCode: null, signalCode: null, unref() {}, kill() {} });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  mocks.inspect.mockImplementation(async () => ({ kind: "exact", status: {
    protocolVersion: 1, daemonIdentity: manifest.daemonIdentity, readinessToken: environment.PLACEKEEPER_READINESS_TOKEN,
    lifecycle: "accepting", activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 },
  } }));
  await ensureServiceDaemonReady({ appSupportRoot: root, recoveryRoot: join(root, "recovery"), socketPath: join(root, "control.sock"),
    isolatedTestRoot: root, httpPort: 43123, webAssetsRoot: join(root, "web"), packagedRuntime: { root, manifest, expectedIdentity: manifest } }, "isolated-test-lease");
  expect(environment.PLACEKEEPER_PDFIUM_WASM).toBe(await realpath(join(root, "web/pdfium.wasm")));
  expect(mocks.spawn).toHaveBeenCalledWith(await realpath(join(root, nodePath)), expect.arrayContaining(["daemon", "--isolated-test-root", root]), expect.any(Object));
});
