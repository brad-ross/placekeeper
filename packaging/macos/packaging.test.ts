import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { DraftSnapshotStore } from "../../apps/service/src/recovery/draft-snapshot.js";
import { projectReviewItem } from "../../packages/core/src/annotation-projection.js";
import { inspectPortableAnnotation } from "../../packages/core/src/portable-annotation.js";
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
  LEGACY_BASELINE_IDS,
  loadLegacyCompatibilityFixture,
  materializeLegacyInstallation,
} from "./test-fixtures/legacy-installation.js";
import {
  appBundlePath,
  compileMacIcon,
  computePackagedBuildIdentity,
  infoPlist,
  infoPlistStrings,
} from "./build-app.js";

const execFileAsync = promisify(execFile);

async function writeUpgradeCandidate(
  repoRoot: string,
  candidate: string,
  readiness: "ready" | "fail",
): Promise<void> {
  const executableRoot = resolve(candidate, "Contents/MacOS");
  const resources = resolve(candidate, "Contents/Resources");
  const launcher = [
    "#!/bin/sh",
    'if [ "${2:-}" = "ensure-ready" ]; then',
    readiness === "ready" ? '  : > "$4"' : "  exit 1",
    "  exit 0",
    "fi",
    'if [ "${2:-}" = "stop-ready" ]; then exit 0; fi',
    "exit 1",
    "",
  ].join("\n");
  await mkdir(executableRoot, { recursive: true });
  await writeFile(resolve(executableRoot, "pdf-proofreader"), launcher, { mode: 0o755 });
  await writeFile(resolve(executableRoot, "droplet"), "candidate bridge", { mode: 0o755 });
  await writeFile(resolve(candidate, "placekeeper-candidate"), readiness);
  await cp(
    resolve(repoRoot, "integrations/codex-plugin"),
    resolve(resources, "integrations/codex-plugin"),
    { recursive: true },
  );
}

describe("macOS distribution manifests", () => {
  it("validates immutable repository-owned pre-rebrand compatibility baselines", async () => {
    const fixture = await loadLegacyCompatibilityFixture(resolve("."));

    expect(fixture.baselines.map(({ id }) => id)).toEqual(LEGACY_BASELINE_IDS);
    expect(fixture.baselines).toEqual([
      expect.objectContaining({
        id: "transactional-pre-rebrand",
        sourceCommit: "4cc17cea25aff0dd2be5d317ca5c44117751a395",
        sourceDate: "2026-08-12T16:32:56-04:00",
        lifecycleEvidence: "contract-model",
        replacementMode: "coordinated",
      }),
      expect.objectContaining({
        id: "pre-management-handshake",
        sourceCommit: "f3d91b395e82424b271943d91eb296d9b06bba93",
        sourceDate: "2026-08-12T09:15:29-04:00",
        lifecycleEvidence: "contract-model",
        replacementMode: "explicit-legacy-stop",
      }),
    ]);
    expect(fixture).not.toHaveProperty("sourceArtifacts");
    expect(fixture.artifacts.map(({ path }) => path)).toEqual([
      "baselines.json",
      "recovery-seed.json",
      "legacy-portable-annotation.json",
      "vscode-settings.json",
      "legacy-skill.md",
      "original.pdf",
    ]);
    expect(fixture.artifacts.every(({ sha256 }) => /^[a-f0-9]{64}$/u.test(sha256))).toBe(true);
    expect(fixture.claims.physicallyExecutesLegacyBinary).toBe(false);
    expect(fixture.claims.physicallyExecutesCurrentTransactionHelper).toBe(true);
  });

  it.each(LEGACY_BASELINE_IDS)("materializes %s with pending recovery and legacy integrations", async (baselineId) => {
    const root = await mkdtemp(resolve(tmpdir(), "placekeeper-legacy-fixture-"));
    try {
      const installation = await materializeLegacyInstallation(resolve("."), root, baselineId);
      expect(installation.appPath).toBe(resolve(root, "Applications/PDF Proofreader.app"));
      expect(installation.recoveryRoot).toBe(resolve(root, "Library/Application Support/PDF Proofreader"));
      expect(installation.pendingRecovery.state).toMatchObject({
        revision: 1,
        items: [{ id: "11111111-1111-4111-8111-111111111111" }],
      });
      expect(installation.pendingRecovery.sync.phase).toBe("not-saved");
      expect(installation.legacyAnnotation).toMatchObject({
        visible: { author: "PDF Proofreader" },
        inspection: { status: "owned" },
      });
      expect(installation.vscodeSettings).toHaveProperty(
        "pdfProofreader.launcherPath",
        "$HOME/Applications/PDF Proofreader.app/Contents/MacOS/pdf-proofreader",
      );
      expect(installation.legacySkill).toContain("name: pdf-proofreader");
      expect(installation.legacySkill).toContain("PDF Proofreader.app/Contents/MacOS/pdf-proofreader");
      await expect(readFile(resolve(root, "Applications/Placekeeper.app"))).rejects.toThrow();
      await expect(readFile(resolve(root, "Library/Application Support/Placekeeper"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "darwin").each(LEGACY_BASELINE_IDS)(
    "carries %s state through deferred, failed, and successful installed upgrades",
    async (baselineId) => {
      const repoRoot = resolve(".");
      const root = await mkdtemp(resolve(tmpdir(), "placekeeper-legacy-upgrade-"));
      const helper = resolve(repoRoot, "packaging/macos/install-built-app.sh");
      const action = resolve(root, "Library/Services/PDF Proofreader.workflow");
      const failedCandidate = resolve(root, "failed/PDF Proofreader.app");
      const readyCandidate = resolve(root, "ready/PDF Proofreader.app");
      try {
        const installation = await materializeLegacyInstallation(repoRoot, root, baselineId);
        const sessionStore = new DraftSnapshotStore(
          resolve(installation.recoveryRoot, installation.pendingRecovery.state.sessionId),
        );
        const settingsPath = resolve(root, "Library/Application Support/Code/User/settings.json");
        const legacySkillPath = resolve(
          installation.appPath,
          "Contents/Resources/integrations/codex-plugin/skills/pdf-proofreader/SKILL.md",
        );
        await writeFile(resolve(installation.appPath, "legacy-installation"), baselineId);
        await mkdir(action, { recursive: true });
        await writeFile(resolve(action, "legacy-action"), baselineId);
        await writeUpgradeCandidate(repoRoot, failedCandidate, "fail");
        await writeUpgradeCandidate(repoRoot, readyCandidate, "ready");

        const initialState = {
          recovery: await readFile(sessionStore.currentPath),
          original: await readFile(installation.originalPdf),
          annotation: await readFile(installation.legacyAnnotationPath),
          settings: await readFile(settingsPath),
          skill: await readFile(legacySkillPath),
        };
        const expectLegacyState = async (): Promise<void> => {
          expect(await readFile(sessionStore.currentPath)).toEqual(initialState.recovery);
          expect(await readFile(installation.originalPdf)).toEqual(initialState.original);
          expect(await readFile(installation.legacyAnnotationPath)).toEqual(initialState.annotation);
          expect(await readFile(settingsPath)).toEqual(initialState.settings);
          expect(await sessionStore.recover()).toEqual(installation.pendingRecovery);
          await expect(readFile(resolve(root, "Library/Application Support/Placekeeper"))).rejects.toThrow();
        };
        const candidateIdentity = {
          daemonIdentity: "b".repeat(64),
          installArtifactIdentity: "c".repeat(64),
        };
        const installedIdentity = {
          daemonIdentity: "a".repeat(64),
          installArtifactIdentity: "a".repeat(64),
        };
        let activeReview = true;
        let legacyStopped = false;
        let daemonPresent = true;
        let replacements = 0;
        const inspect = async () => {
          if (!daemonPresent) return { kind: "absent" as const };
          if (baselineId === "pre-management-handshake" && !legacyStopped) {
            return { kind: "uninspectable" as const, reason: "legacy" as const };
          }
          return {
            kind: "incompatible" as const,
            status: {
              protocolVersion: 1 as const,
              daemonIdentity: installedIdentity.daemonIdentity,
              lifecycle: "accepting" as const,
              activity: { reviewPresence: activeReview ? 1 : 0, codexTasks: 0, transientWork: 0 },
            },
          };
        };
        const coordinate = (candidate: string) => coordinateUpgrade({
          candidate: candidateIdentity,
          installed: installedIdentity,
          inspect,
          shutdown: async () => {
            daemonPresent = false;
            return { status: "accepted" as const };
          },
          waitForRetirement: async () => {},
          replaceAndReady: async () => {
            replacements += 1;
            await execFileAsync("/bin/sh", [
              helper,
              candidate,
              installation.appPath,
              action,
              resolve(installation.appPath, "Contents/MacOS/pdf-proofreader"),
            ]);
          },
        });

        await expect(coordinate(failedCandidate)).rejects.toMatchObject({
          reason: baselineId === "pre-management-handshake" ? "legacy" : "review-presence",
        });
        expect(replacements).toBe(0);
        expect(await readFile(resolve(installation.appPath, "legacy-installation"), "utf8")).toBe(baselineId);
        await expectLegacyState();

        activeReview = false;
        if (baselineId === "pre-management-handshake") {
          legacyStopped = true;
          daemonPresent = false;
        }
        await expect(coordinate(failedCandidate)).rejects.toThrow();
        expect(replacements).toBe(1);
        expect(await readFile(resolve(installation.appPath, "legacy-installation"), "utf8")).toBe(baselineId);
        expect(await readFile(legacySkillPath)).toEqual(initialState.skill);
        expect(await readFile(resolve(action, "legacy-action"), "utf8")).toBe(baselineId);
        await expectLegacyState();

        await expect(coordinate(readyCandidate)).resolves.toEqual({ status: "installed" });
        expect(replacements).toBe(2);
        expect(await readFile(resolve(installation.appPath, "placekeeper-candidate"), "utf8")).toBe("ready");
        await expect(readFile(resolve(installation.appPath, "legacy-installation"))).rejects.toThrow();
        await expect(readFile(resolve(action, "legacy-action"))).rejects.toThrow();
        await expectLegacyState();

        const recovered = await sessionStore.recover();
        expect(recovered).toBeDefined();
        const persistedLegacyAnnotation = JSON.parse(
          await readFile(installation.legacyAnnotationPath, "utf8"),
        ) as {
          readonly custom: unknown;
          readonly visible: typeof installation.legacyAnnotation.visible;
        };
        const legacyInspection = inspectPortableAnnotation(
          persistedLegacyAnnotation.custom,
          persistedLegacyAnnotation.visible,
        );
        expect(legacyInspection.status).toBe("owned");
        if (recovered === undefined || legacyInspection.status !== "owned") {
          throw new Error("Legacy recovery or annotation did not resume after upgrade");
        }
        const editedItem = {
          ...legacyInspection.item,
          updatedAt: "2026-08-13T12:00:00.000Z",
          payload: {
            ...legacyInspection.item.payload,
            proposedText: "edited after Placekeeper upgrade",
          },
        };
        const editedAnnotation = projectReviewItem(editedItem);
        const editedVisible = {
          ...persistedLegacyAnnotation.visible,
          contents: editedAnnotation.contents,
          author: editedAnnotation.author,
        };
        await writeFile(
          installation.legacyAnnotationPath,
          `${JSON.stringify({ visible: editedVisible, custom: editedAnnotation.custom })}\n`,
        );
        expect(inspectPortableAnnotation(editedAnnotation.custom, editedVisible)).toMatchObject({
          status: "owned",
          item: { id: editedItem.id, payload: { proposedText: "edited after Placekeeper upgrade" } },
        });
        await sessionStore.persist({
          ...recovered,
          state: { ...recovered.state, revision: 2, items: [editedItem] },
        });
        await expect(sessionStore.recover()).resolves.toMatchObject({
          state: {
            revision: 2,
            items: [{ id: editedItem.id, payload: { proposedText: "edited after Placekeeper upgrade" } }],
          },
        });
        expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(installation.vscodeSettings);
        for (const skill of ["placekeeper", "pdf-proofreader"]) {
          await expect(readFile(resolve(
            installation.appPath,
            `Contents/Resources/integrations/codex-plugin/skills/${skill}/SKILL.md`,
          ), "utf8")).resolves.toContain(`name: ${skill}`);
        }
        await expect(readFile(resolve(root, "Applications/Placekeeper.app"))).rejects.toThrow();
        await expect(readFile(resolve(root, "Library/Application Support/Placekeeper"))).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("separates the visible Placekeeper identity from the physical compatibility bundle", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as unknown;
    const manifest = validateAppBundleManifest(app);

    expect(manifest).toMatchObject({
      productName: "Placekeeper",
      bundleName: "PDF Proofreader",
      bundleIdentifier: "local.pdf-proofreader",
      executable: "pdf-proofreader",
      finderExecutable: "droplet",
      runtimeDataDirectory: "Library/Application Support/PDF Proofreader",
      documentTypes: [{ contentType: "com.adobe.pdf", role: "Viewer", rank: "Alternate" }],
      icon: {
        master: "packaging/macos/icon/Placekeeper.svg",
        source: "packaging/macos/icon/Placekeeper.iconset",
        file: "Placekeeper",
      },
    });
    expect(appBundlePath("/tmp/placekeeper-package", manifest)).toBe(
      "/tmp/placekeeper-package/PDF Proofreader.app",
    );

    const plist = infoPlist(manifest);
    expect(plist).toContain("<key>CFBundleDisplayName</key><string>PDF Proofreader</string>");
    expect(plist).toContain("<key>CFBundleName</key><string>PDF Proofreader</string>");
    expect(plist).toContain("<key>LSHasLocalizedDisplayName</key><true/>");
    expect(plist).toContain("<key>CFBundleExecutable</key><string>droplet</string>");
    expect(plist).toContain("<key>CFBundleIdentifier</key><string>local.pdf-proofreader</string>");
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

  it("rejects mutations to compatibility identities and visible/physical recoupling", async () => {
    const app = JSON.parse(await readFile(resolve("packaging/macos/app-bundle.json"), "utf8")) as Record<string, unknown>;
    const mutations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["visible product", { productName: "PDF Proofreader" }],
      ["physical bundle", { bundleName: "Placekeeper" }],
      ["bundle identifier", { bundleIdentifier: "local.placekeeper" }],
      ["launcher executable", { executable: "placekeeper" }],
      ["Finder bridge", { finderExecutable: "placekeeper-droplet" }],
      ["runtime data root", { runtimeDataDirectory: "Library/Application Support/Placekeeper" }],
      ["document registration", { documentTypes: [{ contentType: "com.adobe.pdf", role: "Editor", rank: "Owner" }] }],
    ];

    for (const [label, mutation] of mutations) {
      expect(() => validateAppBundleManifest({ ...app, ...mutation }), label).toThrow(/compatibility|Placekeeper/u);
    }
  });

  it("pins the compatibility ledger without pinning the content-derived daemon hash", async () => {
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

    expect(installer).toContain('app_path="$install_root/PDF Proofreader.app"');
    expect(installer).toContain('built_app="$build_root/PDF Proofreader.app"');
    expect(installer).toContain("PDF_PROOFREADER_USER_HOME");
    expect(installer).toContain("PDF_PROOFREADER_INSTALL_ROOT");
    expect(smoke).toContain('"Library/Application Support/PDF Proofreader"');
    expect(smoke).toContain('"daemon", "coordinate-install"');
    expect(serviceDaemon).toContain('"PDF_PROOFREADER_DAEMON_IDENTITY"');
    expect(serviceDaemon).toContain('"PDF_PROOFREADER_INSTALL_ARTIFACT_IDENTITY"');
    expect(serviceDaemon).toContain('join(appSupportRoot, "lifecycle.lock")');
    expect(launchControl).toContain("export const MANAGEMENT_PROTOCOL_VERSION = 1");
    expect(launchControl).toContain('readonly kind: "exact"');
    expect(launchControl).toContain('readonly kind: "incompatible"');
    expect(hookCommand).toContain('kind: "pdf-proofreader-live-context"');
    expect(pdfInspector).toContain('"application/vnd.pdf-proofreader.rgba+json"');
    expect(exportCoordinator).toContain('`.pdf-proofreader-${randomUUID()}.tmp`');
    expect(JSON.parse(vscodePackage)).toMatchObject({
      name: "pdf-proofreader-vscode",
      activationEvents: ["onCommand:pdfProofreader.open"],
      contributes: {
        commands: [{ command: "pdfProofreader.open" }],
        configuration: { properties: { "pdfProofreader.launcherPath": expect.any(Object) } },
      },
    });
    expect(vscodeExtension).toContain('"pdfProofreader.review"');

    for (const source of [installer, serviceDaemon, hookCommand, exportCoordinator, vscodePackage, vscodeExtension]) {
      expect(source).not.toContain("Placekeeper.app");
    }
    expect(smoke).toContain('"Applications/Placekeeper.app"');
    for (const source of [installer, smoke, serviceDaemon, hookCommand, exportCoordinator, vscodePackage, vscodeExtension]) {
      expect(source).not.toContain("Application Support/Placekeeper");
    }
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
      env: { ...process.env, PDF_PROOFREADER_USER_HOME: "/tmp/pdf-proofreader-installer-home" },
    });
    expect(stdout).toContain("Placekeeper Apple-silicon source install");
    expect(stdout).toContain("Node 24.14.0");
    expect(stdout).toContain("pnpm 11.16.0");
    expect(stdout).toContain("/tmp/pdf-proofreader-installer-home/Applications/PDF Proofreader.app");
    expect(stdout).not.toContain("PDF Proofreader Apple-silicon source install");
    expect(stdout).toContain("No files were changed");
    expect(installer).toContain("Placekeeper installed successfully");
    expect(installer).toContain("Open With -> Placekeeper");
    expect(installer).toContain("a1a54f46a750d2523d628d924aab61758a51c9dad3e0238beb14141be9615dd3");
    expect(installer).toContain("install --frozen-lockfile");
    expect(installer).not.toContain("xattr");
    expect(installer).not.toContain("spctl --master-disable");
  });

  it.runIf(process.platform === "darwin")("replaces the app transactionally and restores the app plus obsolete action after a partial failure", async () => {
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

  it("keeps the previous app available until candidate daemon readiness succeeds", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "pdf-proofreader-readiness-test-"));
    const built = resolve(root, "built/PDF Proofreader.app");
    const app = resolve(root, "home/Applications/PDF Proofreader.app");
    const action = resolve(root, "home/Library/Services/PDF Proofreader.workflow");
    const helper = resolve("packaging/macos/install-built-app.sh");
    const readiness = resolve(app, "Contents/MacOS/pdf-proofreader");
    try {
      await mkdir(resolve(built, "Contents/MacOS"), { recursive: true });
      await writeFile(
        resolve(built, "Contents/MacOS/pdf-proofreader"),
        "#!/bin/sh\nif [ \"${2:-}\" = \"stop-ready\" ]; then exit 0; fi\nexit 1\n",
        { mode: 0o755 },
      );
      await writeFile(resolve(built, "Contents/MacOS/droplet"), "candidate bridge", { mode: 0o755 });
      await writeFile(resolve(built, "candidate-marker"), "candidate");
      await mkdir(app, { recursive: true });
      await writeFile(resolve(app, "previous-marker"), "previous");

      await expect(execFileAsync("/bin/sh", [helper, built, app, action, readiness])).rejects.toThrow();

      expect(await readFile(resolve(app, "previous-marker"), "utf8")).toBe("previous");
      await expect(readFile(resolve(app, "candidate-marker"), "utf8")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["during-readiness", "at-readiness-exit"] as const)(
    "retires the exact candidate before rollback when interrupted %s",
    async (timing) => {
      const root = await mkdtemp(resolve(tmpdir(), "pdf-proofreader-readiness-signal-"));
      const built = resolve(root, "built/PDF Proofreader.app");
      const app = resolve(root, "home/Applications/PDF Proofreader.app");
      const action = resolve(root, "home/Library/Services/PDF Proofreader.workflow");
      const helper = resolve("packaging/macos/install-built-app.sh");
      const readiness = resolve(app, "Contents/MacOS/pdf-proofreader");
      const candidateMarker = resolve(root, "candidate-running");
      const signalLine = timing === "during-readiness"
        ? '  kill -TERM "$PPID"\n'
        : '  trap \'kill -TERM "$PPID"\' EXIT\n';
      const launcher = [
        "#!/bin/sh",
        'if [ "${2:-}" = "ensure-ready" ]; then',
        '  : > "$PDF_TEST_CANDIDATE_MARKER"',
        '  : > "$4"',
        signalLine.trimEnd(),
        "  exit 0",
        "fi",
        'if [ "${2:-}" = "stop-ready" ]; then',
        '  /bin/rm -f "$PDF_TEST_CANDIDATE_MARKER"',
        "  exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n");
      try {
        await mkdir(resolve(built, "Contents/MacOS"), { recursive: true });
        await writeFile(resolve(built, "Contents/MacOS/pdf-proofreader"), launcher, { mode: 0o755 });
        await writeFile(resolve(built, "Contents/MacOS/droplet"), "candidate bridge", { mode: 0o755 });
        await writeFile(resolve(built, "candidate-marker"), "candidate");
        await mkdir(app, { recursive: true });
        await writeFile(resolve(app, "previous-marker"), "previous");

        await expect(execFileAsync("/bin/sh", [helper, built, app, action, readiness], {
          env: { ...process.env, PDF_TEST_CANDIDATE_MARKER: candidateMarker },
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
    expect(launcher).toContain('PDF_PROOFREADER_WEB_ASSETS: resolve(resources, "web")');
    expect(launcher.indexOf("...process.env")).toBeLessThan(launcher.indexOf("PDF_PROOFREADER_WEB_ASSETS:"));
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

  it("presents Placekeeper on current app and Finder surfaces while retaining the legacy executable", async () => {
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
    expect(bridge).toContain("Contents/MacOS/pdf-proofreader");
    for (const visibleSurface of [app, server, launcher, bridge]) {
      expect(visibleSurface).not.toContain("PDF Proofreader");
    }
  });

  it("limits the legacy product name in current guidance to documented compatibility locations", async () => {
    const currentGuidance = await Promise.all([
      "README.md",
      "docs/installation.md",
      "docs/privacy-and-recovery.md",
      "docs/support.md",
    ].map(async (path) => await readFile(resolve(path), "utf8")));
    const withoutCompatibilityLocations = currentGuidance.join("\n")
      .replaceAll("PDF Proofreader.app", "LEGACY_BUNDLE.app")
      .replaceAll("PDF Proofreader.workflow", "LEGACY_WORKFLOW.workflow")
      .replaceAll("Application Support/PDF Proofreader", "Application Support/LEGACY_STATE");

    expect(withoutCompatibilityLocations).not.toContain("PDF Proofreader");
    expect(currentGuidance[0]).toContain("focused everyday PDF reader and annotator for serious readers");
    expect(currentGuidance[0]).toContain("packaging/macos/icon/Placekeeper.svg");
    expect(currentGuidance[1]).toContain("stable compatibility path");
    expect(currentGuidance[2]).toContain("legacy technical name");
    expect(currentGuidance[3]).toContain("two-page reference-and-return icon");
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

  it("rejects a missing or operationally divergent Codex skill alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-plugin-contract-"));
    const pluginRoot = join(root, "codex-plugin");
    try {
      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true });
      await expect(validateCodexPlugin(pluginRoot)).resolves.toBeUndefined();

      await rm(join(pluginRoot, "skills/pdf-proofreader/SKILL.md"));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/pdf-proofreader.*alias|alias.*pdf-proofreader/ui);

      await cp(resolve("integrations/codex-plugin"), pluginRoot, { recursive: true, force: true });
      const legacyPath = join(pluginRoot, "skills/pdf-proofreader/SKILL.md");
      const legacy = await readFile(legacyPath, "utf8");
      await writeFile(legacyPath, legacy.replace("A failed refresh blocks completion.", "A failed refresh may be ignored."));
      await expect(validateCodexPlugin(pluginRoot)).rejects.toThrow(/operational.*diverge|diverge.*operational/ui);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
