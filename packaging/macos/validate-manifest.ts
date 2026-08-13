import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

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
  readonly productName: "Placekeeper";
  readonly bundleName: "PDF Proofreader";
  readonly bundleIdentifier: "local.pdf-proofreader";
  readonly bundleVersion: string;
  readonly minimumSystemVersion: string;
  readonly architectures: readonly ["arm64"];
  readonly nodeVersion: string;
  readonly executable: "pdf-proofreader";
  readonly finderExecutable: "droplet";
  readonly runtimeDataDirectory: "Library/Application Support/PDF Proofreader";
  readonly icon: {
    readonly master: "packaging/macos/icon/Placekeeper.svg";
    readonly source: "packaging/macos/icon/Placekeeper.iconset";
    readonly file: "Placekeeper";
  };
  readonly documentTypes: readonly [{ readonly contentType: "com.adobe.pdf"; readonly role: "Viewer"; readonly rank: "Alternate" }];
  readonly embeddedArtifacts: {
    readonly codexPlugin: string;
    readonly vscodeExtension: string;
  };
  readonly distribution: { readonly mode: "source-first"; readonly signingRequired: false };
  readonly signing: { readonly hardenedRuntime: true; readonly secureTimestamp: true; readonly entitlements: string };
}

export const MAC_ICON_REPRESENTATIONS = [
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
] as const;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngPixelEvidence(bytes: Buffer, filename: string): { width: number; height: number } {
  if (bytes.byteLength < 33 || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error(`Icon representation ${filename} must be a PNG file`);
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`Icon representation ${filename} has an invalid PNG header`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== height) throw new Error(`Icon representation ${filename} must be square`);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`Icon representation ${filename} must be an 8-bit RGB or RGBA non-interlaced PNG`);
  }

  const compressed: Buffer[] = [];
  let offset = PNG_SIGNATURE.byteLength;
  let sawEnd = false;
  while (offset + 12 <= bytes.byteLength) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.byteLength) throw new Error(`Icon representation ${filename} has a truncated PNG chunk`);
    if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = end;
  }
  if (compressed.length === 0 || !sawEnd) throw new Error(`Icon representation ${filename} has incomplete PNG content`);

  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  let decoded: Buffer;
  try {
    decoded = inflateSync(Buffer.concat(compressed));
  } catch {
    throw new Error(`Icon representation ${filename} has invalid PNG pixel data`);
  }
  if (decoded.byteLength !== (rowBytes + 1) * height) {
    throw new Error(`Icon representation ${filename} has invalid PNG pixel dimensions`);
  }

  const previous = Buffer.alloc(rowBytes);
  const current = Buffer.alloc(rowBytes);
  const visibleColors = new Set<string>();
  let hasVisiblePixel = false;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (rowBytes + 1);
    const filter = decoded[rowOffset]!;
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = decoded[rowOffset + 1 + x]!;
      const left = x >= channels ? current[x - channels]! : 0;
      const above = previous[x]!;
      const upperLeft = x >= channels ? previous[x - channels]! : 0;
      if (filter === 0) current[x] = raw;
      else if (filter === 1) current[x] = (raw + left) & 0xff;
      else if (filter === 2) current[x] = (raw + above) & 0xff;
      else if (filter === 3) current[x] = (raw + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const estimate = left + above - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const aboveDistance = Math.abs(estimate - above);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        const predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
          ? left
          : aboveDistance <= upperLeftDistance ? above : upperLeft;
        current[x] = (raw + predictor) & 0xff;
      } else {
        throw new Error(`Icon representation ${filename} uses an unsupported PNG filter`);
      }
    }
    for (let x = 0; x < rowBytes; x += channels) {
      const alpha = channels === 4 ? current[x + 3]! : 255;
      if (alpha === 0) continue;
      hasVisiblePixel = true;
      if (visibleColors.size < 2) {
        visibleColors.add(`${current[x]},${current[x + 1]},${current[x + 2]},${alpha}`);
      }
    }
    current.copy(previous);
  }
  if (!hasVisiblePixel || visibleColors.size < 2) {
    throw new Error(`Icon representation ${filename} must have nonempty alpha and content bounds`);
  }
  return { width, height };
}

export async function validateMacIconSet(iconsetPath: string): Promise<Array<[string, number]>> {
  const filenames = (await readdir(iconsetPath)).sort();
  const expected = MAC_ICON_REPRESENTATIONS.map(([filename]) => filename).sort();
  if (filenames.length !== expected.length || filenames.some((filename, index) => filename !== expected[index])) {
    throw new Error(`Placekeeper iconset filenames must be exactly: ${expected.join(", ")}`);
  }
  for (const [filename, expectedPixels] of MAC_ICON_REPRESENTATIONS) {
    const { width, height } = pngPixelEvidence(await readFile(resolve(iconsetPath, filename)), filename);
    if (width !== expectedPixels || height !== expectedPixels) {
      throw new Error(`Icon representation ${filename} dimensions must be ${expectedPixels}x${expectedPixels}`);
    }
  }
  return MAC_ICON_REPRESENTATIONS.map(([filename, pixels]) => [filename, pixels]);
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

function compatibilityValue<const Expected extends string>(
  value: unknown,
  expected: Expected,
  label: string,
): Expected {
  if (value !== expected) {
    throw new Error(`${label} is a pinned compatibility identity and must remain ${expected}`);
  }
  return expected;
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
  if (root.productName !== "Placekeeper") throw new Error("The visible product name must remain Placekeeper");
  const bundleName = compatibilityValue(root.bundleName, "PDF Proofreader", "Physical bundle name");
  if (root.productName === bundleName) {
    throw new Error("Visible and physical bundle identities must remain separate");
  }
  if (!Array.isArray(root.architectures) || root.architectures.length !== 1 || root.architectures[0] !== "arm64") {
    throw new Error("The source-first app target must be Apple silicon");
  }
  const documentTypes = root.documentTypes;
  if (!Array.isArray(documentTypes) || documentTypes.length !== 1) throw new Error("Exactly one PDF document type is required");
  const documentType = record(documentTypes[0], "document type");
  if (documentType.contentType !== "com.adobe.pdf" || documentType.role !== "Viewer" || documentType.rank !== "Alternate") {
    throw new Error("PDF document registration is a pinned compatibility identity and must remain an alternate viewer");
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
  compatibilityValue(
    runtimeDataDirectory,
    "Library/Application Support/PDF Proofreader",
    "Runtime data directory",
  );
  const rawIcon = record(root.icon, "icon");
  const icon = {
    master: compatibilityValue(rawIcon.master, "packaging/macos/icon/Placekeeper.svg", "Icon master"),
    source: compatibilityValue(rawIcon.source, "packaging/macos/icon/Placekeeper.iconset", "Icon source"),
    file: compatibilityValue(rawIcon.file, "Placekeeper", "Icon file"),
  } as const;
  if (Object.keys(rawIcon).some((name) => !["master", "source", "file"].includes(name))) {
    throw new Error("Only the production master, iconset source, and resource basename may own the app icon");
  }
  const rawEmbeddedArtifacts = record(root.embeddedArtifacts, "embedded artifacts");
  const embeddedArtifacts = {
    codexPlugin: boundedString(rawEmbeddedArtifacts.codexPlugin, "Codex plugin artifact"),
    vscodeExtension: boundedString(rawEmbeddedArtifacts.vscodeExtension, "VS Code extension artifact"),
  };
  if (Object.keys(rawEmbeddedArtifacts).some((name) => !["codexPlugin", "vscodeExtension"].includes(name))) {
    throw new Error("Only the Codex plugin and VS Code extension may be embedded integrations");
  }
  compatibilityValue(root.finderExecutable, "droplet", "Finder executable");
  if (Object.values(embeddedArtifacts).some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("Embedded artifact sources must stay inside the repository");
  }
  return {
    schemaVersion: 1,
    productName: "Placekeeper",
    bundleName,
    bundleIdentifier: compatibilityValue(root.bundleIdentifier, "local.pdf-proofreader", "Bundle identifier"),
    bundleVersion: boundedString(root.bundleVersion, "bundle version"),
    minimumSystemVersion: boundedString(root.minimumSystemVersion, "minimum system version"),
    architectures: ["arm64"],
    nodeVersion: boundedString(root.nodeVersion, "Node version"),
    executable: compatibilityValue(root.executable, "pdf-proofreader", "Launcher executable"),
    finderExecutable: "droplet",
    runtimeDataDirectory,
    icon,
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
  const iconMaster = await readFile(resolve(repoRoot, app.icon.master), "utf8");
  if (!iconMaster.includes("<svg") || /<rect[^>]+width="220"[^>]+rx=/u.test(iconMaster)) {
    throw new Error("The production icon master must be an SVG without a pre-masked system corner");
  }
  await validateMacIconSet(resolve(repoRoot, app.icon.source));
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
  if (/(^|[^/A-Za-z0-9_-])pdf-proofreader\s+(context|daemon)\b/mu.test(skill)) {
    throw new Error("The packaged PDF Proofreader skill must not publish bare context or daemon commands");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await validateDistributionManifests();
  process.stdout.write("Distribution manifests and offline runtime assets are valid.\n");
}
