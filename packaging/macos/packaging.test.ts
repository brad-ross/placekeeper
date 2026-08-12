import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createNotarizationPlan } from "./notarize.js";
import { validateAppBundleManifest, validateBackendRuntimeManifest } from "./validate-manifest.js";
import { finderServiceArgs } from "./launcher.mjs";
import { validateDoctorEvidence } from "./smoke-installed.js";

const execFileAsync = promisify(execFile);

describe("macOS distribution manifests", () => {
  it("pins one offline runtime for the Apple-silicon source-first build", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as unknown;
    const backend = JSON.parse(await readFile(resolve("packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown;
    const appManifest = validateAppBundleManifest(app);
    expect(appManifest.architectures).toEqual(["arm64"]);
    expect(appManifest.finderExecutable).toBe("droplet");
    expect(appManifest.embeddedArtifacts).not.toHaveProperty("finderQuickAction");
    expect(appManifest.distribution).toEqual({ mode: "source-first", signingRequired: false });
    const runtime = validateBackendRuntimeManifest(backend);
    expect(runtime.targets).toEqual(["darwin-arm64"]);
    expect(runtime.assets.every((asset) => asset.networkFallbackAllowed === false)).toBe(true);
    expect(runtime.releaseGate.adobeAcrobatReader).toBe("pass");
  });

  it("offers a non-mutating dry run for the one-command source installer", async () => {
    const installer = await readFile(resolve("install.sh"), "utf8");
    const { stdout } = await execFileAsync("/bin/sh", [resolve("install.sh"), "--dry-run"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, PDF_PROOFREADER_USER_HOME: "/tmp/pdf-proofreader-installer-home" },
    });
    expect(stdout).toContain("Apple-silicon source install");
    expect(stdout).toContain("Node 24.14.0");
    expect(stdout).toContain("pnpm 11.16.0");
    expect(stdout).toContain("/tmp/pdf-proofreader-installer-home/Applications/PDF Proofreader.app");
    expect(stdout).toContain("No files were changed");
    expect(installer).toContain("a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3");
    expect(installer).toContain("install --frozen-lockfile");
    expect(installer).not.toContain("xattr");
    expect(installer).not.toContain("spctl --master-disable");
  });

  it("replaces the app transactionally and restores the app plus obsolete action after a partial failure", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pdf-proofreader-install-test-"));
    const built = resolve(root, "built/PDF Proofreader.app");
    const app = resolve(root, "home/Applications/PDF Proofreader.app");
    const services = resolve(root, "home/Library/Services");
    const action = resolve(services, "PDF Proofreader.workflow");
    const helper = resolve("packaging/macos/install-built-app.sh");
    try {
      await mkdir(resolve(built, "Contents/MacOS"), { recursive: true });
      await writeFile(resolve(built, "Contents/MacOS/pdf-proofreader"), "new launcher", { mode: 0o755 });
      await writeFile(resolve(built, "Contents/MacOS/droplet"), "native bridge", { mode: 0o755 });
      await writeFile(resolve(built, "new-app"), "new app");
      await mkdir(action, { recursive: true });
      await writeFile(resolve(action, "obsolete-action"), "obsolete action");
      await execFileAsync("/bin/sh", [helper, built, app, action]);
      expect(await readFile(resolve(app, "new-app"), "utf8")).toBe("new app");
      await expect(readFile(resolve(action, "obsolete-action"), "utf8")).rejects.toThrow();

      await rm(app, { recursive: true });
      await rm(action, { recursive: true, force: true });
      await mkdir(app, { recursive: true });
      await mkdir(action, { recursive: true });
      await writeFile(resolve(app, "old-app"), "old app");
      await writeFile(resolve(action, "old-action"), "old action");
      await chmod(services, 0o500);
      await expect(execFileAsync("/bin/sh", [helper, built, app, action])).rejects.toThrow();
      await chmod(services, 0o700);
      expect(await readFile(resolve(app, "old-app"), "utf8")).toBe("old app");
      expect(await readFile(resolve(action, "old-action"), "utf8")).toBe("old action");
    } finally {
      await chmod(services, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses current notarytool submission followed by staple and validation", () => {
    expect(createNotarizationPlan("/tmp/PDF-Proofreader-arm64.zip", "/tmp/PDF Proofreader.app", "PDF_PROOFREADER_NOTARY")).toEqual([
      { command: "xcrun", args: ["notarytool", "submit", "/tmp/PDF-Proofreader-arm64.zip", "--keychain-profile", "PDF_PROOFREADER_NOTARY", "--wait", "--output-format", "json"] },
      { command: "xcrun", args: ["stapler", "staple", "/tmp/PDF Proofreader.app"] },
      { command: "xcrun", args: ["stapler", "validate", "/tmp/PDF Proofreader.app"] },
    ]);
  });

  it("translates an installed raw Finder path without putting a capability in process arguments", async () => {
    expect(finderServiceArgs("/tmp/paper.pdf")).toEqual(["open", "--json", "--surface", "finder", "--pdf", "/tmp/paper.pdf"]);
    const launcher = await readFile(resolve("packaging/macos/launcher.mjs"), "utf8");
    expect(launcher).toContain('system attribute "PDF_PROOFREADER_URL"');
    expect(launcher).toContain("PDF_PROOFREADER_PDFIUM_WASM");
    expect(launcher).toContain('choose file of type {"com.adobe.pdf"}');
    expect(launcher).toContain('result.error?.kind === "input-unavailable"');
    expect(launcher).toContain("realpathSync");
    expect(launcher).not.toContain('"/usr/bin/open"');
    const bridge = await readFile(resolve("packaging/macos/finder-bridge.applescript"), "utf8");
    expect(bridge).toContain("on open pdfItems");
    expect(bridge).toContain("Contents/MacOS/pdf-proofreader");
    expect(bridge).toContain("quoted form of pdfPath");
    expect(bridge).not.toContain("Terminal");
  });

  it("requires content-free installed writer evidence matching the pinned runtime", () => {
    expect(validateDoctorEvidence({
      ok: true,
      offline: true,
      writer: "embedpdf-node-pdfium",
      nodeVersion: "24.14.0",
      pdfiumSha256: "a".repeat(64),
      pages: 1,
      structurallyValid: true,
    }, "24.14.0", "a".repeat(64))).toMatchObject({ offline: true, pages: 1 });
    expect(() => validateDoctorEvidence({ ok: true, offline: true, writer: "embedpdf-node-pdfium", nodeVersion: "24.14.0", pdfiumSha256: "a".repeat(64), pages: 0, structurallyValid: true }, "24.14.0", "a".repeat(64))).toThrow(/evidence/u);
  });

  it("packages task-correlated Codex hooks through the installed executable", async () => {
    const hooks = JSON.parse(await readFile(resolve("integrations/codex-plugin/hooks/hooks.json"), "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; additionalContextLimit?: number }> }>>;
    };
    expect(Object.keys(hooks.hooks ?? {}).sort()).toEqual(["PostToolUse", "SessionEnd", "UserPromptSubmit"]);
    for (const event of Object.values(hooks.hooks ?? {})) {
      expect(event).toHaveLength(1);
      expect(event[0]?.hooks).toEqual([expect.objectContaining({
        command: '"$HOME/Applications/PDF Proofreader.app/Contents/MacOS/pdf-proofreader" hook --event',
      })]);
    }
    expect(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.additionalContextLimit).toBe(131072);
    const build = await readFile(resolve("packaging/macos/build-app.ts"), "utf8");
    expect(build).toContain("appManifest.embeddedArtifacts.codexPlugin");
    expect(build).toContain('resolve(resources, "integrations/codex-plugin")');
  });
});
