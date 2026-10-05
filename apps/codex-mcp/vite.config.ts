import production from "../web/vite.codex.config.js";
import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig(({ mode }) => mode === "server" ? {
  build: { outDir: resolve("dist/codex-mcp"), emptyOutDir: false, target: "node24", minify: false, ssr: resolve("apps/codex-mcp/src/server.ts"), rollupOptions: { output: { entryFileNames: "server.js", inlineDynamicImports: true } } },
  ssr: { noExternal: true },
} : production);
