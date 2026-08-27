import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Manifest {
  readonly manifest_version?: unknown;
  readonly minimum_chrome_version?: unknown;
  readonly key?: unknown;
  readonly permissions?: unknown;
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
