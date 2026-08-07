import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve("dist/service"),
    emptyOutDir: true,
    target: "node24",
    minify: false,
    ssr: resolve("apps/service/src/cli/open-command.ts"),
    rollupOptions: {
      output: {
        entryFileNames: "main.js",
        inlineDynamicImports: true,
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
