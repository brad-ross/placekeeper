import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

import { EMBEDPDF_ENGINE_VERSION } from "../../scripts/build/pdfium-worker-source.js";
import { emitPdfiumAssets, loadPinnedPdfiumWorkerSource } from "../../scripts/build/pdfium-assets.js";
import {
  createStaticLegalAssets,
  STATIC_DEPENDENCY_INVENTORY_PATH,
  STATIC_NOTICE_PATH,
  STATIC_PRIVACY_PATH,
} from "../../scripts/generate-static-notices.js";

const STATIC_WASM_PLACEHOLDER = "__PLACEKEEPER_STATIC_PDFIUM_WASM__";
const STATIC_WORKER_PLACEHOLDER = "__PLACEKEEPER_STATIC_PDFIUM_WORKER__";
const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function staticBase(): string {
  const value = process.env.PLACEKEEPER_STATIC_BASE?.trim();
  if (value === undefined || value === "" || value === "./") return "./";
  if (!/^\/[A-Za-z0-9._~/-]+\/$/u.test(value) || value.includes("//") || value.includes("..")) {
    throw new Error("PLACEKEEPER_STATIC_BASE must be './' or a normalized project path such as '/placekeeper/'.");
  }
  return value;
}

function sourceSha(): string {
  const candidate = process.env.GITHUB_SHA ?? process.env.STATIC_SOURCE_SHA;
  if (candidate !== undefined && /^[0-9a-f]{40}$/iu.test(candidate)) return candidate.toLowerCase();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();
  } catch {
    return "0".repeat(40);
  }
}

function staticPdfiumAssets(): Plugin {
  let wasmReference = "";
  let workerReference = "";
  return {
    name: "static-pdfium-assets",
    buildStart() {
      const workerSource = loadPinnedPdfiumWorkerSource(
        `Static PDFium worker requires @embedpdf/engines ${EMBEDPDF_ENGINE_VERSION}`,
      );
      ({ wasmReference, workerReference } = emitPdfiumAssets(this, {
        wasm: { name: "pdfium.wasm" },
        worker: { name: "pdfium-worker.js" },
        workerSource,
      }));
    },
    transform(source, id) {
      if (!id.endsWith("/apps/web/src/static-entry.tsx")) return undefined;
      return source
        .replace(JSON.stringify(STATIC_WASM_PLACEHOLDER), `import.meta.ROLLUP_FILE_URL_${wasmReference}`)
        .replace(JSON.stringify(STATIC_WORKER_PLACEHOLDER), `import.meta.ROLLUP_FILE_URL_${workerReference}`);
    },
  };
}

function staticLegalAssets(): Plugin {
  return {
    name: "static-legal-assets",
    async buildStart() {
      const legal = await createStaticLegalAssets();
      this.emitFile({ type: "asset", fileName: STATIC_NOTICE_PATH, source: legal.noticeHtml });
      this.emitFile({ type: "asset", fileName: STATIC_PRIVACY_PATH, source: legal.privacyHtml });
      this.emitFile({
        type: "asset",
        fileName: STATIC_DEPENDENCY_INVENTORY_PATH,
        source: legal.dependencyInventory,
      });
    },
  };
}

function staticContentManifest(base: string): Plugin {
  return {
    name: "static-content-manifest",
    enforce: "post",
    generateBundle(_options, bundle) {
      const bytes = (output: (typeof bundle)[string]): Buffer => output.type === "chunk"
        ? Buffer.from(output.code)
        : Buffer.isBuffer(output.source) ? output.source : Buffer.from(output.source);
      const entries = Object.values(bundle)
        .filter((output) => output.fileName !== "content-manifest.json" && output.fileName !== "version.json")
        .map((output) => {
          const content = bytes(output);
          return { path: output.fileName, bytes: content.byteLength, sha256: sha256(content) };
        })
        .sort((left, right) => left.path.localeCompare(right.path));
      const manifest = `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`;
      this.emitFile({ type: "asset", fileName: "content-manifest.json", source: manifest });
      const epoch = process.env.SOURCE_DATE_EPOCH === undefined
        ? undefined
        : Number.parseInt(process.env.SOURCE_DATE_EPOCH, 10);
      const builtAt = epoch !== undefined && Number.isFinite(epoch)
        ? new Date(epoch * 1_000)
        : new Date();
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({
          schemaVersion: 1,
          sourceSha: sourceSha(),
          runId: process.env.GITHUB_RUN_ID ?? "local",
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
          builtAt: builtAt.toISOString(),
          base,
          contentManifestSha256: sha256(manifest),
        }, null, 2)}\n`,
      });
    },
  };
}

const base = staticBase();

export default defineConfig({
  root: resolve("apps/web/static"),
  base,
  plugins: [staticPdfiumAssets(), staticLegalAssets(), staticContentManifest(base)],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: resolve("dist/static-web"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
