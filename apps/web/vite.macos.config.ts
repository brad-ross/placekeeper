import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("apps/web"),
  base: "./",
  resolve: { dedupe: ["react", "react-dom"] },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: resolve("dist/macos-web"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve("apps/web/macos.html"),
      output: {
        entryFileNames: "assets/shell.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/shell.[ext]",
      },
    },
  },
});
