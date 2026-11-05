import { expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNativeServer } from '../src/server.js';
import { callPreferenceTool, preferenceTools } from '../src/extension-preferences.js';
import type { NativeServiceClient } from '../src/service-client.js';
const values = { backgroundContext: true, selectionSharing: true, mentions: false };
it('routes exact native settings and mentions shapes through the service store without UI capability', async () => {
    const extension = vi.fn(async (request: any): Promise<any> => request.action === 'mention-read' ? { status: 'unavailable' } : request.action === 'mention-search' ? { status: 'mention-results', items: [] } : { status: 'settings', values, revision: 1 });
    const service = { extension } as unknown as NativeServiceClient;
    const server = createNativeServer(service, 'shell');
    const client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
        expect(client.getServerCapabilities()).toMatchObject({ extensions: { 'openai/settings': { readTool: 'settings.read', updateTool: 'settings.update' }, 'openai/mentions': { searchTool: 'search_mentions' } }, experimental: { 'openai/mentions': { searchTool: 'search_mentions' } } });
        const read = await client.callTool({ name: 'settings.read', arguments: {} });
        expect(read).toMatchObject({ content: [], structuredContent: { values, layout: [{ kind: 'group' }] } });
        expect(JSON.stringify(read)).not.toContain('\"default\":');
        expect(await client.callTool({ name: 'settings.update', arguments: { set: { mentions: true } } })).toMatchObject({ content: [], structuredContent: { values } });
        expect(extension).toHaveBeenCalledWith({ action: 'settings-update', set: { mentions: true } });
        expect(await client.callTool({ name: 'search_mentions', arguments: { query: 'paper' } })).toMatchObject({ content: [], structuredContent: { items: [] } });
        await expect(client.readResource({ uri: 'placekeeper-mention://old' })).rejects.toThrow('Mention snapshot unavailable');
    }
    finally {
        await client.close();
        await server.close();
    }
    expect(preferenceTools.find(t => t.name === 'search_mentions')?._meta).toMatchObject({ 'openai/extensions': { 'mentions/search': {} }, ui: { visibility: ['app'] } });
    const calls = extension.mock.calls.length;
    for (const set of [{}, { extra: true }, { mentions: 'true' }])
        expect(await callPreferenceTool(service, 'settings.update', { set })).toMatchObject({ isError: true });
    expect(extension).toHaveBeenCalledTimes(calls);
});
