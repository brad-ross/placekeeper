import { resolve } from "node:path";
import { defineConfig } from "vite";

import { offlinePdfium } from "./vite.production.config.js";

export default defineConfig({
  root: resolve("apps/web/static"),
  base: "./",
  plugins: [offlinePdfium()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: resolve("dist/static-web"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "[name].js",
        assetFileNames: "app.[ext]",
      },
    },
  },
});
