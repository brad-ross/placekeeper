import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Both entry points run in Node contexts. In particular, the main process must
// resolve dependencies' Node exports rather than their browser replacements.
// Preload imports only Electron and erased types, so it remains one sandbox-safe
// CJS file; a shared runtime dependency here would require a separate build.
const nodeBuiltins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: true,
    outDir: resolve('apps/electron/dist'),
    emptyOutDir: true,
    target: 'node24',
    lib: {
      entry: {
        main: resolve('apps/electron/src/main.ts'),
        preload: resolve('apps/electron/src/preload.ts'),
      },
      formats: ['cjs'],
      fileName: (_format, name) => `${name}.cjs`,
    },
    rollupOptions: {
      external: id => id === 'electron' || nodeBuiltins.has(id),
    },
  },
});
