import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { CODEX_REVIEW_UI_RESOURCE } from '../../../packages/core/src/codex-mcp-protocol.js';

it.skipIf(process.platform === 'win32')('initializes the actual server through an aliased parent while imports remain inert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pk-mcp-entry-'));
  try {
    const physical = join(root, 'physical'); const alias = join(root, 'aliased-parent');
    await mkdir(physical);
    await symlink(physical, alias, 'dir');
    const entry = join(physical, 'server.mjs');
    // Compile actual source into a disposable fixture, without rebuilding or
    // touching the production artifact used by installed/native qualification.
    await build({ configFile: false, logLevel: 'silent', build: { outDir: physical, emptyOutDir: false, target: 'node24', ssr: resolve('apps/codex-mcp/src/server.ts'), rollupOptions: { output: { entryFileNames: 'server.mjs', codeSplitting: false } } }, ssr: { noExternal: true } });
    await writeFile(join(physical, 'review-v1.html'), '<html>entrypoint fixture</html>');
    const client = new Client({ name: 'aliased-entrypoint-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(alias, 'server.mjs')], cwd: root,
      env: { HOME: root, USERPROFILE: root, LOCALAPPDATA: join(root, 'local'), APPDATA: join(root, 'roaming'), XDG_STATE_HOME: join(root, 'state') }, stderr: 'pipe' });
    let errors = ''; transport.stderr?.on('data', chunk => { errors += String(chunk); });
    try {
      await client.connect(transport);
      expect(client.getServerVersion(), errors).toEqual({ name: 'placekeeper', version: '1.0.0' });
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('display_review');
      expect((await client.listResources()).resources.map(resource => resource.uri)).toEqual([CODEX_REVIEW_UI_RESOURCE]);
      expect(errors).toBe('');
    } finally { await client.close(); }
    const imported = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(entry).href)});process.stdout.write('import remained inert');`], { cwd: root });
    expect(imported.stdout).toBe('import remained inert'); expect(imported.stderr).toBe('');
  } finally { await rm(root, { recursive: true, force: true }); }
});
