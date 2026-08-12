import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODEX_INSTALLED_LAUNCHER_COMMAND =
  '"$HOME/Applications/PDF Proofreader.app/Contents/MacOS/pdf-proofreader"';
const CONTROL_REQUEST_TIMEOUT_SECONDS = 5;

interface RuntimeAsset {
  readonly id: string;
  readonly source: string;
  readonly installPath: string;
  readonly sha256: string;
  readonly networkFallbackAllowed: false;
}

export interface BackendRuntimeManifest {
  readonly schemaVersion: 1;
  readonly selectedViewer: string;
  readonly selectedWriter: string;
  readonly targets: readonly ["darwin-arm64"];
  readonly nodeVersion: string;
  readonly packages: Readonly<Record<string, string>>;
  readonly assets: readonly RuntimeAsset[];
  readonly conditionalRuntimes: { readonly java: false; readonly pdfbox: false };
  readonly releaseGate: {
    readonly automatedConformance: "pass";
    readonly applePreview: "pass";
    readonly adobeAcrobatReader: "pass";
  };
}

export interface AppBundleManifest {
  readonly schemaVersion: 1;
  readonly productName: string;
  readonly bundleIdentifier: string;
  readonly bundleVersion: string;
  readonly minimumSystemVersion: string;
  readonly architectures: readonly ["arm64"];
  readonly nodeVersion: string;
  readonly executable: string;
  readonly finderExecutable: "droplet";
  readonly runtimeDataDirectory: string;
  readonly documentTypes: readonly [{ readonly contentType: "com.adobe.pdf"; readonly role: "Viewer"; readonly rank: "Alternate" }];
  readonly embeddedArtifacts: {
    readonly codexPlugin: string;
    readonly vscodeExtension: string;
  };
  readonly distribution: { readonly mode: "source-first"; readonly signingRequired: false };
  readonly signing: { readonly hardenedRuntime: true; readonly secureTimestamp: true; readonly entitlements: string };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

export function validateBackendRuntimeManifest(value: unknown): BackendRuntimeManifest {
  const root = record(value, "backend runtime manifest");
  if (root.schemaVersion !== 1) throw new Error("Unsupported backend manifest version");
  const assets = root.assets;
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("At least one offline runtime asset is required");
  const checkedAssets = assets.map((assetValue, index): RuntimeAsset => {
    const asset = record(assetValue, `asset ${index}`);
    if (asset.networkFallbackAllowed !== false) throw new Error("Runtime assets must forbid network fallback");
    const sha256 = boundedString(asset.sha256, "asset sha256");
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error("Runtime asset digest must be SHA-256");
    const source = boundedString(asset.source, "asset source");
    const installPath = boundedString(asset.installPath, "asset install path");
    if (source.startsWith("/") || source.split("/").includes("..")) throw new Error("Runtime asset source must stay inside the repository");
    if (!installPath.startsWith("Resources/") || installPath.split("/").includes("..")) throw new Error("Runtime assets must install below Contents/Resources");
    return {
      id: boundedString(asset.id, "asset id"),
      source,
      installPath,
      sha256,
      networkFallbackAllowed: false,
    };
  });
  const conditional = record(root.conditionalRuntimes, "conditional runtimes");
  if (conditional.java !== false || conditional.pdfbox !== false) throw new Error("Unselected runtimes cannot be packaged");
  const releaseGate = record(root.releaseGate, "release gate");
  if (
    releaseGate.automatedConformance !== "pass" ||
    releaseGate.applePreview !== "pass" ||
    releaseGate.adobeAcrobatReader !== "pass"
  ) {
    throw new Error("The selected PDF runtime requires passing automated, Preview, and Acrobat gates");
  }
  const packages = record(root.packages, "packages");
  if (!Array.isArray(root.targets) || root.targets.length !== 1 || root.targets[0] !== "darwin-arm64") {
    throw new Error("The source-first runtime target must be Apple silicon");
  }
  return {
    schemaVersion: 1,
    selectedViewer: boundedString(root.selectedViewer, "selected viewer"),
    selectedWriter: boundedString(root.selectedWriter, "selected writer"),
    targets: ["darwin-arm64"],
    nodeVersion: boundedString(root.nodeVersion, "Node version"),
    packages: Object.fromEntries(Object.entries(packages).map(([name, version]) => [name, boundedString(version, `package ${name}`)])),
    assets: checkedAssets,
    conditionalRuntimes: { java: false, pdfbox: false },
    releaseGate: {
      automatedConformance: "pass",
      applePreview: "pass",
      adobeAcrobatReader: "pass",
    },
  };
}

export function validateAppBundleManifest(value: unknown): AppBundleManifest {
  const root = record(value, "app bundle manifest");
  if (root.schemaVersion !== 1) throw new Error("Unsupported app bundle manifest version");
  if (!Array.isArray(root.architectures) || root.architectures.length !== 1 || root.architectures[0] !== "arm64") {
    throw new Error("The source-first app target must be Apple silicon");
  }
  const documentTypes = root.documentTypes;
  if (!Array.isArray(documentTypes) || documentTypes.length !== 1) throw new Error("Exactly one PDF document type is required");
  const documentType = record(documentTypes[0], "document type");
  if (documentType.contentType !== "com.adobe.pdf" || documentType.role !== "Viewer" || documentType.rank !== "Alternate") {
    throw new Error("The app must register as an alternate PDF viewer, not the default handler");
  }
  const signing = record(root.signing, "signing");
  if (signing.hardenedRuntime !== true || signing.secureTimestamp !== true) throw new Error("Hardened runtime and secure timestamp are required");
  const distribution = record(root.distribution, "distribution");
  if (distribution.mode !== "source-first" || distribution.signingRequired !== false) {
    throw new Error("Distribution must be source-first with optional signing");
  }
  const runtimeDataDirectory = boundedString(root.runtimeDataDirectory, "runtime data directory");
  if (runtimeDataDirectory.startsWith("/") || runtimeDataDirectory.startsWith("Contents/") || runtimeDataDirectory.split("/").includes("..")) {
    throw new Error("Mutable runtime data must be a user-relative path outside the signed bundle");
  }
  const rawEmbeddedArtifacts = record(root.embeddedArtifacts, "embedded artifacts");
  const embeddedArtifacts = {
    codexPlugin: boundedString(rawEmbeddedArtifacts.codexPlugin, "Codex plugin artifact"),
    vscodeExtension: boundedString(rawEmbeddedArtifacts.vscodeExtension, "VS Code extension artifact"),
  };
  if (Object.keys(rawEmbeddedArtifacts).some((name) => !["codexPlugin", "vscodeExtension"].includes(name))) {
    throw new Error("Only the Codex plugin and VS Code extension may be embedded integrations");
  }
  if (root.finderExecutable !== "droplet") throw new Error("Finder executable must be the native document bridge");
  if (Object.values(embeddedArtifacts).some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("Embedded artifact sources must stay inside the repository");
  }
  return {
    schemaVersion: 1,
    productName: boundedString(root.productName, "product name"),
    bundleIdentifier: boundedString(root.bundleIdentifier, "bundle identifier"),
    bundleVersion: boundedString(root.bundleVersion, "bundle version"),
    minimumSystemVersion: boundedString(root.minimumSystemVersion, "minimum system version"),
    architectures: ["arm64"],
    nodeVersion: boundedString(root.nodeVersion, "Node version"),
    executable: boundedString(root.executable, "executable"),
    finderExecutable: "droplet",
    runtimeDataDirectory,
    documentTypes: [{ contentType: "com.adobe.pdf", role: "Viewer", rank: "Alternate" }],
    embeddedArtifacts,
    distribution: { mode: "source-first", signingRequired: false },
    signing: {
      hardenedRuntime: true,
      secureTimestamp: true,
      entitlements: boundedString(signing.entitlements, "entitlements path"),
    },
  };
}

export async function validateDistributionManifests(repoRoot = process.cwd()): Promise<void> {
  const app = validateAppBundleManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/app-bundle.json"), "utf8")) as unknown);
  const backend = validateBackendRuntimeManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown);
  if (app.nodeVersion !== backend.nodeVersion) throw new Error("App and backend Node versions differ");
  for (const asset of backend.assets) {
    const bytes = await readFile(resolve(repoRoot, asset.source));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new Error(`Runtime asset digest mismatch: ${asset.id}`);
  }
  const pluginRoot = resolve(repoRoot, app.embeddedArtifacts.codexPlugin);
  const plugin = JSON.parse(await readFile(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8")) as unknown;
  const pluginManifest = record(plugin, "Codex plugin manifest");
  if (pluginManifest.skills !== "./skills/") throw new Error("The Codex plugin must expose its installed skill directory");
  const hooks = JSON.parse(await readFile(resolve(pluginRoot, "hooks/hooks.json"), "utf8")) as unknown;
  const hooksRoot = record(record(hooks, "Codex hook manifest").hooks, "Codex hook events");
  for (const event of ["PostToolUse", "UserPromptSubmit", "SessionEnd"] as const) {
    if (!Array.isArray(hooksRoot[event]) || hooksRoot[event].length !== 1) {
      throw new Error(`The packaged Codex plugin must declare exactly one ${event} hook`);
    }

    const declaration = record(hooksRoot[event][0], `${event} hook declaration`);
    if (!Array.isArray(declaration.hooks) || declaration.hooks.length !== 1) {
      throw new Error(`The packaged Codex plugin must declare exactly one ${event} handler`);
    }
    const handler = record(declaration.hooks[0], `${event} hook handler`);
    const expectedCommand = `${CODEX_INSTALLED_LAUNCHER_COMMAND} hook --event`;
    if (handler.command !== expectedCommand) {
      throw new Error(`The packaged ${event} hook must use the canonical installed launcher`);
    }
    if (event === "SessionEnd") {
      if (handler.timeout !== 3) {
        throw new Error("The packaged SessionEnd hook must remain within Codex's 3-second limit");
      }
    } else if (
      typeof handler.timeout !== "number" ||
      handler.timeout <= CONTROL_REQUEST_TIMEOUT_SECONDS
    ) {
      throw new Error(
        `The packaged ${event} hook timeout must exceed the ${CONTROL_REQUEST_TIMEOUT_SECONDS}-second control client timeout`,
      );
    }
  }
  const skill = await readFile(resolve(pluginRoot, "skills/pdf-proofreader/SKILL.md"), "utf8");
  if (
    !skill.includes(
      `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf <absolute-local-pdf-path>`,
    )
  ) {
    throw new Error("The packaged PDF Proofreader skill must use the canonical installed launcher");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await validateDistributionManifests();
  process.stdout.write("Distribution manifests and offline runtime assets are valid.\n");
}
