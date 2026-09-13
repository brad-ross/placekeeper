import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import sourceManifest from "../../apps/chrome-extension/manifest.json" with { type: "json" };
import {
  CHROME_EXTENSION_ID,
  chromeExtensionInstallPath,
  CHROME_EXTENSION_ORIGIN,
  CHROME_NATIVE_HOST_NAME,
  inspectChromeInstallation,
  renderChromeNativeHostManifest,
  validateChromeIntegrationBundle,
  validateChromeSourceContract,
} from "./chrome-integration.js";

async function fixtureBundle(root: string): Promise<string> {
  const app = join(root, "Applications/Placekeeper.app");
  const extension = join(app, "Contents/Resources/integrations/chrome-extension");
  const wrapper = join(app, "Contents/MacOS/placekeeper-chrome-host");
  await mkdir(extension, { recursive: true, mode: 0o755 });
  await mkdir(join(app, "Contents/MacOS"), { recursive: true, mode: 0o755 });
  await writeFile(join(extension, "manifest.json"), `${JSON.stringify(sourceManifest)}\n`, { mode: 0o644 });
  await writeFile(join(extension, "handler.html"), "handler", { mode: 0o644 });
  await writeFile(join(extension, "popup.html"), "popup", { mode: 0o644 });
  await writeFile(join(extension, "background.js"), "background", { mode: 0o644 });
  const shared = join(extension, "shared");
  await mkdir(shared, { mode: 0o755 });
  const assets = {
    "app.js": "export function start() {}\n",
    "app.css": ":root {}\n",
    "pdfium.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
    "pdfium-worker.js": 'class PdfiumEngineRunner {}\nif (message.type === "wasmInit") {}\n',
  } as const;
  for (const [name, bytes] of Object.entries(assets)) await writeFile(join(shared, name), bytes, { mode: 0o644 });
  await writeFile(join(shared, "asset-manifest.json"), JSON.stringify({
    schemaVersion: 3,
    app: "app.js",
    stylesheet: "app.css",
    pdfiumWasm: "pdfium.wasm",
    pdfiumWorker: "pdfium-worker.js",
    integrity: Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [
      name, createHash("sha256").update(bytes).digest("hex"),
    ])),
  }), { mode: 0o644 });
  await writeFile(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return app;
}

describe("Chrome distribution integration", () => {
  it("derives one stable exact extension/native-host contract", () => {
    expect(validateChromeSourceContract(sourceManifest)).toEqual({
      extensionId: CHROME_EXTENSION_ID,
      extensionOrigin: CHROME_EXTENSION_ORIGIN,
      hostName: CHROME_NATIVE_HOST_NAME,
      minimumChromeVersion: 151,
      protocol: { minimum: 1, maximum: 1 },
    });
    expect(CHROME_EXTENSION_ID).toBe("cgegjjjhbhnfgcoipeffhogoojfoekgg");
    expect(CHROME_EXTENSION_ORIGIN).toBe(`chrome-extension://${CHROME_EXTENSION_ID}/`);
    expect(() => validateChromeSourceContract({
      ...sourceManifest,
      host_permissions: ["http://127.0.0.1/*"],
    } as typeof sourceManifest)).toThrow(/host permission/iu);
    expect(() => validateChromeSourceContract({
      ...sourceManifest,
      content_security_policy: { extension_pages: "script-src 'self' https://example.invalid" },
    } as typeof sourceManifest)).toThrow(/content security/iu);
  });

  it("renders one exact user-level native-host manifest without wildcards", () => {
    const manifest = renderChromeNativeHostManifest(
      "/Users/Example Person/Applications/Placekeeper.app",
    );
    expect(manifest).toEqual({
      name: CHROME_NATIVE_HOST_NAME,
      description: "Placekeeper Chrome PDF handoff",
      path: "/Users/Example Person/Applications/Placekeeper.app/Contents/MacOS/placekeeper-chrome-host",
      type: "stdio",
      allowed_origins: [CHROME_EXTENSION_ORIGIN],
    });
  });

  it("rejects mismatched, symlinked, or writable packaged endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-bundle-"));
    const app = await fixtureBundle(root);
    await expect(validateChromeIntegrationBundle(app)).resolves.toMatchObject({
      extensionId: CHROME_EXTENSION_ID,
      protocol: { minimum: 1, maximum: 1 },
    });

    const appAlias = join(root, "Alias.app");
    await symlink(app, appAlias);
    await expect(validateChromeIntegrationBundle(appAlias)).rejects.toThrow(/symbolic link/u);

    await chmod(join(app, "Contents/MacOS/placekeeper-chrome-host"), 0o775);
    await expect(validateChromeIntegrationBundle(app)).rejects.toThrow(/writable/u);
    await chmod(join(app, "Contents/MacOS/placekeeper-chrome-host"), 0o755);

    const extension = join(app, "Contents/Resources/integrations/chrome-extension");
    const realExtension = join(root, "real-extension");
    await mkdir(realExtension);
    await writeFile(join(realExtension, "manifest.json"), `${JSON.stringify(sourceManifest)}\n`);
    await writeFile(join(realExtension, "handler.html"), "handler");
    await writeFile(join(realExtension, "popup.html"), "popup");
    await writeFile(join(realExtension, "background.js"), "background");
    await import("node:fs/promises").then(({ rm }) => rm(extension, { recursive: true }));
    await symlink(realExtension, extension);
    await expect(validateChromeIntegrationBundle(app)).rejects.toThrow(/symbolic link/u);
  });

  it("reports path-free healthy and actionable mismatch states", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-doctor-"));
    const app = await fixtureBundle(root);
    const userHome = join(root, "home");
    const profile = join(userHome, "Library/Application Support/Google/Chrome/Default");
    const hostDirectory = join(userHome, "Library/Application Support/Google/Chrome/NativeMessagingHosts");
    await mkdir(profile, { recursive: true });
    await mkdir(hostDirectory, { recursive: true });
    const extensionPath = join(app, "Contents/Resources/integrations/chrome-extension");
    const installedExtensionPath = chromeExtensionInstallPath(app);
    await cp(extensionPath, installedExtensionPath, {
      recursive: true,
    });
    await writeFile(join(profile, "Preferences"), JSON.stringify({
      extensions: { settings: { [CHROME_EXTENSION_ID]: { path: installedExtensionPath } } },
    }));
    await writeFile(
      join(hostDirectory, `${CHROME_NATIVE_HOST_NAME}.json`),
      `${JSON.stringify(renderChromeNativeHostManifest(app))}\n`,
    );

    await expect(inspectChromeInstallation({ appPath: app, userHome })).resolves.toEqual({
      ok: true,
      status: "healthy",
      action: "none",
      extensionId: CHROME_EXTENSION_ID,
      protocol: 1,
    });

    await writeFile(join(profile, "Preferences"), JSON.stringify({
      extensions: { settings: { wrongid: { path: installedExtensionPath } } },
    }));
    const mismatch = await inspectChromeInstallation({ appPath: app, userHome });
    expect(mismatch).toEqual({
      ok: false,
      status: "extension-id-mismatch",
      action: "reload-packaged-extension",
      extensionId: CHROME_EXTENSION_ID,
      protocol: 1,
    });
    expect(JSON.stringify(mismatch)).not.toContain(root);

    const hostPath = join(hostDirectory, `${CHROME_NATIVE_HOST_NAME}.json`);
    const substitutedHost = join(root, "substituted-host.json");
    await writeFile(substitutedHost, `${JSON.stringify(renderChromeNativeHostManifest(app))}\n`);
    await rm(hostPath);
    await symlink(substitutedHost, hostPath);
    await expect(inspectChromeInstallation({ appPath: app, userHome })).resolves.toMatchObject({
      ok: false,
      status: "native-host-mismatch",
      action: "reinstall-placekeeper",
    });
    await rm(hostPath);
    await writeFile(hostPath, `${JSON.stringify(renderChromeNativeHostManifest(app))}\n`, { mode: 0o600 });

    const googleDirectory = join(userHome, "Library/Application Support/Google");
    await chmod(googleDirectory, 0o777);
    await expect(inspectChromeInstallation({ appPath: app, userHome })).resolves.toMatchObject({
      ok: false,
      status: "native-host-mismatch",
      action: "reinstall-placekeeper",
    });
    await chmod(googleDirectory, 0o755);

    await writeFile(join(profile, "Preferences"), JSON.stringify({ extensions: { settings: {} } }));
    await expect(inspectChromeInstallation({ appPath: app, userHome })).resolves.toMatchObject({
      ok: false,
      status: "extension-not-loaded",
      action: "load-packaged-extension",
    });
  });

  it.each(["handler.html", "popup.html", "background.js"])(
    "reports an installed extension missing %s as incomplete",
    async (entry) => {
      const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-incomplete-"));
      try {
        const app = await fixtureBundle(root);
        const userHome = join(root, "home");
        const hostDirectory = join(
          userHome,
          "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        );
        const installedExtensionPath = chromeExtensionInstallPath(app);
        await cp(join(app, "Contents/Resources/integrations/chrome-extension"), installedExtensionPath, {
          recursive: true,
        });
        await rm(join(installedExtensionPath, entry));
        await mkdir(hostDirectory, { recursive: true });
        await writeFile(
          join(hostDirectory, `${CHROME_NATIVE_HOST_NAME}.json`),
          `${JSON.stringify(renderChromeNativeHostManifest(app))}\n`,
        );

        await expect(inspectChromeInstallation({ appPath: app, userHome })).resolves.toMatchObject({
          ok: false,
          status: "app-incomplete",
          action: "reinstall-placekeeper",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["asset-manifest.json", "app.js", "app.css", "pdfium.wasm", "pdfium-worker.js"])(
    "reports an installed extension missing or corrupt shared asset %s as incomplete",
    async (asset) => {
      const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-shared-incomplete-"));
      try {
        const app = await fixtureBundle(root);
        const extension = join(app, "Contents/Resources/integrations/chrome-extension");
        await rm(join(extension, "shared", asset));
        await expect(validateChromeIntegrationBundle(app)).rejects.toThrow(new RegExp(asset.replace(".", "\\."), "u"));

        await rm(root, { recursive: true, force: true });
        const corruptApp = await fixtureBundle(root);
        await writeFile(join(corruptApp, "Contents/Resources/integrations/chrome-extension/shared", asset), "corrupt");
        await expect(validateChromeIntegrationBundle(corruptApp)).rejects.toThrow(new RegExp(asset.replace(".", "\\."), "u"));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects stale executable files in the packaged shared client", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-shared-stale-"));
    try {
      const app = await fixtureBundle(root);
      await writeFile(
        join(app, "Contents/Resources/integrations/chrome-extension/shared/stale.js"),
        "export default true",
      );
      await expect(validateChromeIntegrationBundle(app)).rejects.toThrow(/stale assets/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an insecure installed extension tree as incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-chrome-insecure-installed-"));
    try {
      const app = await fixtureBundle(root);
      const userHome = join(root, "home");
      const hostDirectory = join(
        userHome,
        "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      );
      const installedExtensionPath = chromeExtensionInstallPath(app);
      await cp(join(app, "Contents/Resources/integrations/chrome-extension"), installedExtensionPath, {
        recursive: true,
      });
      await chmod(join(installedExtensionPath, "background.js"), 0o666);
      await mkdir(hostDirectory, { recursive: true });
      await writeFile(
        join(hostDirectory, `${CHROME_NATIVE_HOST_NAME}.json`),
        `${JSON.stringify(renderChromeNativeHostManifest(app))}\n`,
      );

      await expect(inspectChromeInstallation({ appPath: app, userHome })).resolves.toMatchObject({
        ok: false,
        status: "app-incomplete",
        action: "reinstall-placekeeper",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never carries installer state that can enable interception", async () => {
    const installer = await readFile(resolve("install.sh"), "utf8");
    const helper = await readFile(resolve("packaging/macos/install-built-app.sh"), "utf8");
    for (const source of [installer, helper]) {
      expect(source).not.toContain("chrome.storage");
      expect(source).not.toContain("setDefault");
      expect(source).not.toContain("setHandler");
    }
  });
});

describe("independent Chrome preparation", () => {
  async function fixture() {
    const root = await mkdtemp("/private/tmp/placekeeper-chrome-stage-");
    const app = await fixtureBundle(root);
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const extension = chromeExtensionInstallPath(app);
    const receipt = join(home, "Library/Application Support/Placekeeper/installer/chrome-legacy-ownership.json");
    const manifest = join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.placekeeper.chrome.json");
    const run = async (_executable: string, args: string[]) => {
      await validateChromeIntegrationBundle(app);
      await writeFile(args.at(-1)!, JSON.stringify(renderChromeNativeHostManifest(app)), { flag: "wx", mode: 0o600 });
    };
    return { root, app, home, extension, receipt, manifest, run };
  }

  it("prepares exact-origin registration while leaving Chrome preferences unchanged", async () => {
    const f = await fixture();
    try {
      const profile = join(f.home, "Library/Application Support/Google/Chrome/Default");
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const preferences = JSON.stringify({ automaticOpening: false, unrelated: true });
      await writeFile(join(profile, "Preferences"), preferences);
      const { setupChrome } = await import("./setup-chrome.mjs");
      await expect(setupChrome(f.app, { userHome: f.home, run: f.run })).resolves.toMatchObject({ status: "pending" });
      expect(JSON.parse(await readFile(f.manifest, "utf8"))).toEqual(renderChromeNativeHostManifest(f.app));
      expect(await readFile(join(profile, "Preferences"), "utf8")).toBe(preferences);
      await setupChrome(f.app, { userHome: f.home, run: f.run });
      expect(await readFile(join(profile, "Preferences"), "utf8")).toBe(preferences);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(["extension-backed-up", "registration-backed-up", "registered"])("rolls back only Chrome endpoints on failure at %s", async (stage) => {
    const f = await fixture();
    try {
      const { setupChrome } = await import("./setup-chrome.mjs");
      await setupChrome(f.app, { userHome: f.home, run: f.run });
      await writeFile(join(f.extension, "previous"), "previous extension");
      await writeFile(f.manifest, '{"previous":true}\n');
      await expect(setupChrome(f.app, { userHome: f.home, run: f.run,
        checkpoint: async (at: string) => { if (at === stage) throw new Error("injected failure"); },
      })).rejects.toThrow("injected failure");
      expect(await readFile(join(f.extension, "previous"), "utf8")).toBe("previous extension");
      expect(await readFile(f.manifest, "utf8")).toBe('{"previous":true}\n');
      await expect(validateChromeIntegrationBundle(f.app)).resolves.toBeDefined();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it("retains legacy proof across skipped and failed stages, rejects a changed tree, and removes proof after adoption", async () => {
    const f = await fixture();
    try {
      const { setupChrome, captureLegacyChromeOwnership } = await import("./setup-chrome.mjs");
      await cp(join(f.app, "Contents/Resources/integrations/chrome-extension"), f.extension, { recursive: true });
      await captureLegacyChromeOwnership(f.app, f.home);
      const proof = await readFile(f.receipt, "utf8");
      await writeFile(f.receipt, "invalid retained receipt");
      await expect(captureLegacyChromeOwnership(f.app, f.home)).rejects.toThrow();
      await writeFile(f.receipt, proof);
      await writeFile(join(f.app, "Contents/Resources/integrations/chrome-extension/background.js"), "new release");
      await expect(setupChrome(f.app, { userHome: f.home, run: f.run,
        checkpoint: async (stage: string) => { if (stage === "registration-backed-up") throw new Error("registration failure"); },
      })).rejects.toThrow("registration failure");
      expect(await readFile(f.receipt, "utf8")).toBe(proof);
      await writeFile(join(f.extension, "unowned"), "changed after skip");
      await expect(setupChrome(f.app, { userHome: f.home, run: f.run })).rejects.toThrow("legacy Chrome tree changed");
      expect(await readFile(f.receipt, "utf8")).toBe(proof);
      await rm(join(f.extension, "unowned"));
      await setupChrome(f.app, { userHome: f.home, run: f.run });
      await expect(readFile(f.receipt)).rejects.toThrow();
      expect(await readFile(join(f.extension, "background.js"), "utf8")).toBe("new release");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it.each(["unmanaged", "symlink", "writable", "registration-symlink"])("rejects %s endpoints without changing the Mac app", async (condition) => {
    const f = await fixture();
    try {
      const { setupChrome } = await import("./setup-chrome.mjs");
      if (condition === "unmanaged") {
        await mkdir(f.extension); await writeFile(join(f.extension, "user-file"), "keep");
      } else if (condition === "symlink") {
        await symlink(join(f.app, "Contents/Resources/integrations/chrome-extension"), f.extension);
      } else if (condition === "writable") {
        await chmod(f.home, 0o777);
      } else {
        await mkdir(join(f.home, "Library"));
        await symlink(f.root, join(f.home, "Library/Application Support"));
      }
      const before = await readFile(join(f.app, "Contents/Resources/integrations/chrome-extension/manifest.json"), "utf8");
      await expect(setupChrome(f.app, { userHome: f.home, run: f.run })).rejects.toThrow(/Refusing/u);
      expect(await readFile(join(f.app, "Contents/Resources/integrations/chrome-extension/manifest.json"), "utf8")).toBe(before);
      if (condition === "unmanaged") expect(await readFile(join(f.extension, "user-file"), "utf8")).toBe("keep");
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });
});
