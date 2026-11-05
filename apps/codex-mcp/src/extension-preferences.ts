import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { extensionPreferenceSchema, extensionPreferenceLayout, parsePreferenceSet } from '../../../packages/core/src/extension-preferences.js';
import type { NativeServiceClient } from './service-client.js';
export const preferenceCapabilities = { 'openai/settings': { readTool: 'settings.read', updateTool: 'settings.update' }, 'openai/mentions': { searchTool: 'search_mentions' } };
export const preferenceTools: Tool[] = [
    { name: 'settings.read', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'settings.update', inputSchema: { type: 'object', required: ['set'], additionalProperties: false, properties: { set: { ...extensionPreferenceSchema, required: [], minProperties: 1 } } } },
    { name: 'search_mentions', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true }, _meta: { 'openai/extensions': { 'mentions/search': {} }, ui: { visibility: ['app'] } } }
];
export async function callPreferenceTool(client: NativeServiceClient, name: string, args: unknown): Promise<CallToolResult> {
    try {
        if (!client.extension || typeof args !== 'object' || args === null || Array.isArray(args))
            throw Error();
        const a = args as Record<string, unknown>;
        let response;
        if (name === 'settings.read' && Object.keys(a).length === 0) {
            response = await client.extension({ action: 'settings-read' });
            if (response.status === 'settings')
                return { content: [], structuredContent: { schema: extensionPreferenceSchema, layout: extensionPreferenceLayout, values: response.values } };
        }
        if (name === 'settings.update' && Object.keys(a).length === 1) {
            const set = parsePreferenceSet(a.set);
            if (set) {
                response = await client.extension({ action: 'settings-update', set });
                if (response.status === 'settings')
                    return { content: [], structuredContent: { values: response.values } };
            }
        }
        if (name === 'search_mentions' && typeof a.query === 'string') {
            response = await client.extension({ action: 'mention-search', query: a.query });
            if (response.status === 'mention-results')
                return { content: [], structuredContent: { items: response.items } };
        }
    }
    catch { }
    return { isError: true, content: [{ type: 'text', text: 'Placekeeper preferences or mention snapshots are unavailable.' }] };
}
