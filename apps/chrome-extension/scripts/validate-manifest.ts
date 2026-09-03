import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  readonly manifest_version?: unknown;
  readonly minimum_chrome_version?: unknown;
  readonly key?: unknown;
  readonly permissions?: unknown;
  readonly content_security_policy?: unknown;
  readonly host_permissions?: unknown;
  readonly mime_types_handler?: unknown;
}

function validate(manifest: Manifest, label: string): void {
  if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== "151") {
    throw new Error(`${label}: expected Manifest V3 with Chrome 151 minimum`);
  }
  if (typeof manifest.key !== "string" || manifest.key.length < 128) {
    throw new Error(`${label}: missing stable extension key`);
  }
  const permissions = manifest.permissions;
  if (!Array.isArray(permissions) || permissions.join(",") !== "nativeMessaging,storage") {
    throw new Error(`${label}: unexpected permission set`);
  }
  if (manifest.host_permissions !== undefined) throw new Error(`${label}: broad host permissions are forbidden`);
  if (JSON.stringify(manifest.content_security_policy) !== JSON.stringify({
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; worker-src 'self'; connect-src 'self'",
  })) throw new Error(`${label}: expected packaged-worker-only extension policy`);
  const handler = manifest.mime_types_handler;
  if (
    typeof handler !== "object" || handler === null || Array.isArray(handler) ||
    JSON.stringify(handler) !== JSON.stringify({ "application/pdf": { handler_url: "handler.html" } })
  ) throw new Error(`${label}: expected top-level PDF-only MIME handler`);
}

for (const [label, path] of [
  ["source manifest", resolve(root, "manifest.json")],
  ["built manifest", resolve(root, "dist/manifest.json")],
] as const) {
  validate(JSON.parse(await readFile(path, "utf8")) as Manifest, label);
}

const sharedRoot = resolve(root, "dist/shared");
const sharedManifest = JSON.parse(await readFile(resolve(sharedRoot, "asset-manifest.json"), "utf8")) as {
  readonly schemaVersion?: unknown;
  readonly app?: unknown;
  readonly stylesheet?: unknown;
  readonly pdfiumWasm?: unknown;
  readonly pdfiumWorker?: unknown;
  readonly integrity?: unknown;
};
const sharedAssets = [
  sharedManifest.app,
  sharedManifest.stylesheet,
  sharedManifest.pdfiumWasm,
  sharedManifest.pdfiumWorker,
];
if (sharedManifest.schemaVersion !== 3 ||
  sharedAssets.some((name) => typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) ||
  new Set(sharedAssets).size !== sharedAssets.length ||
  typeof sharedManifest.integrity !== "object" || sharedManifest.integrity === null) {
  throw new Error("built extension: shared production asset manifest is invalid");
}
const sharedNames = sharedAssets as string[];
if (Object.keys(sharedManifest.integrity as Record<string, unknown>).sort().join("\n") !==
  [...sharedNames].sort().join("\n")) {
  throw new Error("built extension: shared production asset integrity map is incomplete");
}
const expectedSharedFiles = ["asset-manifest.json", ...sharedNames].sort();
if ((await readdir(sharedRoot)).sort().join("\n") !== expectedSharedFiles.join("\n")) {
  throw new Error("built extension: shared production assets are missing or stale");
}
for (const name of sharedNames) {
  const path = resolve(sharedRoot, name);
  if (!(await lstat(path)).isFile()) throw new Error(`built extension: shared asset is not a file: ${name}`);
  const bytes = await readFile(path);
  if ((sharedManifest.integrity as Record<string, unknown>)[name] !==
    createHash("sha256").update(bytes).digest("hex")) {
    throw new Error(`built extension: shared asset failed integrity validation: ${name}`);
  }
}

const [workerSource, wasmBytes, handlerHtml] = await Promise.all([
  readFile(resolve(sharedRoot, sharedManifest.pdfiumWorker as string), "utf8"),
  readFile(resolve(sharedRoot, sharedManifest.pdfiumWasm as string)),
  readFile(resolve(root, "dist/handler.html"), "utf8"),
]);
if (!workerSource.includes("class PdfiumEngineRunner") ||
  !workerSource.includes("placekeeper-pdfium-worker-privilege-probe") ||
  !workerSource.includes('type === "wasmInit"')) {
  throw new Error("built extension: packaged PDFium worker contract is missing");
}
if (wasmBytes.length < 8 || !wasmBytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))) {
  throw new Error("built extension: packaged pdfium.wasm is invalid");
}
const handlerScript = /<script[^>]+src="([^"]+handlerPage-[^"]+\.js)"/u.exec(handlerHtml)?.[1];
if (handlerScript === undefined) throw new Error("built extension: handler entry is missing");
const handlerSource = await readFile(resolve(root, "dist", handlerScript.replace(/^\//u, "")), "utf8");
for (const asset of ["shared/pdfium-worker.js", "shared/pdfium.wasm"]) {
  if (!handlerSource.includes(asset)) throw new Error(`built extension: handler does not launch ${asset}`);
}
