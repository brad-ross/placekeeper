import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const STATIC_NOTICE_PATH = "third-party-notices.html";
export const STATIC_DEPENDENCY_INVENTORY_PATH = "production-dependencies.json";
export const STATIC_PRIVACY_PATH = "privacy.html";

interface PackageMetadata {
  readonly version?: unknown;
  readonly license?: unknown;
  readonly homepage?: unknown;
  readonly repository?: unknown;
}

const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function packageMetadata(name: string): Promise<PackageMetadata> {
  return JSON.parse(await readFile(resolve("node_modules", name, "package.json"), "utf8")) as PackageMetadata;
}

function packageHomepage(metadata: PackageMetadata): string | undefined {
  if (typeof metadata.homepage === "string") return metadata.homepage;
  if (typeof metadata.repository === "string") return metadata.repository;
  if (
    typeof metadata.repository === "object" && metadata.repository !== null
    && "url" in metadata.repository && typeof metadata.repository.url === "string"
  ) return metadata.repository.url;
  return undefined;
}

export async function createStaticLegalAssets(): Promise<{
  readonly noticeHtml: string;
  readonly privacyHtml: string;
  readonly dependencyInventory: string;
}> {
  const rootPackage = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const dependencyNames = Object.keys(rootPackage.dependencies ?? {}).sort();
  const dependencies = await Promise.all(dependencyNames.map(async (name) => {
    const metadata = await packageMetadata(name);
    if (typeof metadata.version !== "string" || typeof metadata.license !== "string") {
      throw new Error(`Production dependency metadata is incomplete: ${name}`);
    }
    return {
      name,
      version: metadata.version,
      license: metadata.license,
      ...(packageHomepage(metadata) === undefined ? {} : { homepage: packageHomepage(metadata) }),
    };
  }));
  const pdfiumWasm = new Uint8Array(await readFile(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm")));
  const pdfiumMetadata = await packageMetadata("@embedpdf/pdfium");
  const pdfiumLicense = await readFile(resolve("node_modules/@embedpdf/pdfium/LICENSE.pdfium"), "utf8");
  const repositoryNotices = await readFile(resolve("THIRD_PARTY_NOTICES.md"), "utf8");
  if (!repositoryNotices.includes(pdfiumLicense.trim())) {
    throw new Error("THIRD_PARTY_NOTICES.md must contain the complete bundled PDFium license.");
  }
  const pdfiumRevision = `@embedpdf/pdfium@${String(pdfiumMetadata.version)}+wasm.sha256.${sha256(pdfiumWasm)}`;
  if (!repositoryNotices.includes(pdfiumRevision)) {
    throw new Error("THIRD_PARTY_NOTICES.md must identify the embedded PDFium revision.");
  }
  const dependencyInventory = `${JSON.stringify({
    schemaVersion: 1,
    generatedFrom: "package.json production dependencies",
    pdfiumRevision,
    dependencies,
  }, null, 2)}\n`;
  const noticeHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Placekeeper third-party notices</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:75rem;margin:2rem auto;padding:0 1rem;color:#172033}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><main><h1>Third-party notices</h1><p>Embedded PDFium revision: <code>${escapeHtml(pdfiumRevision)}</code></p><pre>${escapeHtml(repositoryNotices)}</pre></main></body></html>\n`;
  const privacyHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Placekeeper web beta privacy</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#172033}</style></head>
<body><main><h1>Privacy and durability</h1><p>This public web beta is for non-confidential PDFs. Local PDF bytes stay in the current tab; a remote PDF URL is requested directly from that host. GitHub Pages and the remote host may receive ordinary web request information.</p><p>Placekeeper does not add analytics, autosave, browser storage, or reload recovery here. Export a reviewed PDF to keep your Review Items. Export preserves other source PDF content but is not a sanitizer.</p></main></body></html>\n`;
  return { noticeHtml, privacyHtml, dependencyInventory };
}

