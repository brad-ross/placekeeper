import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  buildPackagedPdfiumWorkerSource,
  EMBEDPDF_ENGINE_VERSION,
} from "../../scripts/build/pdfium-worker-source.js";
import { emitPdfiumAssets, loadPinnedPdfiumWorkerSource } from "../../scripts/build/pdfium-assets.js";

function packagedMacPdfium(): Plugin {
  const workerSource = loadPinnedPdfiumWorkerSource(
    `Mac PDFium worker requires @embedpdf/engines ${EMBEDPDF_ENGINE_VERSION}`,
  );
  return {
    name: "packaged-mac-pdfium",
    generateBundle() {
      emitPdfiumAssets(this, {
        wasm: { fileName: "assets/pdfium.wasm" },
        worker: { fileName: "assets/pdfium-worker.js" },
        workerSource: buildPackagedPdfiumWorkerSource(workerSource),
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
