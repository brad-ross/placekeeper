import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureServiceDaemonReady } from "../src/host/service-daemon.js";
import { resolvePlatformLocations, subprocessEnvironment } from "../src/platform/locations.js";
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from "../src/platform/runtime-layout.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("canonical platform locations", () => {
  it("preserves the Mac recovery root and separates window preferences", () => {
    const paths = resolvePlatformLocations({ platform: "darwin", homeDirectory: "/Users/brad", env: {} });
    expect(paths.recoveryRoot).toBe("/Users/brad/Library/Application Support/Placekeeper/recovery");
    expect(paths.windowPreferencesRoot).toBe("/Users/brad/Library/Application Support/Placekeeper/electron");
  });
  it("retains Windows drive paths, Unicode, and spaces", () => {
    const paths = resolvePlatformLocations({ platform: "win32", homeDirectory: "C:\\Users\\Brád Ross", env: { LOCALAPPDATA: "D:\\Local Data\\Brád" } });
    expect(paths.appSupportRoot).toBe("D:\\Local Data\\Brád\\Placekeeper");
    expect(paths.recoveryRoot).toBe("D:\\Local Data\\Brád\\Placekeeper\\recovery");
  });
  it("uses absolute XDG state overrides and ignores relative overrides", () => {
    expect(resolvePlatformLocations({ platform: "linux", homeDirectory: "/home/brad", env: { XDG_STATE_HOME: "/state/custom" } }).recoveryRoot).toBe("/state/custom/placekeeper/recovery");
    expect(resolvePlatformLocations({ platform: "linux", homeDirectory: "/home/brad", env: { XDG_STATE_HOME: "relative" } }).appSupportRoot).toBe("/home/brad/.local/state/placekeeper");
  });
  it("preserves required Windows subprocess variables with a single PATH key", () => {
    expect(subprocessEnvironment("win32", { Path: "C:\\TeX bin;D:\\Tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", SECRET: "not inherited" })).toEqual({ PATH: "C:\\TeX bin;D:\\Tools", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", LC_ALL: "C", LANG: "C" });
  });
});

describe("independent packaged runtime", () => {
  async function fixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "placekeeper-runtime-"))); roots.push(root);
    await Promise.all([mkdir(join(root, "web")), mkdir(join(root, "service"))]);
    const digest = createHash("sha256").update("payload").digest("hex");
    await Promise.all(["node", "service/main.js", "web/index.html"].map((path) => writeFile(join(root, path), "payload")));
    const manifest: PackagedRuntimeManifest = {
      schemaVersion: 1, target: { platform: process.platform, arch: process.arch },
      node: { path: "node", version: "24.14.0", sha256: digest },
      service: { path: "service/main.js", version: "1", sha256: digest },
      webAssets: { path: "web", files: [{ path: "index.html", sha256: digest }] },
      daemonIdentity: "a".repeat(64), installArtifactIdentity: "b".repeat(64),
    };
    return { root, manifest };
  }
  it("resolves only the manifest's bundled Node, service, and verified served assets", async () => {
    const { root, manifest } = await fixture();
    await expect(resolvePackagedRuntime(root, manifest, manifest)).resolves.toMatchObject({ nodeExecutable: join(root, "node"), serviceEntry: join(root, "service/main.js"), webAssetsRoot: join(root, "web") });
  });
  it.each(["node", "service/main.js", "web/index.html"])("rejects missing or altered %s without a system-runtime fallback", async (path) => {
    const { root, manifest } = await fixture();
    await rm(join(root, path));
    await expect(resolvePackagedRuntime(root, manifest, manifest)).rejects.toThrow();
    await writeFile(join(root, path), "changed");
    await expect(resolvePackagedRuntime(root, manifest, manifest)).rejects.toThrow(/digest/iu);
  });
  it("rejects invalid packaged files through candidate startup before creating a daemon receipt", async () => {
    const { root, manifest } = await fixture();
    await rm(join(root, "node"));
    await expect(ensureServiceDaemonReady({
      appSupportRoot: root, recoveryRoot: join(root, "recovery"), socketPath: join(root, "control.sock"),
      webAssetsRoot: join(root, "web"), packagedRuntime: { root, manifest, expectedIdentity: manifest },
    }, "test-lock-token", join(root, "receipt.json"))).rejects.toThrow(/ENOENT/u);
  });
  it("rejects a manifest asset root different from the assets the service actually serves", async () => {
    const { root, manifest } = await fixture();
    await mkdir(join(root, "other-web"));
    await writeFile(join(root, "other-web/index.html"), "payload");
    await expect(resolvePackagedRuntime(root, {
      ...manifest, webAssets: { ...manifest.webAssets, path: "other-web" },
    }, manifest)).rejects.toThrow(/served/iu);
  });
  it("rejects served assets absent from the manifest", async () => {
    const { root, manifest } = await fixture();
    await writeFile(join(root, "web/extra.js"), "unidentified");
    await expect(resolvePackagedRuntime(root, manifest, manifest)).rejects.toThrow(/asset/iu);
  });
  it("rejects an incompatible identity or platform", async () => {
    const { root, manifest } = await fixture();
    await expect(resolvePackagedRuntime(root, manifest, { ...manifest, daemonIdentity: "c".repeat(64) })).rejects.toThrow(/identity/iu);
    await expect(resolvePackagedRuntime(root, { ...manifest, target: { platform: "win32", arch: "wrong" } }, manifest)).rejects.toThrow(/target/iu);
  });
});
