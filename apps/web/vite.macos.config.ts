import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  buildPackagedPdfiumWorkerSource,
  EMBEDPDF_ENGINE_VERSION,
  extractPinnedPdfiumWorkerSource,
} from "../chrome-extension/scripts/embedpdf-worker-source.js";

function packagedMacPdfium(): Plugin {
  const engineRoot = resolve("node_modules/@embedpdf/engines");
  const metadata = JSON.parse(readFileSync(resolve(engineRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  if (metadata.version !== EMBEDPDF_ENGINE_VERSION) {
    throw new Error(`Mac PDFium worker requires @embedpdf/engines ${EMBEDPDF_ENGINE_VERSION}`);
  }
  const workerSource = extractPinnedPdfiumWorkerSource(readFileSync(
    resolve(engineRoot, "dist/lib/pdfium/web/worker-engine.js"),
    "utf8",
  ));
  return {
    name: "packaged-mac-pdfium",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "assets/pdfium.wasm",
        source: readFileSync(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm")),
      });
      this.emitFile({
        type: "asset",
        fileName: "assets/pdfium-worker.js",
        source: buildPackagedPdfiumWorkerSource(workerSource),
      });
    },
  };
}

export default defineConfig({
  plugins: [packagedMacPdfium()],
  root: resolve("apps/web"),
  base: "./",
  resolve: { dedupe: ["react", "react-dom"] },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: resolve("dist/macos-web"),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { shell: resolve("apps/web/macos.html"), recovery: resolve("apps/web/recovery.html") },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: (asset) => asset.names.some((name) => name.startsWith("recovery"))
          ? "assets/recovery.[ext]" : "assets/shell.[ext]",
      },
    },
  },
});
