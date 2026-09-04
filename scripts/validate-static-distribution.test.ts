import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createStaticLegalAssets } from "./generate-static-notices.js";
import { validateStaticDistribution } from "./validate-static-distribution.js";

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture(overrides: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-static-distribution-"));
  await mkdir(join(directory, "assets"));
  const legal = await createStaticLegalAssets();
  const files: Record<string, string> = {
    "assets/app-a1b2c3d4.js": "console.log('placekeeper');",
    "assets/app-a1b2c3d4.css": ".app{display:block}",
    "assets/pdfium-a1b2c3d4.wasm": "wasm fixture",
    "assets/pdfium-worker-a1b2c3d4.js": "self.onmessage=()=>{};",
    "index.html": `<!doctype html><html><head>
      <meta name="referrer" content="no-referrer">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: https:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
      <script type="module" src="./assets/app-a1b2c3d4.js"></script><link rel="stylesheet" href="./assets/app-a1b2c3d4.css"></head><body></body></html>`,
    "privacy.html": legal.privacyHtml,
    "third-party-notices.html": legal.noticeHtml,
    "production-dependencies.json": legal.dependencyInventory,
    ...overrides,
  };
  const entries = Object.entries(files).map(([path, value]) => ({
    path,
    bytes: Buffer.byteLength(value),
    sha256: sha256(value),
  })).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
  files["content-manifest.json"] = manifest;
  files["version.json"] = `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: "0".repeat(40),
    runId: "local",
    runAttempt: "1",
    builtAt: "2026-09-04T00:00:00.000Z",
    base: "./",
    contentManifestSha256: sha256(manifest),
  }, null, 2)}\n`;
  await Promise.all(Object.entries(files).map(([path, value]) => writeFile(join(directory, path), value)));
  return directory;
}

describe("static distribution validator", () => {
  it("accepts an exact hashed, self-describing artifact", async () => {
    const directory = await fixture();
    await expect(validateStaticDistribution(directory)).resolves.toMatchObject({ fileCount: 10 });
  });

  it("rejects undeclared files and dangerous artifact content", async () => {
    const directory = await fixture();
    await writeFile(join(directory, ".env"), "TOKEN=secret");
    await expect(validateStaticDistribution(directory)).rejects.toThrow(/not allowed|environment/iu);
  });

  it("rejects root-relative assets and localhost URLs", async () => {
    const directory = await fixture({
      "index.html": "<script src=\"/placekeeper/assets/app-a1b2c3d4.js\"></script><a href=\"http://localhost:4173\">bad</a>",
    });
    await expect(validateStaticDistribution(directory)).rejects.toThrow(/CSP|localhost|root-relative/iu);
  });
});
