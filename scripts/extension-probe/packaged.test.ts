import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
it('starts the built plugin through its exact registration from another cwd',async()=>{
  const root=resolve('dist/extension-probe');
  const manifest=JSON.parse(await readFile(join(root,'extension-probe/.mcp.json'),'utf8'));
  const registered=manifest.mcpServers['placekeeper-extension-probe'];
  const temp=await mkdtemp(join(tmpdir(),'pk extension probe '));
  const client=new Client({name:'package-smoke',version:'1'});
  const transport=new StdioClientTransport({...registered,env:{PLACEKEEPER_PROBE_LOG:join(temp,'events.jsonl')},cwd:temp,stderr:'pipe'});
  try{
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe('placekeeper-extension-probe');
    const opened=await client.callTool({name:'open_probe',arguments:{}});
    const grant=opened._meta?.['placekeeper/probe'] as {nonce:string};
    expect(grant.nonce).toBeTruthy();
    const resources=await client.listResources();
    const html=await client.readResource({uri:resources.resources[0]!.uri});
    expect(JSON.stringify(html)).toContain('Read PDF again');
    expect(JSON.stringify(html)).not.toContain(grant.nonce);
    await client.callTool({name:'probe_observe',arguments:{nonce:grant.nonce,mountId:'test',event:'mount',details:{resources:true}}});
    const log=await readFile(join(temp,'events.jsonl'),'utf8');
    expect(log).toContain('"event":"mount"');expect(log).not.toContain(grant.nonce);
  }finally{await client.close();await rm(temp,{recursive:true,force:true});}
});
