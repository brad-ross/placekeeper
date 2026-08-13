import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { ReviewState } from "../../../packages/core/src/review-model.js";
import {
  inspectPortableAnnotation,
  type PortableAnnotationInspection,
  type VisiblePortableAnnotation,
} from "../../../packages/core/src/portable-annotation.js";
import {
  DraftSnapshotStore,
  type LegacyRecoverableDraft,
  type RecoverableDraftV2,
} from "../../../apps/service/src/recovery/draft-snapshot.js";

const FIXTURE_DIRECTORY = "test/fixtures/compatibility/placekeeper-pre-rebrand";
const LEGACY_APP_DESTINATION = "Applications/PDF Proofreader.app";
const LEGACY_SUPPORT_ROOT = "Library/Application Support/PDF Proofreader";
const RECOVERY_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const LEGACY_BASELINE_IDS = [
  "transactional-pre-rebrand",
  "pre-management-handshake",
] as const;
export type LegacyBaselineId = (typeof LEGACY_BASELINE_IDS)[number];

export interface LegacyBaseline {
  readonly id: LegacyBaselineId;
  readonly sourceCommit: string;
  readonly sourceDate: string;
  readonly lifecycleEvidence: "contract-model";
  readonly replacementMode: "coordinated" | "explicit-legacy-stop";
}

interface FixtureArtifact {
  readonly path: string;
  readonly sha256: string;
}

export interface LegacyCompatibilityFixture {
  readonly root: string;
  readonly claims: {
    readonly physicallyExecutesLegacyBinary: false;
    readonly physicallyExecutesCurrentTransactionHelper: true;
    readonly modeledContracts: readonly string[];
  };
  readonly sourceArtifacts: readonly (FixtureArtifact & { readonly commit: string })[];
  readonly artifacts: readonly FixtureArtifact[];
  readonly baselines: readonly LegacyBaseline[];
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixturePath(root: string, path: string): string {
  if (isAbsolute(path) || path.split("/").includes("..")) {
    throw new Error(`Unsafe legacy fixture path: ${path}`);
  }
  return resolve(root, path);
}

export async function loadLegacyCompatibilityFixture(repoRoot: string): Promise<LegacyCompatibilityFixture> {
  const root = resolve(repoRoot, FIXTURE_DIRECTORY);
  const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")) as Omit<LegacyCompatibilityFixture, "root" | "baselines"> & { schemaVersion: number };
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported legacy compatibility fixture schema");
  if (manifest.claims.physicallyExecutesLegacyBinary !== false) {
    throw new Error("Legacy fixture must not claim that an unpublished binary is executed");
  }
  for (const artifact of manifest.artifacts) {
    const actual = sha256(await readFile(fixturePath(root, artifact.path)));
    if (actual !== artifact.sha256) throw new Error(`Legacy fixture digest mismatch: ${artifact.path}`);
  }
  const baselineDocument = JSON.parse(await readFile(resolve(root, "baselines.json"), "utf8")) as {
    baselines: LegacyBaseline[];
  };
  if (baselineDocument.baselines.map(({ id }) => id).join("|") !== LEGACY_BASELINE_IDS.join("|")) {
    throw new Error("Legacy fixture baselines are missing or out of order");
  }
  return { ...manifest, root, baselines: baselineDocument.baselines };
}

interface LegacyPortableFixture {
  readonly visible: VisiblePortableAnnotation;
  readonly custom: unknown;
}

export interface MaterializedLegacyInstallation {
  readonly baseline: LegacyBaseline;
  readonly appPath: string;
  readonly recoveryRoot: string;
  readonly originalPdf: string;
  readonly pendingRecovery: RecoverableDraftV2;
  readonly legacyAnnotation: LegacyPortableFixture & { readonly inspection: PortableAnnotationInspection };
  readonly vscodeSettings: Record<string, unknown>;
  readonly legacySkill: string;
}

/** Materialize deterministic legacy state, not a runnable legacy app binary. */
export async function materializeLegacyInstallation(
  repoRoot: string,
  isolatedHome: string,
  baselineId: LegacyBaselineId,
): Promise<MaterializedLegacyInstallation> {
  const fixture = await loadLegacyCompatibilityFixture(repoRoot);
  const baseline = fixture.baselines.find(({ id }) => id === baselineId);
  if (baseline === undefined) throw new Error(`Unknown legacy fixture baseline: ${baselineId}`);

  const appPath = resolve(isolatedHome, LEGACY_APP_DESTINATION);
  const recoveryRoot = resolve(isolatedHome, LEGACY_SUPPORT_ROOT);
  const sessionRoot = resolve(recoveryRoot, RECOVERY_SESSION_ID);
  const documents = resolve(isolatedHome, "Documents");
  const originalPdf = resolve(documents, "legacy-original.pdf");
  const sourceSnapshotPath = resolve(sessionRoot, "source.pdf");
  await mkdir(resolve(appPath, "Contents/Resources"), { recursive: true });
  await mkdir(documents, { recursive: true });
  await mkdir(dirname(sourceSnapshotPath), { recursive: true });

  const originalBytes = await readFile(resolve(fixture.root, "original.pdf"));
  await copyFile(resolve(fixture.root, "original.pdf"), originalPdf);
  await copyFile(resolve(fixture.root, "original.pdf"), sourceSnapshotPath);

  const seed = JSON.parse(await readFile(resolve(fixture.root, "recovery-seed.json"), "utf8")) as {
    schemaVersion: 1;
    acknowledgedAt: string;
    state: ReviewState;
  };
  const draft: LegacyRecoverableDraft = {
    schemaVersion: 1,
    canonicalSourcePath: originalPdf,
    sourceSnapshotPath,
    acknowledgedAt: seed.acknowledgedAt,
    state: {
      ...seed.state,
      source: {
        ...seed.state.source,
        digest: sha256(originalBytes),
        byteLength: originalBytes.byteLength,
      },
    },
  };
  const store = new DraftSnapshotStore(sessionRoot);
  await store.persist(draft);
  const pendingRecovery = await store.recover();
  if (pendingRecovery === undefined) throw new Error("Materialized legacy recovery was unreadable");

  const annotation = JSON.parse(
    await readFile(resolve(fixture.root, "legacy-portable-annotation.json"), "utf8"),
  ) as LegacyPortableFixture;
  const inspection = inspectPortableAnnotation(annotation.custom, annotation.visible);
  if (inspection.status !== "owned") throw new Error("Materialized legacy annotation is not editable");

  const vscodeSettings = JSON.parse(await readFile(resolve(fixture.root, "vscode-settings.json"), "utf8")) as Record<string, unknown>;
  const legacySkill = await readFile(resolve(fixture.root, "legacy-skill.md"), "utf8");
  const settingsPath = resolve(isolatedHome, "Library/Application Support/Code/User/settings.json");
  const skillPath = resolve(appPath, "Contents/Resources/integrations/codex-plugin/skills/pdf-proofreader/SKILL.md");
  await mkdir(dirname(settingsPath), { recursive: true });
  await mkdir(dirname(skillPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(vscodeSettings)}\n`);
  await writeFile(skillPath, legacySkill);

  return {
    baseline,
    appPath,
    recoveryRoot,
    originalPdf,
    pendingRecovery,
    legacyAnnotation: { ...annotation, inspection },
    vscodeSettings,
    legacySkill,
  };
}
