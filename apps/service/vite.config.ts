import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { RECOVERY_CAPABILITIES } from "./src/recovery/recovery-capabilities.js";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [{
    name: "recovery-reader-build-metadata",
    async writeBundle() {
      const bytes = await readFile(resolve("dist/service/main.js"));
      await writeFile(resolve("dist/service/recovery-capabilities.json"), `${JSON.stringify({
        schemaVersion: 1,
        service: { path: "main.js", sha256: createHash("sha256").update(bytes).digest("hex") },
        recovery: RECOVERY_CAPABILITIES,
      })}\n`);
    },
  }],
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
