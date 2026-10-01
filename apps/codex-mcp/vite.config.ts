import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig(({ mode }) => mode === "server" ? {
  build: { outDir: resolve("dist/codex-mcp"), emptyOutDir: false, target: "node24", minify: false, ssr: resolve("apps/codex-mcp/src/server.ts"), rollupOptions: { output: { entryFileNames: "server.js", inlineDynamicImports: true } } },
  ssr: { noExternal: true },
} : {
  build: { outDir: resolve("dist/codex-mcp"), emptyOutDir: true, target: "es2022", minify: true, lib: { entry: resolve("apps/codex-mcp/src/shell.ts"), formats: ["iife"], name: "PlacekeeperNative", fileName: () => "shell.js" }, rollupOptions: { output: { inlineDynamicImports: true } } },
  plugins: [{ name: "native-private-cacheable-shell", generateBundle(_options, bundle) {
    const script = bundle["shell.js"];
    if (script?.type !== "chunk") throw new Error("Missing native shell");
    this.emitFile({ type: "asset", fileName: "review-v1.html", source: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Placekeeper</title><style>body{font:14px system-ui;margin:16px;color:var(--color-text-primary,#242424);background:var(--color-background-primary,#fff)}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{font:inherit;margin-right:8px}</style></head><body><h1>Placekeeper</h1><p id="status" role="status">Connecting native review…</p><button id="expand">Expand</button><button id="restore">Restore</button><p id="renewal">No authenticated renewal yet.</p><pre id="detail"></pre><script>${script.code.replaceAll("</script", "<\\/script")}</script></body></html>` });
    delete bundle["shell.js"];
  } }],
});
