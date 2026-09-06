import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

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
      for (const size of [16, 32, 48, 128]) {
        this.emitFile({
          type: "asset",
          fileName: `icons/icon${size}.png`,
          source: readFileSync(resolve(root, `assets/icon${size}.png`)),
        });
      }
    },
  };
}

function sharedClientAssets(): Plugin {
  const sharedRoot = resolve("dist/web");
  return {
    name: "placekeeper-shared-client",
    generateBundle() {
      let manifest: {
        readonly schemaVersion?: unknown;
        readonly app?: unknown;
        readonly stylesheet?: unknown;
        readonly pdfiumWasm?: unknown;
        readonly pdfiumWorker?: unknown;
        readonly integrity?: unknown;
      };
      try {
        manifest = JSON.parse(readFileSync(resolve(sharedRoot, "asset-manifest.json"), "utf8")) as typeof manifest;
      } catch {
        throw new Error("Chrome build requires the shared production client; run build:web first");
      }
      const assets = [manifest.app, manifest.stylesheet, manifest.pdfiumWasm, manifest.pdfiumWorker];
      if (manifest.schemaVersion !== 3 ||
        assets.some((name) => typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) ||
        new Set(assets).size !== assets.length || typeof manifest.integrity !== "object" ||
        manifest.integrity === null) {
        throw new Error("Chrome build received an invalid shared production asset manifest");
      }
      const names = assets as string[];
      if (Object.keys(manifest.integrity as Record<string, unknown>).sort().join("\n") !==
        [...names].sort().join("\n")) {
        throw new Error("Chrome build received an incomplete shared production asset integrity map");
      }
      const expected = ["asset-manifest.json", ...names].sort();
      if (readdirSync(sharedRoot).sort().join("\n") !== expected.join("\n")) {
        throw new Error("Chrome build received missing or stale shared production assets");
      }
      for (const name of names) {
        const path = resolve(sharedRoot, name);
        if (!statSync(path).isFile()) throw new Error(`Chrome shared client asset is not a file: ${name}`);
        const source = readFileSync(path);
        const digest = createHash("sha256").update(source).digest("hex");
        if ((manifest.integrity as Record<string, unknown>)[name] !== digest) {
          throw new Error(`Chrome shared client asset failed integrity validation: ${name}`);
        }
        this.emitFile({ type: "asset", fileName: `shared/${name}`, source });
      }
      this.emitFile({
        type: "asset",
        fileName: "shared/asset-manifest.json",
        source: readFileSync(resolve(sharedRoot, "asset-manifest.json")),
      });
    },
  };
}

export default defineConfig({
  root,
  publicDir: false,
  plugins: [manifestAsset(), sharedClientAssets()],
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
