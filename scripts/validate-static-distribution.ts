import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createStaticLegalAssets,
  STATIC_DEPENDENCY_INVENTORY_PATH,
  STATIC_NOTICE_PATH,
  STATIC_PRIVACY_PATH,
} from "./generate-static-notices.js";

export const STATIC_ARTIFACT_MAX_BYTES = 40 * 1024 * 1024;
const HASHED_ASSET = /^assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|wasm|png)$/u;
const DEMO_DOCUMENT = /^assets\/counterfactual-matrix-means-[A-Za-z0-9_-]{8,}\.pdf$/u;
const FIXED_FILES = new Set([
  "index.html",
  STATIC_PRIVACY_PATH,
  STATIC_NOTICE_PATH,
  STATIC_DEPENDENCY_INVENTORY_PATH,
  "content-manifest.json",
  "version.json",
]);
const PAYLOAD_METADATA = new Set(["content-manifest.json", "version.json"]);

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

async function artifactPaths(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    const path = relative(root, absolute).split(sep).join("/");
    const status = await lstat(absolute);
    if (status.isSymbolicLink()) throw new Error(`Artifact symlinks are not allowed: ${path}`);
    if (status.isDirectory()) {
      if (path !== "assets") throw new Error(`Artifact directory is not allowed: ${path}`);
      result.push(...await artifactPaths(root, absolute));
    }
    else if (status.isFile()) result.push(path);
    else throw new Error(`Unsupported artifact entry: ${path}`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function assertSecurityPolicy(indexHtml: string): void {
  const policy = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/iu)?.[1];
  if (policy === undefined) throw new Error("Static index is missing its early CSP.");
  for (const directive of [
    "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:", "connect-src 'self' blob: https:",
    "object-src 'none'", "frame-src 'self'", "base-uri 'none'", "form-action 'none'",
  ]) {
    if (!policy.includes(directive)) throw new Error(`Static CSP is missing: ${directive}`);
  }
  if (policy.includes("'unsafe-eval'") || /script-src[^;]*'unsafe-inline'/u.test(policy)) {
    throw new Error("Static CSP permits unsafe script execution.");
  }
  if (!/<meta\s+name="referrer"\s+content="no-referrer"/iu.test(indexHtml)) {
    throw new Error("Static index must disable referrers before loading scripts.");
  }
}

export async function validateStaticDistribution(directory = resolve("dist/static-web")): Promise<{
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly contentManifestSha256: string;
}> {
  const root = resolve(directory);
  const paths = await artifactPaths(root);
  for (const path of paths) {
    if (!FIXED_FILES.has(path) && !HASHED_ASSET.test(path) && !DEMO_DOCUMENT.test(path)) {
      throw new Error(`Artifact path is not allowed: ${path}`);
    }
    if ((!DEMO_DOCUMENT.test(path) && /\.(?:map|pdf)$/iu.test(path)) || /(?:^|\/)(?:\.env|\.git|test|fixtures?)(?:\/|$)/iu.test(path)) {
      throw new Error(`Development, environment, source-map, or fixture content is not allowed: ${path}`);
    }
  }
  for (const required of FIXED_FILES) {
    if (!paths.includes(required)) throw new Error(`Static artifact is missing: ${required}`);
  }
  const assets = paths.filter((path) => path.startsWith("assets/"));
  if (!assets.some((path) => /\.css$/u.test(path)) || !assets.some((path) => /\.wasm$/u.test(path))) {
    throw new Error("Static artifact is missing hashed CSS or WASM.");
  }
  if (!assets.some((path) => /pdfium-worker-[A-Za-z0-9_-]{8,}\.js$/u.test(path))) {
    throw new Error("Static artifact is missing its hashed packaged PDFium worker.");
  }

  const contentManifestBytes = await readFile(resolve(root, "content-manifest.json"));
  const contentManifest = JSON.parse(contentManifestBytes.toString("utf8")) as {
    readonly schemaVersion?: unknown;
    readonly entries?: readonly { readonly path?: unknown; readonly bytes?: unknown; readonly sha256?: unknown }[];
  };
  if (contentManifest.schemaVersion !== 1 || !Array.isArray(contentManifest.entries)) {
    throw new Error("Content manifest has an unsupported shape.");
  }
  const payloadPaths = paths.filter((path) => !PAYLOAD_METADATA.has(path));
  const manifestPaths = contentManifest.entries.map((entry) => entry.path);
  if (JSON.stringify(manifestPaths) !== JSON.stringify(payloadPaths)) {
    throw new Error("Content manifest does not declare the exact functional payload.");
  }
  let totalBytes = contentManifestBytes.byteLength;
  for (const entry of contentManifest.entries) {
    if (typeof entry.path !== "string" || typeof entry.bytes !== "number" || typeof entry.sha256 !== "string") {
      throw new Error("Content manifest entry is malformed.");
    }
    const bytes = await readFile(resolve(root, entry.path));
    totalBytes += bytes.byteLength;
    if (entry.bytes !== bytes.byteLength || entry.sha256 !== sha256(bytes)) {
      throw new Error(`Content manifest hash or size mismatch: ${entry.path}`);
    }
  }
  const versionBytes = await readFile(resolve(root, "version.json"));
  totalBytes += versionBytes.byteLength;
  const version = JSON.parse(versionBytes.toString("utf8")) as Record<string, unknown>;
  if (
    version.schemaVersion !== 1 || typeof version.sourceSha !== "string"
    || !/^[0-9a-f]{40}$/u.test(version.sourceSha)
    || typeof version.runId !== "string" || version.runId.length === 0
    || typeof version.runAttempt !== "string" || version.runAttempt.length === 0
    || typeof version.builtAt !== "string" || Number.isNaN(Date.parse(version.builtAt))
    || (version.base !== "./" && !(typeof version.base === "string" && /^\/[A-Za-z0-9._~/-]+\/$/u.test(version.base)))
    || version.contentManifestSha256 !== sha256(contentManifestBytes)
  ) throw new Error("Version provenance is missing or does not match the completed content manifest.");

  const indexHtml = await readFile(resolve(root, "index.html"), "utf8");
  assertSecurityPolicy(indexHtml);
  const executableText = await Promise.all(paths.filter((path) => /\.(?:html|js|css|json)$/u.test(path))
    .map(async (path) => `${path}\n${await readFile(resolve(root, path), "utf8")}`));
  const searchable = executableText.join("\n");
  if (!searchable.includes("privacy.html") || !searchable.includes("third-party-notices.html")) {
    throw new Error("Static app must expose visible privacy and third-party notice links.");
  }
  if (/https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::|\/|$)/iu.test(searchable)) {
    throw new Error("Artifact contains a localhost URL.");
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b/u.test(searchable)) {
    throw new Error("Artifact resembles embedded credentials or a private key.");
  }
  if (/navigator\.serviceWorker\.register\s*\(/u.test(searchable)) {
    throw new Error("Static artifact must not register a service worker.");
  }
  const rootRelative = [...indexHtml.matchAll(/(?:src|href)=["'](\/[^/][^"']*)["']/giu)]
    .map((match) => match[1]!)
    .filter((path) => version.base === "./" || !path.startsWith(String(version.base)));
  if (rootRelative.length > 0) throw new Error(`Root-relative project asset escapes the configured base: ${rootRelative[0]}`);
  if (totalBytes > STATIC_ARTIFACT_MAX_BYTES) {
    throw new Error(`Static artifact exceeds the ${STATIC_ARTIFACT_MAX_BYTES}-byte size budget.`);
  }

  const legal = await createStaticLegalAssets();
  if (await readFile(resolve(root, STATIC_NOTICE_PATH), "utf8") !== legal.noticeHtml
    || await readFile(resolve(root, STATIC_PRIVACY_PATH), "utf8") !== legal.privacyHtml
    || await readFile(resolve(root, STATIC_DEPENDENCY_INVENTORY_PATH), "utf8") !== legal.dependencyInventory) {
    throw new Error("Static notices or production dependency inventory are stale.");
  }
  return { fileCount: paths.length, totalBytes, contentManifestSha256: sha256(contentManifestBytes) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  validateStaticDistribution(process.argv[2]).then((result) => {
    process.stdout.write(`Validated ${result.fileCount} static files (${result.totalBytes} bytes).\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
