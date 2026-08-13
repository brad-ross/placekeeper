import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CODEX_INSTALLED_LAUNCHER_COMMAND,
  inspectHookEvent,
} from "../../apps/service/src/cli/hook-command.js";
import { coordinateUpgrade } from "../../apps/service/src/host/upgrade-coordinator.js";
import { createNotarizationPlan } from "./notarize.js";
import {
  validateAppBundleManifest,
  validateBackendRuntimeManifest,
  validateCodexPlugin,
  validateDistributionManifests,
  validateMacIconSet,
} from "./validate-manifest.js";
import { finderServiceArgs } from "./launcher.mjs";
import { validateDoctorEvidence } from "./smoke-installed.js";
import {
  appBundlePath,
  compileMacIcon,
  computePackagedBuildIdentity,
  infoPlist,
  infoPlistStrings,
} from "./build-app.js";

const execFileAsync = promisify(execFile);

describe("macOS distribution manifests", () => {
  it("uses the Placekeeper identity for the complete macOS bundle", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as unknown;
    const manifest = validateAppBundleManifest(app);

    expect(manifest).toMatchObject({
      productName: "Placekeeper",
      bundleName: "Placekeeper",
      bundleIdentifier: "local.placekeeper",
      executable: "placekeeper",
      finderExecutable: "droplet",
      runtimeDataDirectory: "Library/Application Support/Placekeeper",
      documentTypes: [{ contentType: "com.adobe.pdf", role: "Viewer", rank: "Alternate" }],
      icon: {
        master: "packaging/macos/icon/Placekeeper.svg",
        source: "packaging/macos/icon/Placekeeper.iconset",
        file: "Placekeeper",
      },
    });
    expect(appBundlePath("/tmp/placekeeper-package", manifest)).toBe(
      "/tmp/placekeeper-package/Placekeeper.app",
    );

    const plist = infoPlist(manifest);
    expect(plist).toContain("<key>CFBundleDisplayName</key><string>Placekeeper</string>");
    expect(plist).toContain("<key>CFBundleName</key><string>Placekeeper</string>");
    expect(plist).toContain("<key>LSHasLocalizedDisplayName</key><true/>");
    expect(plist).toContain("<key>CFBundleExecutable</key><string>droplet</string>");
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>local.placekeeper</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key><string>Placekeeper</string>");
    expect(infoPlistStrings(manifest)).toBe(
      '"CFBundleDisplayName" = "Placekeeper";\n"CFBundleName" = "Placekeeper";\n',
    );
  });

  it("validates the complete Placekeeper iconset before packaging", async () => {
    const iconset = resolve("packaging/macos/icon/Placekeeper.iconset");
    await expect(validateMacIconSet(iconset)).resolves.toEqual([
      ["icon_16x16.png", 16],
      ["icon_16x16@2x.png", 32],
      ["icon_32x32.png", 32],
      ["icon_32x32@2x.png", 64],
      ["icon_128x128.png", 128],
      ["icon_128x128@2x.png", 256],
      ["icon_256x256.png", 256],
      ["icon_256x256@2x.png", 512],
      ["icon_512x512.png", 512],
      ["icon_512x512@2x.png", 1024],
    ]);
  });

  it.runIf(process.platform === "darwin")("compiles a reverse-expandable Placekeeper icns", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-icns-test-"));
    const icns = resolve(root, "Placekeeper.icns");
    const expanded = resolve(root, "Expanded.iconset");
    try {
      await compileMacIcon(resolve("packaging/macos/icon/Placekeeper.iconset"), icns);
      expect((await readFile(icns)).subarray(0, 4).toString("ascii")).toBe("icns");
      await execFileAsync("/usr/bin/iconutil", ["-c", "iconset", icns, "-o", expanded]);
      await expect(validateMacIconSet(expanded)).resolves.toHaveLength(10);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("packages the icon before build identity and signing", async () => {
    const source = await readFile(resolve("packaging/macos/build-app.ts"), "utf8");
    const build = source.slice(source.indexOf("export async function buildMacApp"));
    expect(build.indexOf("await compileMacIcon(")).toBeLessThan(build.indexOf("await computePackagedBuildIdentity({"));
    expect(build.indexOf("await computePackagedBuildIdentity({")).toBeLessThan(build.indexOf("await signBundle("));
    expect(build.indexOf("await computePackagedBuildIdentity({")).toBeLessThan(build.indexOf("await signAdHocBundle("));
  });

  it("rejects incomplete, misnamed, nonsquare, and wrongly sized icon representations", async () => {
    const source = resolve("packaging/macos/icon/Placekeeper.iconset");

    const withIconset = async (mutate: (iconset: string) => Promise<void>): Promise<string> => {
      const root = await mkdtemp(resolve(tmpdir(), "placekeeper-iconset-test-"));
      const iconset = resolve(root, "Placekeeper.iconset");
      await cp(source, iconset, { recursive: true });
      await mutate(iconset);
      return root;
    };

    const missingRoot = await withIconset(async (iconset) => {
      await rm(resolve(iconset, "icon_16x16.png"));
    });
    const misnamedRoot = await withIconset(async (iconset) => {
      await rename(resolve(iconset, "icon_16x16.png"), resolve(iconset, "icon_16.png"));
    });
    const wrongSizeRoot = await withIconset(async (iconset) => {
      await writeFile(resolve(iconset, "icon_16x16.png"), await readFile(resolve(iconset, "icon_16x16@2x.png")));
    });
    const nonsquareRoot = await withIconset(async (iconset) => {
      const path = resolve(iconset, "icon_16x16.png");
      const png = await readFile(path);
      png.writeUInt32BE(15, 20);
      await writeFile(path, png);
    });

    try {
      await expect(validateMacIconSet(resolve(missingRoot, "Placekeeper.iconset"))).rejects.toThrow(/filenames/u);
      await expect(validateMacIconSet(resolve(misnamedRoot, "Placekeeper.iconset"))).rejects.toThrow(/filenames/u);
      await expect(validateMacIconSet(resolve(wrongSizeRoot, "Placekeeper.iconset"))).rejects.toThrow(/dimensions/u);
      await expect(validateMacIconSet(resolve(nonsquareRoot, "Placekeeper.iconset"))).rejects.toThrow(/square/u);
    } finally {
      await Promise.all([missingRoot, misnamedRoot, wrongSizeRoot, nonsquareRoot].map(async (root) => await rm(root, { recursive: true, force: true })));
    }
  });

  it("keeps icon source ownership pinned in the app manifest", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as Record<string, unknown>;
    for (const icon of [
      undefined,
      { master: "packaging/macos/icon/Other.svg", source: "packaging/macos/icon/Placekeeper.iconset", file: "Placekeeper" },
      { master: "packaging/macos/icon/Placekeeper.svg", source: "packaging/macos/icon/Other.iconset", file: "Placekeeper" },
      { master: "packaging/macos/icon/Placekeeper.svg", source: "packaging/macos/icon/Placekeeper.iconset", file: "droplet" },
    ]) {
      expect(() => validateAppBundleManifest({ ...app, icon })).toThrow(/icon/iu);
    }
  });

  it("rejects mutations to the Placekeeper distribution identity", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as Record<string, unknown>;
    const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["visible product", { productName: "Other" }],
      ["physical bundle", { bundleName: "Other" }],
      ["bundle identifier", { bundleIdentifier: "local.other" }],
      ["launcher executable", { executable: "other" }],
      ["Finder bridge", { finderExecutable: "placekeeper-droplet" }],
      ["runtime data root", { runtimeDataDirectory: "Library/Application Support/Other" }],
      ["document registration", { documentTypes: [{ contentType: "com.adobe.pdf", role: "Editor", rank: "Owner" }] }],
    ];

    for (const [label, mutation] of mutations) {
      expect(() => validateAppBundleManifest({ ...app, ...mutation }), label).toThrow();
    }
  });

  it("pins the Placekeeper runtime identity without pinning the content-derived daemon hash", async () => {
    const [installer, smoke, serviceDaemon, launchControl, hookCommand, pdfInspector, exportCoordinator, vscodePackage, vscodeExtension] =
      await Promise.all([
        readFile(resolve("install.sh"), "utf8"),
        readFile(resolve("packaging/macos/smoke-installed.ts"), "utf8"),
        readFile(resolve("apps/service/src/host/service-daemon.ts"), "utf8"),
        readFile(resolve("apps/service/src/host/launch-control.ts"), "utf8"),
        readFile(resolve("apps/service/src/cli/hook-command.ts"), "utf8"),
        readFile(resolve("apps/service/src/pdf/inspect-pdf.ts"), "utf8"),
        readFile(resolve("apps/service/src/export/export-coordinator.ts"), "utf8"),
        readFile(resolve("apps/vscode/package.json"), "utf8"),
        readFile(resolve("apps/vscode/src/extension.ts"), "utf8"),
      ]);

    expect(installer).toContain('app_path="$install_root/Placekeeper.app"');
    expect(installer).toContain('built_app="$build_root/Placekeeper.app"');
    expect(installer).toContain("PLACEKEEPER_USER_HOME");
    expect(installer).toContain("PLACEKEEPER_INSTALL_ROOT");
    expect(smoke).toContain('"Library/Application Support/Placekeeper"');
    expect(smoke).toContain('"daemon", "coordinate-install"');
    expect(serviceDaemon).toContain('"PLACEKEEPER_DAEMON_IDENTITY"');
    expect(serviceDaemon).toContain('"PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY"');
    expect(serviceDaemon).toContain('join(appSupportRoot, "lifecycle.lock")');
    expect(launchControl).toContain("export const MANAGEMENT_PROTOCOL_VERSION = 1");
    expect(launchControl).toContain('readonly kind: "exact"');
    expect(launchControl).toContain('readonly kind: "incompatible"');
    expect(hookCommand).toContain('kind: "placekeeper-live-context"');
    expect(pdfInspector).toContain('"application/vnd.placekeeper.rgba+json"');
    expect(exportCoordinator).toContain('`.placekeeper-${randomUUID()}.tmp`');
    expect(JSON.parse(vscodePackage)).toMatchObject({
      name: "placekeeper-vscode",
      activationEvents: ["onCommand:placekeeper.open"],
      contributes: {
        commands: [{ command: "placekeeper.open" }],
        configuration: { properties: { "placekeeper.launcherPath": expect.any(Object) } },
      },
    });
    expect(vscodeExtension).toContain('"placekeeper.review"');

    expect(installer).toContain("Placekeeper.app");
    expect(hookCommand).toContain("Placekeeper.app/Contents/MacOS/placekeeper");
    expect(smoke).toContain('"Applications/Placekeeper.app"');
    expect(serviceDaemon).toContain('"Application Support",\n    "Placekeeper"');
  });

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

  it.runIf(process.platform === "darwin")("offers a non-mutating dry run for the one-command source installer", async () => {
    const installer = await readFile(resolve("install.sh"), "utf8");
    const { stdout } = await execFileAsync("/bin/sh", [resolve("install.sh"), "--dry-run"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, PLACEKEEPER_USER_HOME: "/tmp/placekeeper-installer-home" },
    });
    expect(stdout).toContain("Placekeeper Apple-silicon source install");
    expect(stdout).toContain("Node 24.14.0");
    expect(stdout).toContain("pnpm 11.16.0");
    expect(stdout).toContain("/tmp/placekeeper-installer-home/Applications/Placekeeper.app");
    expect(stdout).toContain("No files were changed");
    expect(installer).toContain("Placekeeper installed successfully");
    expect(installer).toContain("Open With -> Placekeeper");
    expect(installer).toContain("a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3");
    expect(installer).toContain("install --frozen-lockfile");
    expect(installer).not.toContain("xattr");
    expect(installer).not.toContain("spctl --master-disable");
  });

  it.runIf(process.platform === "darwin")("replaces the app transactionally", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-install-test-"));
    const built = resolve(root, "built/Placekeeper.app");
    const app = resolve(root, "home/Applications/Placekeeper.app");
    const helper = resolve("packaging/macos/install-built-app.sh");
    try {
      await mkdir(resolve(built, "Contents/MacOS"), { recursive: true });
      await writeFile(resolve(built, "Contents/MacOS/placekeeper"), "new launcher", { mode: 0o755 });
      await writeFile(resolve(built, "Contents/MacOS/droplet"), "native bridge", { mode: 0o755 });
      await writeFile(resolve(built, "new-app"), "new app");
      await execFileAsync("/bin/sh", [helper, built, app]);
      expect(await readFile(resolve(app, "new-app"), "utf8")).toBe("new app");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the previous app available until candidate daemon readiness succeeds", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-readiness-test-"));
    const built = resolve(root, "built/Placekeeper.app");
    const app = resolve(root, "home/Applications/Placekeeper.app");
    const helper = resolve("packaging/macos/install-built-app.sh");
    const readiness = resolve(app, "Contents/MacOS/placekeeper");
    try {
      await mkdir(resolve(built, "Contents/MacOS"), { recursive: true });
      await writeFile(
        resolve(built, "Contents/MacOS/placekeeper"),
        "#!/bin/sh\nif [ \"${2:-}\" = \"stop-ready\" ]; then exit 0; fi\nexit 1\n",
        { mode: 0o755 },
      );
      await writeFile(resolve(built, "Contents/MacOS/droplet"), "candidate bridge", { mode: 0o755 });
      await writeFile(resolve(built, "candidate-marker"), "candidate");
      await mkdir(app, { recursive: true });
      await writeFile(resolve(app, "previous-marker"), "previous");

      await expect(execFileAsync("/bin/sh", [helper, built, app, readiness])).rejects.toThrow();

      expect(await readFile(resolve(app, "previous-marker"), "utf8")).toBe("previous");
      await expect(readFile(resolve(app, "candidate-marker"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["during-readiness", "at-readiness-exit"] as const)(
    "retires the exact candidate before rollback when interrupted %s",
    async (timing) => {
      const root = await mkdtemp(resolve(tmpdir(), "placekeeper-readiness-signal-"));
      const built = resolve(root, "built/Placekeeper.app");
      const app = resolve(root, "home/Applications/Placekeeper.app");
      const helper = resolve("packaging/macos/install-built-app.sh");
      const readiness = resolve(app, "Contents/MacOS/placekeeper");
      const candidateMarker = resolve(root, "candidate-running");
      const signalLine = timing === "during-readiness"
        ? '  kill -TERM "$PPID"\n'
        : '  trap \'kill -TERM "$PPID"\' EXIT\n';
      const launcher = [
        "#!/bin/sh",
        'if [ "${2:-}" = "ensure-ready" ]; then',
        '  : > "$PLACEKEEPER_TEST_CANDIDATE_MARKER"',
        '  : > "$4"',
        signalLine.trimEnd(),
        "  exit 0",
        "fi",
        'if [ "${2:-}" = "stop-ready" ]; then',
        '  /bin/rm -f "$PLACEKEEPER_TEST_CANDIDATE_MARKER"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n");
      try {
        await mkdir(resolve(built, "Contents/MacOS"), { recursive: true });
        await writeFile(resolve(built, "Contents/MacOS/placekeeper"), launcher, { mode: 0o755 });
        await writeFile(resolve(built, "Contents/MacOS/droplet"), "candidate bridge", { mode: 0o755 });
        await writeFile(resolve(built, "candidate-marker"), "candidate");
        await mkdir(app, { recursive: true });
        await writeFile(resolve(app, "previous-marker"), "previous");

        await expect(execFileAsync("/bin/sh", [helper, built, app, readiness], {
          env: { ...process.env, PLACEKEEPER_TEST_CANDIDATE_MARKER: candidateMarker },
        })).rejects.toThrow();

        expect(await readFile(resolve(app, "previous-marker"), "utf8")).toBe("previous");
        await expect(readFile(resolve(app, "candidate-marker"), "utf8")).rejects.toThrow();
        await expect(readFile(candidateMarker, "utf8")).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("coordinates the daemon before the transactional replacement helper", async () => {
    const installer = await readFile(resolve("install.sh"), "utf8");
    expect(installer).toContain("daemon coordinate-install");
    expect(installer.indexOf("smoke:installed")).toBeLessThan(installer.indexOf("daemon coordinate-install"));
    expect(installer.indexOf("daemon coordinate-install")).toBeLessThan(installer.indexOf("install-built-app.sh"));
    expect(installer).not.toMatch(/(?:kill|pkill|killall).*daemon/u);
    const helper = await readFile(resolve("packaging/macos/install-built-app.sh"), "utf8");
    expect(helper.indexOf('"$readiness_executable" daemon ensure-ready --receipt')).toBeLessThan(helper.lastIndexOf("committed=1"));
    expect(helper.indexOf('"$readiness_executable" daemon stop-ready --receipt')).toBeLessThan(helper.indexOf('if [ "$app_touched" -eq 1 ]'));
    expect(helper.slice(0, helper.lastIndexOf("committed=1"))).not.toMatch(/\bopen\s+--json\b|autosave/u);

    const launchServices = installer.indexOf('launch_services="/System/Library/Frameworks/CoreServices.framework');
    expect(launchServices).toBeGreaterThan(installer.indexOf("daemon coordinate-install"));
    expect(installer.slice(launchServices)).not.toContain("install-built-app.sh");
    expect(installer.slice(launchServices)).toContain("Warning: macOS did not refresh Open With registration");
    expect(installer.slice(launchServices)).toContain("Placekeeper installed successfully");
  });

  it("uses current notarytool submission followed by staple and validation", () => {
    expect(createNotarizationPlan("/tmp/Placekeeper-arm64.zip", "/tmp/Placekeeper.app", "PLACEKEEPER_NOTARY")).toEqual([
      { command: "xcrun", args: ["notarytool", "submit", "/tmp/Placekeeper-arm64.zip", "--keychain-profile", "PLACEKEEPER_NOTARY", "--wait", "--output-format", "json"] },
      { command: "xcrun", args: ["stapler", "staple", "/tmp/Placekeeper.app"] },
      { command: "xcrun", args: ["stapler", "validate", "/tmp/Placekeeper.app"] },
    ]);
  });

  it("translates an installed raw Finder path without putting a capability in process arguments", async () => {
    expect(finderServiceArgs("/tmp/paper.pdf")).toEqual(["open", "--json", "--surface", "finder", "--pdf", "/tmp/paper.pdf"]);
    const launcher = await readFile(resolve("packaging/macos/launcher.mjs"), "utf8");
    expect(launcher).toContain('system attribute "PLACEKEEPER_URL"');
    expect(launcher).toContain("PLACEKEEPER_PDFIUM_WASM");
    expect(launcher).toContain("build-identity.json");
    expect(launcher).toContain("PLACEKEEPER_DAEMON_IDENTITY");
    expect(launcher).toContain("PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY");
    expect(launcher).toContain('PLACEKEEPER_WEB_ASSETS: resolve(resources, "web")');
    expect(launcher.indexOf("...process.env")).toBeLessThan(launcher.indexOf("PLACEKEEPER_WEB_ASSETS:"));
    expect(launcher).toContain('choose file of type {"com.adobe.pdf"}');
    expect(launcher).toContain('result.error?.kind === "input-unavailable"');
    expect(launcher).toContain("realpathSync");
    expect(launcher).not.toContain('"/usr/bin/open"');
    const bridge = await readFile(resolve("packaging/macos/finder-bridge.applescript"), "utf8");
    expect(bridge).toContain("on open pdfItems");
    expect(bridge).toContain("Contents/MacOS/placekeeper");
    expect(bridge).toContain("quoted form of pdfPath");
    expect(bridge).not.toContain("Terminal");
  });

  it("presents Placekeeper on current app and Finder surfaces", async () => {
    const [app, server, launcher, bridge] = await Promise.all([
      readFile(resolve("apps/web/src/app/App.tsx"), "utf8"),
      readFile(resolve("apps/service/src/server/http-server.ts"), "utf8"),
      readFile(resolve("packaging/macos/launcher.mjs"), "utf8"),
      readFile(resolve("packaging/macos/finder-bridge.applescript"), "utf8"),
    ]);

    expect(app).toContain("<h1>Placekeeper</h1>");
    expect(server).toContain("<title>Placekeeper</title>");
    expect(launcher).toContain("Recover Placekeeper draft");
    expect(bridge).toContain('display alert "Placekeeper could not open this file"');
    expect(bridge).toContain('message "Placekeeper opens one local PDF at a time."');
    expect(bridge).toContain("Contents/MacOS/placekeeper");
  });

  it("derives stable daemon and complete artifact identities from packaged bytes", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-build-identity-"));
    const contents = join(root, "Contents");
    const service = join(contents, "Resources/service");
    const web = join(contents, "Resources/web");
    try {
      await mkdir(service, { recursive: true });
      await mkdir(web, { recursive: true });
      await writeFile(join(service, "main.js"), "service-a");
      await writeFile(join(web, "app.js"), "web-a");
      await writeFile(join(contents, "Info.plist"), "plist-a");
      await writeFile(join(contents, "Resources/Placekeeper.icns"), "icon-a");

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

      await writeFile(join(contents, "Resources/Placekeeper.icns"), "icon-b");
      const otherIcon = await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: service, webRoot: web });
      expect(otherIcon.daemonIdentity).toBe(first.daemonIdentity);
      expect(otherIcon.installArtifactIdentity).not.toBe(otherArtifact.installArtifactIdentity);

      await writeFile(join(web, "app.js"), "web-b");
      const otherDaemon = await computePackagedBuildIdentity({ contentsRoot: contents, serviceRoot: service, webRoot: web });
      expect(otherDaemon.daemonIdentity).not.toBe(first.daemonIdentity);
      expect(otherDaemon.installArtifactIdentity).not.toBe(otherIcon.installArtifactIdentity);
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

  it("rejects a missing or operationally incomplete Codex skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-plugin-contract-"));
    const pluginRoot = join(root, "codex-plugin");
    try {
      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true });
      await expect(validateCodexPlugin(pluginRoot)).resolves.toBeUndefined();

      await rm(join(pluginRoot, "skills/placekeeper/SKILL.md"));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/placekeeper.*required|required.*placekeeper/ui);

      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true, force: true });
      const skillPath = join(pluginRoot, "skills/placekeeper/SKILL.md");
      const skill = await readFile(skillPath, "utf8");
      await writeFile(skillPath, skill.replace("A failed refresh blocks completion.", "A failed refresh may be ignored."));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/omitted required contract text/ui);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
