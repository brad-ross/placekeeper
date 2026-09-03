import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

import {
  buildPackagedPdfiumWorkerSource,
  EMBEDPDF_ENGINE_VERSION,
  extractPinnedPdfiumWorkerSource,
  PACKAGED_PDFIUM_WASM_PATH,
  PACKAGED_PDFIUM_WORKER_PATH,
} from "./scripts/embedpdf-worker-source.js";

const root = dirname(fileURLToPath(import.meta.url));

function manifestAsset(): Plugin {
  return {
    name: "placekeeper-chrome-manifest",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "manifest.json",
        source: readFileSync(resolve(root, "manifest.json"), "utf8"),
      });
    },
  };
}

function packagedPdfiumAssets(): Plugin {
  const engineRoot = resolve("node_modules/@embedpdf/engines");
  const packageMetadata = JSON.parse(readFileSync(resolve(engineRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  if (packageMetadata.version !== EMBEDPDF_ENGINE_VERSION) {
    throw new Error(`Chrome PDFium worker requires @embedpdf/engines ${EMBEDPDF_ENGINE_VERSION}`);
  }
  const workerSource = extractPinnedPdfiumWorkerSource(readFileSync(
    resolve(engineRoot, "dist/lib/pdfium/web/worker-engine.js"),
    "utf8",
  ));
  return {
    name: "placekeeper-packaged-pdfium",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: PACKAGED_PDFIUM_WORKER_PATH,
        source: buildPackagedPdfiumWorkerSource(workerSource),
      });
      this.emitFile({
        type: "asset",
        fileName: PACKAGED_PDFIUM_WASM_PATH,
        source: readFileSync(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm")),
      });
    },
  };
}

export default defineConfig({
  root,
  publicDir: false,
  plugins: [manifestAsset(), packagedPdfiumAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        handlerPage: resolve(root, "handler.html"),
        popupPage: resolve(root, "popup.html"),
        background: resolve(root, "src/background.ts"),
      },
      output: {
        entryFileNames: (chunk) => chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
