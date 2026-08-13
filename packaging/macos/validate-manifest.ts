import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

const CODEX_INSTALLED_LAUNCHER_COMMAND =
  '"$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper"';
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
    !agent.includes(`default_prompt: "Use $${CODEX_SKILL_NAME} to open this local PDF for review."`)
  ) {
    throw new Error(`The packaged ${CODEX_SKILL_NAME} agent metadata must expose its Placekeeper prompt`);
  }
}

export async function validateCodexPlugin(pluginRoot: string): Promise<void> {
  const [pluginSource, hookSource] = await Promise.all([
    readFile(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"),
    readFile(resolve(pluginRoot, "hooks/hooks.json"), "utf8"),
  ]);
  validatePluginIdentity(record(JSON.parse(pluginSource) as unknown, "Codex plugin manifest"));
  validateHookContract(record(JSON.parse(hookSource) as unknown, "Codex hook manifest"));
  await Promise.all([
    validateSkillContract(pluginRoot),
    validateAgentMetadata(pluginRoot),
  ]);
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
  await validateCodexPlugin(pluginRoot);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await validateDistributionManifests();
  process.stdout.write("Distribution manifests and offline runtime assets are valid.\n");
}
