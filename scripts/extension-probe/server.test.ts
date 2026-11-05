import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createProbeServer, PROBE_URI } from './server.js';

describe('extension qualification transport', () => {
  it('preserves separate entrypoints and fullscreen metadata over SDK1 transport', async () => {
    const server = createProbeServer('<html>probe</html>', () => {});
    const client = new Client({ name: 'test', version: '1' });
    const [a,b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.find(t => t.name === 'open_probe_pdf')?._meta?.['openai/ui']).toEqual({ entrypoints: [{type:'file',extensions:['.pdf']}] });
      expect(tools.find(t => t.name === 'open_probe')?._meta?.['openai/ui']).toEqual({ entrypoints: [{type:'thread'}] });
      const resource = await client.readResource({uri:PROBE_URI});
      expect(resource.contents[0]?.mimeType).toBe(RESOURCE_MIME_TYPE);
      expect(resource.contents[0]?._meta?.['openai/ui']).toEqual({availableDisplayModes:['fullscreen'],preferredDisplayMode:'fullscreen'});
    } finally { await client.close(); await server.close(); }
  });
  it('keeps source and nonce private, rejects forged observations and bounds logs', async () => {
    const events: unknown[] = [];
    const server = createProbeServer('<html/>', e => {events.push(e);});
    const client = new Client({name:'test',version:'1'});
    const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      const opened = await client.callTool({name:'open_probe_pdf',arguments:{file:{name:'private.pdf',resourceUri:'opaque:secret'}},_meta:{'openai/resource':{path:'/private/source.pdf'}}});
      const grant = opened._meta?.['placekeeper/probe'] as {nonce:string};
      expect(grant.nonce).toBeTruthy();
      expect(JSON.stringify({content:opened.content,structuredContent:opened.structuredContent})).not.toMatch(/secret|private.pdf|nonce/);
      expect((await client.callTool({name:'probe_observe',arguments:{nonce:'forged',event:'mount',mountId:'a'}})).isError).toBe(true);
      expect((await client.callTool({name:'probe_observe',arguments:{nonce:grant.nonce,event:'mount',mountId:'a',details:{resources:true,secret:'private-data'}}})).isError).not.toBe(true);
      expect(JSON.stringify(events)).toContain('"resources":true');
      expect(JSON.stringify(events)).not.toMatch(/opaque:secret|private.pdf|private-data|\/private\/source|forged/);
      expect(JSON.stringify(events)).not.toContain(grant.nonce);
      expect((await client.callTool({name:'open_probe_pdf',arguments:{file:{name:'a',resourceUri:''}}})).isError).toBe(true);
    } finally {await client.close();await server.close();}
  });
});
