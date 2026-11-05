import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createProbeServer } from './server.js';
const root=dirname(fileURLToPath(import.meta.url));
const logPath=process.env.PLACEKEEPER_PROBE_LOG;
await createProbeServer(readFileSync(join(root,'probe.html'),'utf8'), event=>{
  if(logPath) appendFileSync(logPath,JSON.stringify(event)+'\n',{mode:0o600});
}).connect(new StdioServerTransport());
