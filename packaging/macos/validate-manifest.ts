import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const CODEX_INSTALLED_LAUNCHER_COMMAND =
  '"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper"';
const CONTROL_REQUEST_TIMEOUT_SECONDS = 5;

export const CATALOG_NOTICE_RESOURCE_PATH = "Resources/THIRD_PARTY_NOTICES.md";

export const CATALOG_DISTRIBUTION_BASELINE = {
  records: 3_060,
  indexCardinalities: {
    glyph: 3_060,
    command: 2_795,
    entity: 1_975,
    normalizedName: 4_724,
  },
  artifactBytes: {
    runtime: 406_546,
    report: 7_361,
  },
  artifactSha256: {
    runtime: "423428687dab0b6049a86d85f879df79f2fee251322d53ad314ae1effd616e3b",
    report: "84bda58674d8174a0a94bbaed846ce23628cbf62fcab018cef14b182d38db797",
    thirdPartyNotices: "e25a92f59af5cab8b24d384aefadb93e1de4fd783492d2022200b4493233e91f",
  },
  productionWebJavaScriptBytes: 2_448_255,
} as const;

const CATALOG_ATTRIBUTION_URLS = [
  "https://www.unicode.org/Public/17.0.0/ucd/",
  "https://raw.githubusercontent.com/w3c/xml-entities/ed8b732d7d38112f258e74aadecbb1e409eafdd9/unicode.xml",
  "https://www.w3.org/copyright/software-license-2002/",
] as const;

const FORBIDDEN_CATALOG_RUNTIME_MARKERS = [
  ...CATALOG_ATTRIBUTION_URLS,
  "ed8b732d7d38112f258e74aadecbb1e409eafdd9",
  "catalog:update",
  "updateCatalogSources",
  "source-manifest.json",
  "catalog.audit.json",
  "update-report.json",
  "DerivedName.txt",
  "DerivedGeneralCategory.txt",
  "DerivedCoreProperties.txt",
  "UnicodeData.txt",
  "unicode.xml",
  "# DerivedName-17.0.0.txt",
  "# DerivedGeneralCategory-17.0.0.txt",
  "# DerivedCoreProperties-17.0.0.txt",
] as const;

const CATALOG_RUNTIME_TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ts", ".txt", ".xml",
]);

export function validateCatalogThirdPartyNotices(source: string): void {
  const required = [
    "UNICODE LICENSE V3",
    "W3C Software Notice and License",
    "Copyright David Carlisle 1999-2025",
    "Modification notice: On 2026-08-23",
    ...CATALOG_ATTRIBUTION_URLS,
  ];
  for (const marker of required) {
    if (!source.includes(marker)) {
      throw new Error(`Mathematical symbol catalog notice is missing required attribution: ${marker}`);
    }
  }
  const actual = createHash("sha256").update(source, "utf8").digest("hex");
  if (actual !== CATALOG_DISTRIBUTION_BASELINE.artifactSha256.thirdPartyNotices) {
    throw new Error("Mathematical symbol catalog notice does not match the reviewed complete content");
  }
}

interface CatalogRuntimeDistributionOptions {
  readonly runtimeRoot: string;
  readonly webEntry: string;
  readonly noticePath: string;
}

const catalogRuntimeFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported catalog runtime entry: ${relative(root, path)}`);
    }
  };
  await visit(root);
  return files;
};

export async function validateCatalogRuntimeDistribution(
  options: CatalogRuntimeDistributionOptions,
): Promise<void> {
  const runtimeRoot = resolve(options.runtimeRoot);
  const noticePath = resolve(options.noticePath);
  const webEntry = resolve(options.webEntry);
  const notice = await readFile(noticePath, "utf8");
  validateCatalogThirdPartyNotices(notice);

  const webBytes = await readFile(webEntry);
  if (webBytes.byteLength > CATALOG_DISTRIBUTION_BASELINE.productionWebJavaScriptBytes) {
    throw new Error(
      `Production web JavaScript exceeds the reviewed ${CATALOG_DISTRIBUTION_BASELINE.productionWebJavaScriptBytes}-byte catalog bundle baseline: ${webBytes.byteLength}`,
    );
  }
  const webSource = webBytes.toString("utf8");
  for (const marker of ["⏐", "vertical line extension"] as const) {
    if (!webSource.includes(marker)) {
      throw new Error(`Production web JavaScript is missing compact catalog behavior: ${marker}`);
    }
  }

  for (const path of await catalogRuntimeFiles(runtimeRoot)) {
    if (path === noticePath) continue;
    const runtimePath = relative(runtimeRoot, path).replaceAll("\\", "/");
    if (/(?:^|\/)(?:sources|generated)\/|(?:Derived(?:Name|GeneralCategory|CoreProperties)\.txt|UnicodeData\.txt|unicode\.xml)(?:\.gz)?$|(?:catalog\.audit|update-report|source-manifest)\.json$|(?:^|\/)pdf-symbol-catalog\/(?:compile|generate|update)\.(?:c?js|mjs|ts)$/iu.test(runtimePath)) {
      throw new Error(`Catalog source or audit artifact must not ship in runtime assets: ${runtimePath}`);
    }
    if (!CATALOG_RUNTIME_TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const source = await readFile(path, "utf8");
    for (const marker of FORBIDDEN_CATALOG_RUNTIME_MARKERS) {
      if (source.includes(marker)) {
        throw new Error(`Catalog source, update, or attribution marker leaked into runtime asset ${runtimePath}: ${marker}`);
      }
    }
  }
}

export async function validateCatalogSourceBaseline(repoRoot: string): Promise<void> {
  const [runtime, reportSource] = await Promise.all([
    readFile(resolve(repoRoot, "apps/web/src/pdf/pdf-symbol-catalog.generated.ts")),
    readFile(resolve(repoRoot, "scripts/pdf-symbol-catalog/generated/update-report.json")),
  ]);
  const report = JSON.parse(reportSource.toString("utf8")) as {
    counts?: { records?: number };
    indexCardinalities?: Record<string, number>;
    artifactBytes?: Record<string, number>;
  };
  const expected = CATALOG_DISTRIBUTION_BASELINE;
  const artifactBytes = {
    runtime: report.artifactBytes?.runtime,
    report: report.artifactBytes?.report,
  };
  if (report.counts?.records !== expected.records
    || JSON.stringify(report.indexCardinalities) !== JSON.stringify(expected.indexCardinalities)
    || JSON.stringify(artifactBytes) !== JSON.stringify(expected.artifactBytes)
    || runtime.byteLength !== expected.artifactBytes.runtime
    || reportSource.byteLength !== expected.artifactBytes.report) {
    throw new Error("Mathematical symbol catalog record, index-cardinality, or committed artifact-byte baseline changed; review and update the distribution baseline with the generated report");
  }
  const actualSha256 = {
    runtime: createHash("sha256").update(runtime).digest("hex"),
    report: createHash("sha256").update(reportSource).digest("hex"),
  };
  if (actualSha256.runtime !== expected.artifactSha256.runtime
    || actualSha256.report !== expected.artifactSha256.report) {
    throw new Error("Mathematical symbol catalog committed artifact digest baseline changed; review and update the distribution baseline with the generated artifacts");
  }
  if (/"(?:duration|elapsed|timing|wallClock|milliseconds?|generatedAt|timestamp)[^"]*"\s*:/iu.test(reportSource.toString("utf8"))) {
    throw new Error("Deterministic catalog report must not contain wall-clock timing fields");
  }
}

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
  readonly bundleName: "Placekeeper";
  readonly bundleIdentifier: "local.placekeeper";
  readonly bundleVersion: string;
  readonly minimumSystemVersion: string;
  readonly architectures: readonly ["arm64"];
  readonly nodeVersion: string;
  readonly executable: "placekeeper";
  readonly finderExecutable: "droplet";
  readonly runtimeDataDirectory: "Library/Application Support/Placekeeper";
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
  ["icon_16x16.png", 16, "icp4"],
  ["icon_16x16@2x.png", 32, "ic11"],
  ["icon_32x32.png", 32, "icp5"],
  ["icon_32x32@2x.png", 64, "ic12"],
  ["icon_128x128.png", 128, "ic07"],
  ["icon_128x128@2x.png", 256, "ic13"],
  ["icon_256x256.png", 256, "ic08"],
  ["icon_256x256@2x.png", 512, "ic14"],
  ["icon_512x512.png", 512, "ic09"],
  ["icon_512x512@2x.png", 1024, "ic10"],
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

function requiredValue<const Expected extends string>(
  value: unknown,
  expected: Expected,
  label: string,
): Expected {
  if (value !== expected) {
    throw new Error(`${label} must remain ${expected}`);
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
  const bundleName = requiredValue(root.bundleName, "Placekeeper", "Physical bundle name");
  if (!Array.isArray(root.architectures) || root.architectures.length !== 1 || root.architectures[0] !== "arm64") {
    throw new Error("The source-first app target must be Apple silicon");
  }
  const documentTypes = root.documentTypes;
  if (!Array.isArray(documentTypes) || documentTypes.length !== 1) throw new Error("Exactly one PDF document type is required");
  const documentType = record(documentTypes[0], "document type");
  if (documentType.contentType !== "com.adobe.pdf" || documentType.role !== "Viewer" || documentType.rank !== "Alternate") {
    throw new Error("PDF document registration must remain an alternate viewer");
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
  const checkedRuntimeDataDirectory = requiredValue(
    runtimeDataDirectory,
    "Library/Application Support/Placekeeper",
    "Runtime data directory",
  );
  const rawIcon = record(root.icon, "icon");
  const icon = {
    master: requiredValue(rawIcon.master, "packaging/macos/icon/Placekeeper.svg", "Icon master"),
    source: requiredValue(rawIcon.source, "packaging/macos/icon/Placekeeper.iconset", "Icon source"),
    file: requiredValue(rawIcon.file, "Placekeeper", "Icon file"),
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
  requiredValue(root.finderExecutable, "droplet", "Finder executable");
  if (Object.values(embeddedArtifacts).some((path) => path.startsWith("/") || path.split("/").includes(".."))) {
    throw new Error("Embedded artifact sources must stay inside the repository");
  }
  return {
    schemaVersion: 1,
    productName: "Placekeeper",
    bundleName,
    bundleIdentifier: requiredValue(root.bundleIdentifier, "local.placekeeper", "Bundle identifier"),
    bundleVersion: boundedString(root.bundleVersion, "bundle version"),
    minimumSystemVersion: boundedString(root.minimumSystemVersion, "minimum system version"),
    architectures: ["arm64"],
    nodeVersion: boundedString(root.nodeVersion, "Node version"),
    executable: requiredValue(root.executable, "placekeeper", "Launcher executable"),
    finderExecutable: "droplet",
    runtimeDataDirectory: checkedRuntimeDataDirectory,
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

export const CODEX_SKILL_NAME = "placekeeper";

const CODEX_HOOK_SPECS = {
  PostToolUse: {
    timeout: 8,
    additionalContextLimit: 131072,
    statusMessage: "Connecting Placekeeper context",
    matcher: "^Bash$",
  },
  UserPromptSubmit: {
    timeout: 8,
    additionalContextLimit: 131072,
    statusMessage: "Refreshing Placekeeper context",
  },
  SessionEnd: {
    timeout: 3,
    additionalContextLimit: 256,
    statusMessage: "Disconnecting Placekeeper context",
  },
} as const;
type CodexHookEvent = keyof typeof CODEX_HOOK_SPECS;

export function normalizeCodexSkillContract(
  skill: string,
): string {
  if (!skill.startsWith("---\n")) {
    throw new Error(`The packaged ${CODEX_SKILL_NAME} skill must start with frontmatter`);
  }
  const frontmatterEnd = skill.indexOf("\n---\n", 4);
  if (frontmatterEnd < 0) {
    throw new Error(`The packaged ${CODEX_SKILL_NAME} skill has unterminated frontmatter`);
  }
  const entries = skill
    .slice(4, frontmatterEnd)
    .split("\n")
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) {
        throw new Error(`The packaged ${CODEX_SKILL_NAME} skill has invalid frontmatter`);
      }
      return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
    });
  if (
    entries.length !== 2 ||
    entries[0]?.[0] !== "name" ||
    entries[1]?.[0] !== "description"
  ) {
    throw new Error(
      `The packaged ${CODEX_SKILL_NAME} skill may declare only name and description metadata`,
    );
  }
  if (entries[0][1] !== CODEX_SKILL_NAME) {
    throw new Error(`The packaged ${CODEX_SKILL_NAME} skill must declare name: ${CODEX_SKILL_NAME}`);
  }
  if (!entries[1][1].includes(`$${CODEX_SKILL_NAME}`)) {
    throw new Error(`The packaged ${CODEX_SKILL_NAME} skill description must expose $${CODEX_SKILL_NAME}`);
  }
  return skill.slice(frontmatterEnd + "\n---\n".length);
}

async function requiredSkill(pluginRoot: string): Promise<string> {
  try {
    return await readFile(resolve(pluginRoot, `skills/${CODEX_SKILL_NAME}/SKILL.md`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`The packaged ${CODEX_SKILL_NAME} skill is required`);
    }
    throw error;
  }
}

function validatePluginIdentity(pluginManifest: Record<string, unknown>): void {
  if (pluginManifest.skills !== "./skills/") throw new Error("The Codex plugin must expose its installed skill directory");
  const pluginAuthor = record(pluginManifest.author, "Codex plugin author");
  const pluginInterface = record(pluginManifest.interface, "Codex plugin interface");
  if (
    pluginAuthor.name !== "Placekeeper" ||
    pluginInterface.displayName !== "Placekeeper" ||
    pluginInterface.developerName !== "Placekeeper"
  ) {
    throw new Error("The packaged Codex plugin visible identity must remain Placekeeper");
  }
  if (pluginInterface.defaultPrompt !== "Open this local PDF in Placekeeper with $placekeeper.") {
    throw new Error("The packaged Codex plugin default prompt must prefer $placekeeper");
  }
  if (
    pluginInterface.brandColor !== "#264F7D" ||
    pluginInterface.composerIcon !== "./assets/placekeeper.svg" ||
    pluginInterface.logo !== "./assets/placekeeper.svg" ||
    pluginInterface.logoDark !== "./assets/placekeeper.svg"
  ) {
    throw new Error("The packaged Codex plugin must expose the Placekeeper app icon and brand color");
  }
}

function validateHookContract(hookManifest: Record<string, unknown>): void {
  if (hookManifest.description !== "Task-scoped Placekeeper lifecycle hooks.") {
    throw new Error("The packaged Codex hook description must use Placekeeper");
  }
  const hooksRoot = record(hookManifest.hooks, "Codex hook events");
  const expectedEvents = Object.keys(CODEX_HOOK_SPECS).sort();
  if (Object.keys(hooksRoot).sort().join("\0") !== expectedEvents.join("\0")) {
    throw new Error("The packaged Codex plugin must declare one plugin-global hook set");
  }
  for (const event of Object.keys(CODEX_HOOK_SPECS) as CodexHookEvent[]) {
    const declarations = hooksRoot[event];
    if (!Array.isArray(declarations) || declarations.length !== 1) {
      throw new Error(`The packaged Codex plugin must declare exactly one ${event} hook`);
    }

    const declaration = record(declarations[0], `${event} hook declaration`);
    const expected = CODEX_HOOK_SPECS[event];
    const expectedMatcher = "matcher" in expected
      ? expected.matcher
      : undefined;
    if (declaration.matcher !== expectedMatcher) {
      throw new Error(`The packaged ${event} hook matcher changed`);
    }
    if (!Array.isArray(declaration.hooks) || declaration.hooks.length !== 1) {
      throw new Error(`The packaged Codex plugin must declare exactly one ${event} handler`);
    }
    const handler = record(declaration.hooks[0], `${event} hook handler`);
    const expectedCommand = `${CODEX_INSTALLED_LAUNCHER_COMMAND} hook --event`;
    if (handler.type !== "command" || handler.command !== expectedCommand) {
      throw new Error(`The packaged ${event} hook must use the canonical installed launcher command`);
    }
    if (
      handler.timeout !== expected.timeout ||
      handler.additionalContextLimit !== expected.additionalContextLimit ||
      handler.statusMessage !== expected.statusMessage
    ) {
      throw new Error(`The packaged ${event} hook timeout, context limit, or status changed`);
    }
    if (event !== "SessionEnd" && expected.timeout <= CONTROL_REQUEST_TIMEOUT_SECONDS) {
      throw new Error(
        `The packaged ${event} hook timeout must exceed the ${CONTROL_REQUEST_TIMEOUT_SECONDS}-second control client timeout`,
      );
    }
  }
}

async function validateSkillContract(pluginRoot: string): Promise<void> {
  const canonicalSkill = await requiredSkill(pluginRoot);
  const canonicalContract = normalizeCodexSkillContract(canonicalSkill);
  const requiredContractFragments = [
    `${CODEX_INSTALLED_LAUNCHER_COMMAND} open --json --surface codex --pdf <absolute-local-pdf-path>`,
    "recovery-offered",
    "placekeeper-live-context",
    "context items --handle",
    "context changes --handle",
    "context evidence --handle",
    "expired`, `stale_generation`, or `unauthorized",
    "context source begin --handle",
    "context source reconcile --handle",
    "applyGuardSha256",
    "context source rebuild-plan --handle",
    "context source rebuild-verify --handle",
    "context source complete --handle",
    "A failed refresh blocks completion.",
    "Do not print, summarize, save, or copy the capability URL elsewhere.",
    "Do not bypass ordinary permission prompts",
    "Do not submit, create, or monitor another Codex task.",
  ];
  for (const fragment of requiredContractFragments) {
    if (!canonicalContract.includes(fragment)) {
      throw new Error(`The packaged Placekeeper skill omitted required contract text: ${fragment}`);
    }
  }
  if (/(^|[^/A-Za-z0-9_-])placekeeper\s+(context|daemon)\b/mu.test(canonicalContract)) {
    throw new Error("The packaged Placekeeper skills must not publish bare context or daemon commands");
  }

}

async function validateAgentMetadata(pluginRoot: string): Promise<void> {
  const agent = await readFile(
    resolve(pluginRoot, `skills/${CODEX_SKILL_NAME}/agents/openai.yaml`),
    "utf8",
  );
  if (
    !agent.includes('display_name: "Placekeeper"') ||
    !agent.includes('short_description: "Open local PDFs in Placekeeper"') ||
    !agent.includes('icon_small: "./assets/placekeeper.svg"') ||
    !agent.includes('icon_large: "./assets/placekeeper.svg"') ||
    !agent.includes('brand_color: "#264F7D"') ||
    !agent.includes(`default_prompt: "Use $${CODEX_SKILL_NAME} to open this local PDF for review."`)
  ) {
    throw new Error(`The packaged ${CODEX_SKILL_NAME} agent metadata must expose its Placekeeper identity and prompt`);
  }
}

export async function validateCodexPlugin(pluginRoot: string): Promise<void> {
  const [pluginSource, hookSource, pluginIcon, skillIcon] = await Promise.all([
    readFile(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
    readFile(resolve(pluginRoot, "hooks/hooks.json"), "utf8"),
    readFile(resolve(pluginRoot, "assets/placekeeper.svg"), "utf8"),
    readFile(resolve(pluginRoot, `skills/${CODEX_SKILL_NAME}/assets/placekeeper.svg`), "utf8"),
  ]);
  if (pluginIcon !== skillIcon || !pluginIcon.includes("Placekeeper reference and return icon")) {
    throw new Error("The packaged Placekeeper plugin and skill icons must match the app artwork");
  }
  validatePluginIdentity(record(JSON.parse(pluginSource) as unknown, "Codex plugin manifest"));
  validateHookContract(record(JSON.parse(hookSource) as unknown, "Codex hook manifest"));
  await Promise.all([
    validateSkillContract(pluginRoot),
    validateAgentMetadata(pluginRoot),
  ]);
}

async function validateVscodeIdentity(
  extensionRoot: string,
  iconMaster: string,
  iconPng: Buffer,
): Promise<void> {
  const [manifestSource, commandIcon, extensionIcon] = await Promise.all([
    readFile(resolve(extensionRoot, "package.json"), "utf8"),
    readFile(resolve(extensionRoot, "assets/placekeeper.svg"), "utf8"),
    readFile(resolve(extensionRoot, "assets/placekeeper.png")),
  ]);
  const manifest = record(JSON.parse(manifestSource) as unknown, "VS Code extension manifest");
  const contributes = record(manifest.contributes, "VS Code extension contributions");
  if (!Array.isArray(contributes.commands)) {
    throw new Error("The Placekeeper VS Code extension must expose commands");
  }
  const commands = contributes.commands.map((value, index) => record(value, `VS Code Placekeeper command ${index}`));
  const command = commands.find((value) => value.command === "placekeeper.open");
  const commandIds = new Set(commands.map((value) => value.command));
  if (command === undefined || ![
    "placekeeper.open",
    "placekeeper.viewPdf",
    "placekeeper.forwardSyncTex",
    "placekeeper.goToSource",
    "placekeeper.reattach",
    "placekeeper.exportReviewedPdf",
    "placekeeper.configureLatexWorkshop",
    "placekeeper.restoreLatexWorkshop",
  ].every((id) => commandIds.has(id))) {
    throw new Error("The Placekeeper VS Code extension command surface is incomplete");
  }
  const commandIconPaths = record(command.icon, "VS Code Placekeeper command icon");
  if (
    manifest.publisher !== "placekeeper-local" ||
    manifest.icon !== "assets/placekeeper.png" ||
    commandIconPaths.light !== "assets/placekeeper.svg" ||
    commandIconPaths.dark !== "assets/placekeeper.svg" ||
    commandIcon !== iconMaster ||
    !extensionIcon.equals(iconPng)
  ) {
    throw new Error("The Placekeeper VS Code extension must use the canonical app icon resources");
  }
}

interface DistributionValidationOptions {
  readonly productionWebRoot?: string;
  readonly vscodeWebRoot?: string;
}

export interface SharedWebAssetManifest {
  readonly schemaVersion: 2;
  readonly app: string;
  readonly stylesheet: string;
  readonly pdfiumWasm: string;
  readonly worker: { readonly kind: "inline-blob"; readonly container: string };
  readonly integrity: Readonly<Record<string, string>>;
}

export async function validateSharedWebDistribution(webRoot: string): Promise<SharedWebAssetManifest> {
  const root = resolve(webRoot);
  let manifestSource: string;
  try {
    manifestSource = await readFile(resolve(root, "asset-manifest.json"), "utf8");
  } catch {
    throw new Error("The shared web distribution is missing asset-manifest.json");
  }
  let value: unknown;
  try { value = JSON.parse(manifestSource) as unknown; }
  catch { throw new Error("The shared web asset manifest is invalid JSON"); }
  const manifest = record(value, "Shared web asset manifest");
  const exactManifestKeys = ["app", "integrity", "pdfiumWasm", "schemaVersion", "stylesheet", "worker"];
  if (Object.keys(manifest).sort().join("\n") !== exactManifestKeys.join("\n") || manifest.schemaVersion !== 2) {
    throw new Error("The shared web asset manifest has an unsupported shape");
  }
  const app = boundedString(manifest.app, "Shared web app asset");
  const stylesheet = boundedString(manifest.stylesheet, "Shared web stylesheet asset");
  const pdfiumWasm = boundedString(manifest.pdfiumWasm, "Shared web PDFium asset");
  const assets = [app, stylesheet, pdfiumWasm];
  if (assets.some((name) => !/^[A-Za-z0-9._-]+$/u.test(name))) {
    throw new Error("Shared web assets must be local filenames");
  }
  if (new Set(assets).size !== assets.length) throw new Error("Shared web asset paths must not be duplicated");
  const worker = record(manifest.worker, "Shared web worker");
  if (Object.keys(worker).sort().join("\n") !== "container\nkind" ||
    worker.kind !== "inline-blob" || worker.container !== app) {
    throw new Error("The shared PDFium worker must be an inline app asset");
  }
  const integrity = record(manifest.integrity, "Shared web asset integrity");
  if (Object.keys(integrity).sort().join("\n") !== [...assets].sort().join("\n") ||
    Object.values(integrity).some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest))) {
    throw new Error("The shared web asset integrity map is incomplete");
  }
  const expectedFiles = ["asset-manifest.json", ...assets].sort();
  let actualFiles: string[];
  try { actualFiles = (await readdir(root)).sort(); }
  catch { throw new Error("The shared web distribution is missing"); }
  if (actualFiles.join("\n") !== expectedFiles.join("\n")) {
    throw new Error(`The shared web distribution has missing or unexpected stale assets; expected ${expectedFiles.join(", ")}`);
  }
  const bytes = new Map<string, Buffer>();
  for (const name of assets) {
    const path = resolve(root, name);
    if (!(await lstat(path)).isFile()) throw new Error(`Shared web asset must be a regular file: ${name}`);
    const assetBytes = await readFile(path);
    if (assetBytes.byteLength === 0) throw new Error(`Shared web asset is empty: ${name}`);
    const digest = createHash("sha256").update(assetBytes).digest("hex");
    if (integrity[name] !== digest) throw new Error(`Shared web asset is stale: ${name}`);
    bytes.set(name, assetBytes);
  }
  const appSource = bytes.get(app)!.toString("utf8");
  if (!/new Worker\(/u.test(appSource) || !/new Blob\(/u.test(appSource)) {
    throw new Error("The packaged client is missing its inline PDFium worker");
  }
  return {
    schemaVersion: 2,
    app,
    stylesheet,
    pdfiumWasm,
    worker: { kind: "inline-blob", container: app },
    integrity: Object.freeze({ ...integrity }) as Readonly<Record<string, string>>,
  };
}

export async function validateDistributionManifests(
  repoRoot = process.cwd(),
  options: DistributionValidationOptions = {},
): Promise<void> {
  const app = validateAppBundleManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/app-bundle.json"), "utf8")) as unknown);
  const backend = validateBackendRuntimeManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown);
  if (app.nodeVersion !== backend.nodeVersion) throw new Error("App and backend Node versions differ");
  const iconMaster = await readFile(resolve(repoRoot, app.icon.master), "utf8");
  if (!iconMaster.includes("<svg") || /<rect[^>]+width="220"[^>]+rx=/u.test(iconMaster)) {
    throw new Error("The production icon master must be an SVG without a pre-masked system corner");
  }
  await validateMacIconSet(resolve(repoRoot, app.icon.source));
  await validateVscodeIdentity(
    resolve(repoRoot, app.embeddedArtifacts.vscodeExtension),
    iconMaster,
    await readFile(resolve(repoRoot, app.icon.source, "icon_128x128.png")),
  );
  for (const asset of backend.assets) {
    const bytes = await readFile(resolve(repoRoot, asset.source));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) throw new Error(`Runtime asset digest mismatch: ${asset.id}`);
  }
  const pluginRoot = resolve(repoRoot, app.embeddedArtifacts.codexPlugin);
  await validateCodexPlugin(pluginRoot);
  const noticePath = resolve(repoRoot, "THIRD_PARTY_NOTICES.md");
  validateCatalogThirdPartyNotices(await readFile(noticePath, "utf8"));
  await validateCatalogSourceBaseline(repoRoot);
  const packageManifest = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  if (packageManifest.scripts?.["prebuild:web"] !== "pnpm catalog:check") {
    throw new Error("Production web builds must run the non-mutating catalog:check gate");
  }
  if (packageManifest.scripts?.["validate:distribution"] !== "pnpm build:web && pnpm build:vscode && tsx packaging/macos/validate-manifest.ts") {
    throw new Error("Distribution validation must rebuild the production web and VS Code bundles before inspection");
  }
  for (const scriptName of ["build", "build:web", "package:macos", "install:local"] as const) {
    if (/catalog:(?:audit|generate|update)/u.test(packageManifest.scripts?.[scriptName] ?? "")) {
      throw new Error(`Ordinary ${scriptName} path must not generate or update catalog artifacts`);
    }
  }
  if (options.productionWebRoot !== undefined) {
    const webRoot = resolve(options.productionWebRoot);
    await validateCatalogRuntimeDistribution({
      runtimeRoot: webRoot,
      webEntry: resolve(webRoot, "app.js"),
      noticePath,
    });
    const productionManifest = await validateSharedWebDistribution(webRoot);
    if (options.vscodeWebRoot !== undefined) {
      const vscodeManifest = await validateSharedWebDistribution(options.vscodeWebRoot);
      if (JSON.stringify(vscodeManifest) !== JSON.stringify(productionManifest)) {
        throw new Error("The packaged VS Code client assets are stale or differ from the shared production assets");
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await validateDistributionManifests(process.cwd(), {
    productionWebRoot: resolve(process.cwd(), "dist/web"),
    vscodeWebRoot: resolve(process.cwd(), "apps/vscode/dist/web"),
  });
  process.stdout.write("Distribution manifests and offline runtime assets are valid.\n");
}
