import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  buildPackagedPdfiumWorkerSource,
  EMBEDPDF_ENGINE_VERSION,
} from "../../scripts/build/pdfium-worker-source.js";
import { emitPdfiumAssets, loadPinnedPdfiumWorkerSource } from "../../scripts/build/pdfium-assets.js";

export function offlinePdfium(): Plugin {
  const workerSource = loadPinnedPdfiumWorkerSource(
    `Shared PDFium worker requires @embedpdf/engines ${EMBEDPDF_ENGINE_VERSION}`,
  );
  return {
    name: "offline-pdfium",
    generateBundle() {
      emitPdfiumAssets(this, {
        wasm: { fileName: "pdfium.wasm" },
        worker: { fileName: "pdfium-worker.js" },
        workerSource: buildPackagedPdfiumWorkerSource(workerSource),
      });
    },
  };
}

function sharedAssetManifest(): Plugin {
  return {
    name: "shared-asset-manifest",
    enforce: "post",
    generateBundle(_options, bundle) {
      const bytes = (name: string): Buffer => {
        const output = Object.values(bundle).find((candidate) => candidate.fileName === name);
        if (output === undefined) throw new Error(`Shared production asset is missing: ${name}`);
        return output.type === "chunk"
          ? Buffer.from(output.code)
          : Buffer.isBuffer(output.source)
            ? output.source
            : Buffer.from(output.source);
      };
      const app = "app.js";
      const stylesheet = "app.css";
      const pdfiumWasm = "pdfium.wasm";
      const pdfiumWorker = "pdfium-worker.js";
      const integrity = Object.fromEntries(
        [app, stylesheet, pdfiumWasm, pdfiumWorker].map((name) => [
          name,
          createHash("sha256").update(bytes(name)).digest("hex"),
        ]),
      );
      this.emitFile({
        type: "asset",
        fileName: "asset-manifest.json",
        source: JSON.stringify({
          schemaVersion: 3,
          app,
          stylesheet,
          pdfiumWasm,
          pdfiumWorker,
          integrity,
        }),
      });
    },
  };
}

export default defineConfig({
  plugins: [offlinePdfium(), sharedAssetManifest()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: resolve("dist/web"),
    emptyOutDir: true,
    lib: {
      entry: resolve("apps/web/src/production-entry.tsx"),
      formats: ["es"],
      fileName: () => "app.js",
    },
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "[name].js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
