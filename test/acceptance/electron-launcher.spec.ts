import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { CODEX_REVIEW_UI_RESOURCE } from '../../packages/core/src/codex-mcp-protocol.js';
import { candidateExecutable } from './electron-installed-harness.js';

function packagedResources(): string {
  const executableDirectory = dirname(candidateExecutable());
  return process.platform === 'darwin'
    ? resolve(executableDirectory, '../Resources/desktop')
    : join(executableDirectory, 'resources/desktop');
}

async function disposableEnvironment(root: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(?:PLACEKEEPER_|ELECTRON_|NODE_)/iu.test(key) && !['PATH', 'NO_COLOR', 'FORCE_COLOR'].includes(key.toUpperCase())) env[key] = value;
  }
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  await mkdir(home);
  await mkdir(temporary);
  Object.assign(env, {
    HOME: home, USERPROFILE: home,
    HOMEDRIVE: parse(home).root.replace(/[\\/]$/u, ''), HOMEPATH: home.slice(parse(home).root.length - 1),
    LOCALAPPDATA: join(root, 'local-app-data'), APPDATA: join(root, 'app-data'),
    XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    PATH: '',
  });
  return env;
}

function appSupportRoot(env: Record<string, string>): string {
  return process.platform === 'darwin' ? join(env.HOME!, 'Library/Application Support/Placekeeper')
    : process.platform === 'win32' ? join(env.LOCALAPPDATA!, 'Placekeeper') : join(env.XDG_STATE_HOME!, 'placekeeper');
}

async function invoke(executable: string, args: string[], env: Record<string, string>, cwd: string, input?: Buffer) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = execFile(executable, args, { env, cwd, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      if (error && (typeof error.code !== 'number' || error.killed)) reject(error);
      else accept({ status: error?.code as number ?? 0, stdout, stderr });
    });
    child.stdin!.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
    child.stdin!.end(input);
  });
}

test('packaged native CLI and Chrome entry points reject malformed input without starting a daemon', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'placekeeper-launcher-smoke-'));
  try {
    const env = await disposableEnvironment(root);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const bin = join(packagedResources(), 'bin');
    // Argument parsing fails before any daemon exchange or document selection.
    const cli = await invoke(join(bin, `placekeeper${suffix}`), ['open', '--json', '--pdf'], env, root);
    expect(cli.status).toBe(2);
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: false, error: { kind: 'input-unavailable' } });
    expect(cli.stderr).toBe('');
    // An unauthorized caller is rejected before creating a transfer store. The
    // malformed binary frame must never be interpreted as an ordinary CLI open.
    const chrome = await invoke(join(bin, `placekeeper-chrome-native-host${suffix}`), ['chrome-extension://unauthorized/'], env, root, Buffer.from([255, 255, 255, 255, 0]));
    expect(chrome).toEqual({ status: 2, stdout: '', stderr: '' });
    await expect(stat(appSupportRoot(env))).rejects.toMatchObject({ code: 'ENOENT' });
    await testInfo.attach('packaged-launcher-results', {
      body: JSON.stringify({ resources: packagedResources(), cli, chrome, systemNodeInPath: false }), contentType: 'application/json',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bundled independent Node serves MCP tools and the packaged review resource without a daemon', async ({}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'placekeeper-mcp-smoke-'));
  const client = new Client({ name: 'placekeeper-packaged-smoke', version: '1.0.0' });
  let transport: StdioClientTransport | undefined;
  let stderr = '';
  try {
    const env = await disposableEnvironment(root);
    const resources = packagedResources();
    transport = new StdioClientTransport({
      command: join(resources, 'node/bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      args: [join(resources, 'codex-mcp/server.js')], env, cwd: root, stderr: 'pipe',
    });
    transport.stderr!.on('data', chunk => { stderr += String(chunk); });
    await client.connect(transport, { timeout: 10_000 });
    const tools = await client.listTools(undefined, { timeout: 10_000 });
    expect(tools.tools.map(tool => tool.name).sort()).toEqual(['display_review', 'extension_app', 'open_pdf', 'open_placekeeper', 'review_app']);
    const html = await readFile(join(resources, 'codex-mcp/review-v1.html'), 'utf8');
    const uri = `ui://placekeeper/review-v1-${createHash('sha256').update(html).digest('hex')}.html`;
    const listing = await client.listResources(undefined, { timeout: 10_000 });
    expect(listing.resources).toEqual([expect.objectContaining({ uri, mimeType: RESOURCE_MIME_TYPE })]);
    const resource = await client.readResource({ uri }, { timeout: 10_000 });
    expect(resource.contents).toHaveLength(1);
    expect(resource.contents[0]).toMatchObject({ uri, mimeType: RESOURCE_MIME_TYPE, text: html });
    for (const name of ['display_review', 'open_pdf', 'open_placekeeper']) {
      expect(tools.tools.find(tool => tool.name === name)?._meta).toHaveProperty('ui.resourceUri', uri);
    }
    const legacy = await client.readResource({ uri: CODEX_REVIEW_UI_RESOURCE }, { timeout: 10_000 });
    expect(legacy.contents[0]).toMatchObject({ uri: CODEX_REVIEW_UI_RESOURCE, text: html });
    expect(html).toContain('<!doctype html>');
    await client.close();
    await expect(stat(appSupportRoot(env))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stderr).toBe('');
    await testInfo.attach('packaged-mcp-results', {
      body: JSON.stringify({ resources, tools: tools.tools.map(tool => tool.name), uri,
        reviewHtmlSha256: createHash('sha256').update(html).digest('hex'), reviewHtmlBytes: Buffer.byteLength(html), systemNodeInPath: false }),
      contentType: 'application/json',
    });
  } finally {
    await client.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
