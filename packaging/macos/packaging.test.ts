import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CODEX_INSTALLED_LAUNCHER_COMMAND,
  inspectHookEvent,
} from "../../apps/service/src/cli/hook-command.js";
import { CONTROL_REQUEST_TIMEOUT_MS } from "../../apps/service/src/host/launch-control.js";
import { createNotarizationPlan } from "./notarize.js";
import {
  validateAppBundleManifest,
  validateBackendRuntimeManifest,
  validateDistributionManifests,
} from "./validate-manifest.js";
import { finderServiceArgs } from "./launcher.mjs";
import { validateDoctorEvidence } from "./smoke-installed.js";
import { computePackagedBuildIdentity } from "./build-app.js";

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
    expect(launcher).toContain("build-identity.json");
    expect(launcher).toContain("PDF_PROOFREADER_DAEMON_IDENTITY");
    expect(launcher).toContain("PDF_PROOFREADER_INSTALL_ARTIFACT_IDENTITY");
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

  it("derives stable daemon and complete artifact identities from packaged bytes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pdf-proofreader-build-identity-"));
    const contents = join(root, "Contents");
    const service = join(contents, "Resources/service");
    const web = join(contents, "Resources/web");
    try {
      await mkdir(service, { recursive: true });
      await mkdir(web, { recursive: true });
      await writeFile(join(service, "main.js"), "service-a");
      await writeFile(join(web, "app.js"), "web-a");
      await writeFile(join(contents, "Info.plist"), "plist-a");

      const first = await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: service, webRoot: web });
      expect(await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: service, webRoot: web })).toEqual(first);
      expect(first).toMatchObject({
        managementProtocolVersion: 1,
        daemonIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
        installArtifactIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });

      await writeFile(join(contents, "Info.plist"), "plist-b");
      const otherArtifact = await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: service, webRoot: web });
      expect(otherArtifact.daemonIdentity).toBe(first.daemonIdentity);
      expect(otherArtifact.installArtifactIdentity).not.toBe(first.installArtifactIdentity);

      await writeFile(join(web, "app.js"), "web-b");
      const otherDaemon = await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: service, webRoot: web });
      expect(otherDaemon.daemonIdentity).not.toBe(first.daemonIdentity);
      expect(otherDaemon.installArtifactIdentity).not.toBe(otherArtifact.installArtifactIdentity);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    await expect(validateDistributionManifests(resolve("."))).resolves.toBeUndefined();
    const plugin = JSON.parse(await readFile(resolve("integrations/codex-plugin/.codex-plugin/plugin.json"), "utf8")) as {
      description?: string;
      skills?: string;
      interface?: { longDescription?: string };
    };
    expect(plugin).toMatchObject({
      skills: "./skills/",
      interface: { longDescription: expect.stringContaining("every prompt") },
    });
    const hooks = JSON.parse(await readFile(resolve("integrations/codex-plugin/hooks/hooks.json"), "utf8")) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string; timeout?: number; additionalContextLimit?: number }> }>>;
    };
    expect(Object.keys(hooks.hooks ?? {}).sort()).toEqual(["PostToolUse", "SessionEnd", "UserPromptSubmit"]);
    for (const event of Object.values(hooks.hooks ?? {})) {
      expect(event).toHaveLength(1);
      expect(event[0]?.hooks).toEqual([expect.objectContaining({
        command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} hook --event`,
      })]);
    }
    expect(hooks.hooks?.PostToolUse?.[0]?.hooks?.[0]?.timeout).toBeGreaterThan(CONTROL_REQUEST_TIMEOUT_MS / 1_000);
    expect(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.timeout).toBeGreaterThan(CONTROL_REQUEST_TIMEOUT_MS / 1_000);
    expect(hooks.hooks?.SessionEnd?.[0]?.hooks?.[0]?.timeout).toBe(3);
    expect(hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.additionalContextLimit).toBe(131072);
    const skill = await readFile(resolve("integrations/codex-plugin/skills/pdf-proofreader/SKILL.md"), "utf8");
    expect(skill).toContain(`${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf`);
    expect(inspectHookEvent({
      session_id: "packaged-contract-task",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf /private/tmp/package-contract.pdf`,
      },
      tool_response: JSON.stringify({
        ok: true,
        kind: "opened",
        url: "http://127.0.0.1:43127/s/package-contract/bootstrap#cap=browser-capability-secret",
        sessionId: "package-contract",
        documentGeneration: 1,
        bindProof: "b".repeat(43),
      }),
    })).toMatchObject({
      kind: "claim",
      taskSessionId: "packaged-contract-task",
      reviewSessionId: "package-contract",
    });
    const build = await readFile(resolve("packaging/macos/build-app.ts"), "utf8");
    expect(build).toContain("appManifest.embeddedArtifacts.codexPlugin");
    expect(build).toContain('resolve(resources, "integrations/codex-plugin")');
    expect(build).toContain('resolve(codexPlugin, "hooks/hooks.json")');
    const appManifest = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8"));
    expect(() => validateAppBundleManifest({
      ...appManifest,
      embeddedArtifacts: { vscodeExtension: "apps/vscode" },
    })).toThrow(/Codex plugin/u);
  });
});
