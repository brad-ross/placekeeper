import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
      const appSource = bytes(app).toString("utf8");
      if (!/new Worker\(/u.test(appSource) || !/new Blob\(/u.test(appSource)) {
        throw new Error("The shared production client must contain its inline PDFium worker");
      }
      const integrity = Object.fromEntries(
        [app, stylesheet, pdfiumWasm].map((name) => [
          name,
          createHash("sha256").update(bytes(name)).digest("hex"),
        ]),
      );
      this.emitFile({
        type: "asset",
        fileName: "asset-manifest.json",
        source: JSON.stringify({
          schemaVersion: 2,
          app,
          stylesheet,
          pdfiumWasm,
          worker: { kind: "inline-blob", container: app },
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
