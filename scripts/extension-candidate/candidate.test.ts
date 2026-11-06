import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_META_KEY, EXTENSION_TOOL } from '../../packages/core/src/extension-protocol.js';
import type { NativeServiceClient } from '../../apps/codex-mcp/src/service-client.js';
import * as production from '../../apps/codex-mcp/src/extension-server.js';
import { callExtensionTool, extensionTools } from './opaque-extension-server.js';
import { packageCandidate } from './package.js';

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const file = { name: 'test.pdf', resourceUri: 'host-resource://authorized-file' };
describe('opaque native qualification candidate', () => {
  it('discards only file-entry metadata and preserves the private real-service result', async () => {
    const reply = { status: 'provisional', grant: 'p'.repeat(43) };
    const extension = vi.fn(async () => reply);
    const client = { extension } as unknown as NativeServiceClient;
    const result = await callExtensionTool(client, 'open_pdf', { file }, { 'openai/resource': { path: '/authorized.pdf' } });
    expect(extension).toHaveBeenCalledExactlyOnceWith({ action: 'host-open', file });
    expect(result).toEqual({ content: [], _meta: { [EXTENSION_META_KEY]: reply } });
    expect(extensionTools.find(tool => tool.name === 'open_pdf')?.title).toBe('Placekeeper Opaque Test');
    await callExtensionTool(client, EXTENSION_TOOL, { request: { action: 'open', pdfPath: '/forged.pdf' } }, undefined);
    expect(extension).toHaveBeenCalledOnce();
    expect(await callExtensionTool(client, 'open_placekeeper', {}, undefined)).toEqual({ content: [], _meta: { [EXTENSION_META_KEY]: { status: 'chooser' } } });
  });

  it('delegates non-file calls with their original arguments, metadata and result', async () => {
    const client = {} as NativeServiceClient;
    const args = { request: { action: 'renew' } };
    const meta = { privateHostMetadata: 'preserved' };
    const reply = { content: [] };
    const delegate = vi.spyOn(production, 'callExtensionTool').mockResolvedValue(reply);
    try {
      expect(await callExtensionTool(client, EXTENSION_TOOL, args, meta)).toBe(reply);
      expect(delegate).toHaveBeenCalledExactlyOnceWith(client, EXTENSION_TOOL, args, meta);
      expect(extensionTools.find(tool => tool.name === EXTENSION_TOOL)).toBe(production.extensionTools.find(tool => tool.name === EXTENSION_TOOL));
    } finally { delegate.mockRestore(); }
  });

  it('packages an isolated opaque server while copying identical reader and service assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pk-opaque-package-'));
    temporaryRoots.push(root);
    for (const path of ['dist/service', 'dist/codex-mcp', 'dist/web', 'apps/codex-mcp/src', 'test/fixtures/pdfs']) await mkdir(join(root, path), { recursive: true });
    const files = ['dist/service/main.js', 'dist/codex-mcp/server.js', 'dist/codex-mcp/review-v1.html', 'dist/web/asset-manifest.json', 'dist/web/app.js', 'dist/web/app.css', 'dist/web/pdfium.wasm', 'dist/web/pdfium-worker.js', 'dist/web/pdfium-codex-worker.js', 'test/fixtures/pdfs/text-native-with-annotations.pdf'];
    for (const path of files) await writeFile(join(root, path), `fixture:${path}`);
    await writeFile(join(root, 'apps/codex-mcp/src/server.ts'), `export { callExtensionTool, extensionTools } from './extension-server.js';`);
    // This must never be used: the alias applies only at the server's import boundary.
    await writeFile(join(root, 'apps/codex-mcp/src/extension-server.ts'), `throw Error('unwrapped fixture server');`);
    const output = await packageCandidate({ projectRoot: root, route: 'opaque-resource' });
    const metadata = JSON.parse(await readFile(join(output, 'build.json'), 'utf8'));
    expect(metadata).toMatchObject({ sourceRoute: 'opaque-resource', plugin: 'placekeeper-extension-candidate-opaque', marketplace: 'placekeeper-extension-candidate-opaque-test', httpPort: 48764 });
    expect(metadata.qualificationWrapper).toMatchObject({ metadataPolicy: 'omit-open-pdf-metadata' });
    for (const path of ['service/main.js', 'codex-mcp/review-v1.html', 'web/app.js']) {
      const source = await readFile(join(root, 'dist', path));
      expect(await readFile(join(output, metadata.plugin, 'runtime', path))).toEqual(source);
      expect(metadata.digests[`${metadata.plugin}/runtime/${path}`]).toBe(createHash('sha256').update(source).digest('hex'));
      expect(metadata.productionAssets[path]).toEqual({ source: `dist/${path}`, sha256: createHash('sha256').update(source).digest('hex') });
    }
    const bundle = await readFile(join(output, metadata.plugin, 'runtime/codex-mcp/server.js'), 'utf8');
    expect(bundle).toContain('Placekeeper Opaque Test');
    expect(bundle).not.toContain('unwrapped fixture server');
    expect(await readFile(join(root, 'dist/codex-mcp/server.js'), 'utf8')).toBe('fixture:dist/codex-mcp/server.js');
    const mcp = JSON.parse(await readFile(join(output, metadata.plugin, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers[metadata.server].env.PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT).toBe('48764');
    const defaultOutput = await packageCandidate({ projectRoot: root });
    const defaultMetadata = JSON.parse(await readFile(join(defaultOutput, 'build.json'), 'utf8'));
    expect(defaultMetadata).toMatchObject({ sourceRoute: 'host-selected', plugin: 'placekeeper-extension-candidate', marketplace: 'placekeeper-extension-candidate-test', httpPort: 48763, qualificationWrapper: null });
    expect(defaultMetadata.daemonRoot).not.toBe(metadata.daemonRoot);
    expect(await readFile(join(defaultOutput, defaultMetadata.plugin, 'runtime/codex-mcp/server.js'), 'utf8')).toBe('fixture:dist/codex-mcp/server.js');
    expect(await readFile(join(output, metadata.plugin, 'runtime/codex-mcp/server.js'), 'utf8')).toBe(bundle);
  });
});
