import { resolve } from 'node:path';
import { defineConfig } from 'vite';
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: resolve('dist/codex-mcp'), emptyOutDir: true, target: 'es2022', minify: true,
    lib: { entry: resolve('apps/codex-mcp/src/shell.ts'), formats: ['iife'], name: 'PlacekeeperNative', fileName: () => 'shell.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
  plugins: [{ name: 'native-private-production-reader', generateBundle: { order: 'post', handler(_options, bundle) {
    const script = bundle['shell.js'];
    if (script?.type !== 'chunk') throw new Error('Missing native production client');
    const styles = Object.values(bundle).filter(asset => asset.type === 'asset' && asset.fileName.endsWith('.css')).map(asset => asset.type === 'asset' ? String(asset.source) : '').join('\n');
    this.emitFile({ type: 'asset', fileName: 'review-v1.html', source: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Placekeeper</title><style>${styles}\nhtml,body{height:100%;margin:0}body{font:14px system-ui;display:flex;flex-direction:column;color:var(--color-text-primary,#242424);background:var(--color-background-primary,#fff)}.native-toolbar{display:flex;align-items:center;gap:8px;padding:4px 8px}.native-toolbar p{margin:0;flex:1}#root{flex:1;min-height:0;overflow:hidden}#root[data-production-root=true]{position:relative;inset:auto;min-height:0}#root[data-production-root=true] .review-shell{min-height:0}#detail:empty{display:none}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><div class="native-toolbar"><p id="status" role="status">Connecting native review…</p><button id="expand">Expand</button><button id="restore">Restore</button></div><p id="renewal" hidden>No authenticated renewal yet.</p><pre id="detail"></pre><div id="root"></div><script>${script.code.replaceAll('</script', '<\\/script')}</script></body></html>` });
    for (const [key, asset] of Object.entries(bundle)) if (key === 'shell.js' || asset.type === 'asset' && asset.fileName.endsWith('.css')) delete bundle[key];
  } } }],
});
