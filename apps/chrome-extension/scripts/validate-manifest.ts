import { readFile } from "node:fs/promises";
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

const [workerSource, wasmBytes, handlerHtml] = await Promise.all([
  readFile(resolve(root, "dist/assets/pdfium-worker.js"), "utf8"),
  readFile(resolve(root, "dist/assets/pdfium.wasm")),
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
for (const asset of ["assets/pdfium-worker.js", "assets/pdfium.wasm"]) {
  if (!handlerSource.includes(asset)) throw new Error(`built extension: handler does not launch ${asset}`);
}
