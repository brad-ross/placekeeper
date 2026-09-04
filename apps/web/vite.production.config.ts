import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  buildPackagedPdfiumWorkerSource,
  EMBEDPDF_ENGINE_VERSION,
  extractPinnedPdfiumWorkerSource,
} from "../chrome-extension/scripts/embedpdf-worker-source.js";

export function offlinePdfium(): Plugin {
  const engineRoot = resolve("node_modules/@embedpdf/engines");
  const packageMetadata = JSON.parse(readFileSync(resolve(engineRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  if (packageMetadata.version !== EMBEDPDF_ENGINE_VERSION) {
    throw new Error(`Shared PDFium worker requires @embedpdf/engines ${EMBEDPDF_ENGINE_VERSION}`);
  }
  const workerSource = extractPinnedPdfiumWorkerSource(readFileSync(
    resolve(engineRoot, "dist/lib/pdfium/web/worker-engine.js"),
    "utf8",
  ));
  return {
    name: "offline-pdfium",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "pdfium.wasm",
        source: readFileSync(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm")),
      });
      this.emitFile({
        type: "asset",
        fileName: "pdfium-worker.js",
        source: buildPackagedPdfiumWorkerSource(workerSource),
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
