import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export type CandidateRoute = 'host-selected' | 'opaque-resource';
export async function packageCandidate({ projectRoot = resolve('.'), route = 'host-selected' }: { projectRoot?: string; route?: CandidateRoute } = {}): Promise<string> {
  projectRoot = await realpath(projectRoot);
  const opaque = route === 'opaque-resource';
  const name = opaque ? 'placekeeper-extension-candidate-opaque' : 'placekeeper-extension-candidate';
  const displayName = opaque ? 'Placekeeper Opaque Test' : 'Placekeeper — Latest Preview';
  const marketplace = `${name}-test`;
  const output = resolve(projectRoot, opaque ? 'dist/extension-candidate-opaque' : 'dist/extension-candidate');
  const plugin = join(output, name);
  const runtime = join(plugin, 'runtime');
  // Keep the development control socket below macOS's Unix socket path limit.
  const daemonRoot = join('/private/tmp', `pk-extension-${createHash('sha256').update(output).digest('hex').slice(0, 12)}`);
  const port = opaque ? 48764 : 48763;
  const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
  // Production serves its HTML from the service; the web build contains assets only.
  // The native reader uses the Codex worker/WASM, while service routes use app/CSS and the browser worker.
  for (const file of ['dist/service/main.js', 'dist/codex-mcp/server.js', 'dist/codex-mcp/review-v1.html',
    'dist/web/asset-manifest.json', 'dist/web/app.js', 'dist/web/app.css',
    'dist/web/pdfium.wasm', 'dist/web/pdfium-worker.js', 'dist/web/pdfium-codex-worker.js']) await readFile(resolve(projectRoot, file));
  await mkdir(join(output, '.agents/plugins'), { recursive: true });
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await rm(runtime, { recursive: true, force: true });
  await mkdir(runtime, { recursive: true });
  for (const tree of ['service', 'codex-mcp', 'web']) {
    // The source trees are build outputs, never user data or installed application trees.
    await cp(resolve(projectRoot, 'dist', tree), join(runtime, tree), { recursive: true, force: true });
  }
  const wrapperPath = fileURLToPath(new URL('./opaque-extension-server.ts', import.meta.url));
  if (opaque) {
    const serverPath = resolve(projectRoot, 'apps/codex-mcp/src/server.ts');
    await build({
      configFile: false,
      plugins: [{ name: 'qualification-opaque-entry', enforce: 'pre', resolveId(source, importer) {
        if (source === './extension-server.js' && importer === serverPath) return wrapperPath;
      } }],
      build: { outDir: join(runtime, 'codex-mcp'), emptyOutDir: false, target: 'node24', minify: false, ssr: serverPath, rollupOptions: { output: { entryFileNames: 'server.js', inlineDynamicImports: true } } },
      ssr: { noExternal: true },
    });
  }
  await json(join(runtime, 'package.json'), { type: 'module', private: true });
  const env = { PLACEKEEPER_EXTENSION_DISPLAY_NAME: displayName, PLACEKEEPER_DAEMON_IDENTITY: 'development', PLACEKEEPER_MAC_DEVELOPMENT_ROOT: daemonRoot, PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT: String(port), PLACEKEEPER_PDFIUM_WASM: join(runtime, 'web/pdfium.wasm') };
  await json(join(plugin, '.mcp.json'), { mcpServers: { [name]: { command: process.execPath, args: [join(runtime, 'codex-mcp/server.js')], env } } });
  await json(join(plugin, '.codex-plugin/plugin.json'), { name, version: '0.0.1', description: 'Isolated production Placekeeper PDF extension candidate for development qualification.', mcpServers: './.mcp.json', interface: { displayName, shortDescription: 'Test the production PDF reader with isolated review storage.' } });
  await json(join(output, '.agents/plugins/marketplace.json'), { name: marketplace, interface: { displayName: `${displayName} Test` }, plugins: [{ name, source: { source: 'local', path: `./${name}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
  await cp(resolve(projectRoot, 'test/fixtures/pdfs/text-native-with-annotations.pdf'), join(output, 'disposable-test.pdf'));
  // A foreground launcher makes daemon ownership and cleanup visible. It cannot silently use the installed socket.
  await writeFile(join(output, 'start-daemon.mjs'), `import { spawn } from 'node:child_process';\nconst child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(join(runtime, 'service/main.js'))}, 'daemon'], { stdio: 'inherit', env: { ...process.env, ...${JSON.stringify(env)} } });\nfor (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));\nchild.on('exit', code => process.exitCode = code ?? 1);\n`);
  const digests: Record<string, string> = {};
  async function hashTree(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await hashTree(path);
      else if (entry.isFile()) digests[relative(output, path)] = createHash('sha256').update(await readFile(path)).digest('hex');
    }
  }
  await hashTree(plugin);
  for (const file of ['.agents/plugins/marketplace.json', 'disposable-test.pdf', 'start-daemon.mjs']) digests[file] = createHash('sha256').update(await readFile(join(output, file))).digest('hex');
  const productionAssets = Object.fromEntries(['service/main.js', 'codex-mcp/review-v1.html', 'web/app.js'].map(path => [path, { source: `dist/${path}`, sha256: digests[`${name}/runtime/${path}`] }]));
  await json(join(output, 'build.json'), { builtAt: new Date().toISOString(), revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() ? 'modified' : 'clean', node: process.version, sourceRoute: route, productionAssets, marketplace, plugin: name, server: name, qualificationWrapper: opaque ? { path: relative(resolve('.'), wrapperPath), sha256: createHash('sha256').update(await readFile(wrapperPath)).digest('hex'), metadataPolicy: 'omit-open-pdf-metadata' } : null, daemonIdentity: 'development', daemonRoot, httpPort: port, bundleSha256: createHash('sha256').update(JSON.stringify(digests)).digest('hex'), digests });
  return output;
}
