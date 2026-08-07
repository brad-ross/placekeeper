import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

function offlinePdfium(): Plugin {
  return {
    name: "offline-pdfium",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "pdfium.wasm",
        source: readFileSync(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm")),
      });
    },
  };
}

export default defineConfig({
  plugins: [offlinePdfium()],
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
