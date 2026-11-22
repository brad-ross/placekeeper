import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { EXTENSION_META_KEY, EXTENSION_TOOL } from '../../../packages/core/src/extension-protocol.js';
import { admitLocalPdf, callClaudeDesktopTool, getClaudeDesktopPrompt, mcpHostFromEnv, OPEN_PDF_FILE_TOOL } from '../src/claude-desktop-server.js';
import { createNativeServer } from '../src/server.js';
import type { NativeServiceClient } from '../src/service-client.js';

const grant = 'p'.repeat(43);
function fixture() { return { display: vi.fn(), app: vi.fn(), extension: vi.fn(async () => ({ status: 'provisional' as const, grant })) } as unknown as NativeServiceClient; }
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'pk-claude-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function connect(service: NativeServiceClient, host: 'codex' | 'claude-desktop') {
  const server = createNativeServer(service, '<html>shell</html>', {}, host);
  const client = new Client({ name: 'claude-ai', version: '1' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('Claude Desktop host mode', () => {
  it('is selected only by the launcher environment', () => {
    expect(mcpHostFromEnv({ PLACEKEEPER_MCP_HOST: 'claude-desktop' })).toBe('claude-desktop');
    expect(mcpHostFromEnv({})).toBe('codex');
    expect(mcpHostFromEnv({ PLACEKEEPER_MCP_HOST: 'other' })).toBe('codex');
  });

  it('lists model-visible open tools bound to the content-addressed shell, plus the private app tool', async () => {
    const { client, close } = await connect(fixture(), 'claude-desktop');
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toEqual([OPEN_PDF_FILE_TOOL, 'open_placekeeper', EXTENSION_TOOL]);
      const shell = (await client.listResources()).resources[0]!.uri;
      for (const tool of tools.slice(0, 2)) {
        expect(tool._meta).toEqual({ ui: { resourceUri: shell } });
      }
      expect(tools[2]?._meta).toEqual({ ui: { visibility: ['app'] } });
      expect(JSON.stringify(tools)).not.toContain('openai/');
      expect((await client.listPrompts()).prompts.map(prompt => prompt.name)).toEqual(['open_pdf']);
      // Claude reads its preferred mode from the standard ui metadata; it ignores the openai/ui hint.
      expect((await client.readResource({ uri: shell })).contents[0]?._meta).toMatchObject({ ui: { preferredDisplayMode: 'fullscreen' } });
    } finally { await close(); }
  });

  it('gives a host-neutral error to clients that cannot draw MCP Apps views', async () => {
    const service = fixture(), server = createNativeServer(service, '<html>shell</html>', {}, 'claude-desktop');
    const client = new Client({ name: 'text-only', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'open_placekeeper', arguments: {} });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).not.toContain('Codex');
      expect(service.extension).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });

  it('keeps the Codex tool surface unchanged', async () => {
    const { client, close } = await connect(fixture(), 'codex');
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain(OPEN_PDF_FILE_TOOL);
      await expect(client.listPrompts()).rejects.toThrow();
    } finally { await close(); }
  });

  it('opens an existing local PDF by its resolved path and keeps the grant out of model text', async () => {
    const pdf = join(root, 'Paper.PDF'); await writeFile(pdf, '%PDF-1.7');
    const link = join(root, 'link.pdf'); await symlink(pdf, link);
    const service = fixture();
    const result = await callClaudeDesktopTool(service, OPEN_PDF_FILE_TOOL, { path: link }, undefined);
    expect(service.extension).toHaveBeenCalledWith({ action: 'open', pdfPath: await admitLocalPdf(pdf) });
    expect(result._meta?.[EXTENSION_META_KEY]).toEqual({ status: 'provisional', grant });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('Paper.PDF') }]);
    expect(JSON.stringify(result.content)).not.toContain(grant);
    expect(JSON.stringify(result.content)).not.toContain(root);
  });

  it('rejects relative, missing, non-PDF and directory paths before the service sees them', async () => {
    const text = join(root, 'notes.txt'); await writeFile(text, 'x');
    const folder = join(root, 'folder.pdf'); await mkdir(folder);
    const service = fixture();
    for (const args of [{ path: 'relative.pdf' }, { path: join(root, 'missing.pdf') }, { path: text }, { path: folder }, { path: 7 }, {}, { path: join(root, 'a.pdf'), extra: true }]) {
      expect((await callClaudeDesktopTool(service, OPEN_PDF_FILE_TOOL, args, undefined)).isError).toBe(true);
    }
    expect(service.extension).not.toHaveBeenCalled();
  });

  it('sanitizes service failures', async () => {
    const pdf = join(root, 'a.pdf'); await writeFile(pdf, '%PDF-1.7');
    const service = fixture(); service.extension = async () => { throw new Error(`socket ${grant}`); };
    const result = await callClaudeDesktopTool(service, OPEN_PDF_FILE_TOOL, { path: pdf }, undefined);
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(grant);
  });

  it('opens the chooser and still refuses app-supplied paths', async () => {
    const service = fixture();
    const chooser = await callClaudeDesktopTool(service, 'open_placekeeper', {}, undefined);
    expect(chooser._meta?.[EXTENSION_META_KEY]).toEqual({ status: 'chooser' });
    expect(chooser.content).toHaveLength(1);
    expect((await callClaudeDesktopTool(service, EXTENSION_TOOL, { request: { action: 'open', pdfPath: '/forged.pdf' } }, undefined)).isError).toBe(true);
    expect(service.extension).not.toHaveBeenCalled();
  });

  it('turns the open prompt into a request for the matching tool', () => {
    expect(getClaudeDesktopPrompt('open_pdf', { path: '/Users/me/paper.pdf' }).messages[0]?.content).toMatchObject({ type: 'text', text: expect.stringContaining(OPEN_PDF_FILE_TOOL) });
    expect(getClaudeDesktopPrompt('open_pdf', {}).messages[0]?.content).toMatchObject({ text: expect.stringContaining('open_placekeeper') });
    expect(() => getClaudeDesktopPrompt('other', {})).toThrow();
  });
});
