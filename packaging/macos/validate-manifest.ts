import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  readonly targets: readonly ["darwin-arm64", "darwin-x64"];
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
  readonly architectures: readonly ["arm64", "x64"];
  readonly nodeVersion: string;
  readonly executable: string;
  readonly runtimeDataDirectory: string;
  readonly documentTypes: readonly [{ readonly contentType: "com.adobe.pdf"; readonly role: "Viewer"; readonly rank: "Alternate" }];
  readonly embeddedArtifacts: Readonly<Record<string, string>>;
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
  if (!Array.isArray(root.targets) || root.targets.length !== 2 || root.targets[0] !== "darwin-arm64" || root.targets[1] !== "darwin-x64") {
    throw new Error("Both macOS runtime targets are required");
  }
  return {
    schemaVersion: 1,
    selectedViewer: boundedString(root.selectedViewer, "selected viewer"),
    selectedWriter: boundedString(root.selectedWriter, "selected writer"),
    targets: ["darwin-arm64", "darwin-x64"],
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
  if (!Array.isArray(root.architectures) || root.architectures.length !== 2 || root.architectures[0] !== "arm64" || root.architectures[1] !== "x64") {
    throw new Error("Both arm64 and x64 package targets are required");
  }
  const documentTypes = root.documentTypes;
  if (!Array.isArray(documentTypes) || documentTypes.length !== 1) throw new Error("Exactly one PDF document type is required");
  const documentType = record(documentTypes[0], "document type");
  if (documentType.contentType !== "com.adobe.pdf" || documentType.role !== "Viewer" || documentType.rank !== "Alternate") {
    throw new Error("The app must register as an alternate PDF viewer, not the default handler");
  }
  const signing = record(root.signing, "signing");
  if (signing.hardenedRuntime !== true || signing.secureTimestamp !== true) throw new Error("Hardened runtime and secure timestamp are required");
  const runtimeDataDirectory = boundedString(root.runtimeDataDirectory, "runtime data directory");
  if (runtimeDataDirectory.startsWith("/") || runtimeDataDirectory.startsWith("Contents/") || runtimeDataDirectory.split("/").includes("..")) {
    throw new Error("Mutable runtime data must be a user-relative path outside the signed bundle");
  }
  const embeddedArtifacts = Object.fromEntries(Object.entries(record(root.embeddedArtifacts, "embedded artifacts")).map(([name, path]) => [name, boundedString(path, `artifact ${name}`)]));
  if (Object.values(embeddedArtifacts).some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("Embedded artifact sources must stay inside the repository");
  }
  return {
    schemaVersion: 1,
    productName: boundedString(root.productName, "product name"),
    bundleIdentifier: boundedString(root.bundleIdentifier, "bundle identifier"),
    bundleVersion: boundedString(root.bundleVersion, "bundle version"),
    minimumSystemVersion: boundedString(root.minimumSystemVersion, "minimum system version"),
    architectures: ["arm64", "x64"],
    nodeVersion: boundedString(root.nodeVersion, "Node version"),
    executable: boundedString(root.executable, "executable"),
    runtimeDataDirectory,
    documentTypes: [{ contentType: "com.adobe.pdf", role: "Viewer", rank: "Alternate" }],
    embeddedArtifacts,
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
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await validateDistributionManifests();
  process.stdout.write("Distribution manifests and offline runtime assets are valid.\n");
}
