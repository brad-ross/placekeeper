import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIntegrationSetup } from '../src/integration-setup.js';
it('defaults every host off, permits later opt-in, and suppresses isolated startup', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-first-')); const statePath=join(root,'choices');
 const seen: unknown[]=[]; let enabled=false; let dialogs=0;
 const setup=createIntegrationSetup({statePath,isolated:false,present:async options=>{dialogs++;expect(options.defaultId).toBe(0);return enabled && options.message.includes('Chrome')?1:0;},setup:async choices=>{seen.push(choices);await writeFile(statePath,'{}');return {outcomes:[]};}});
 await setup.firstLaunch();expect(seen).toEqual([{chrome:'skip',vscode:'skip',codex:'skip'}]);
 await setup.firstLaunch();expect(dialogs).toBe(3);
 enabled=true;await setup.open();expect(seen[1]).toEqual({chrome:'setup',vscode:'skip',codex:'skip'});
 const isolated=createIntegrationSetup({statePath:join(root,'missing'),isolated:true,present:async()=>{throw Error('No isolated prompt');},setup:async()=>{throw Error('No isolated host writes');}});
 await isolated.firstLaunch();await isolated.open();
});
it('contains setup failure so first PDF startup can continue', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-failure-'));const messages:string[]=[];
 const action=createIntegrationSetup({statePath:join(root,'missing'),isolated:false,present:async options=>{messages.push(options.message);return 1;},setup:async()=>{throw Error('Host setup unavailable');}});
 await expect(action.firstLaunch()).resolves.toBeUndefined();
 expect(messages.at(-1)).toContain('PDFs can still be opened');
});
it('repairs previously opted-in integrations without opting into skipped hosts', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-refresh-'));const statePath=join(root,'choices');await writeFile(statePath,JSON.stringify({choices:{chrome:true}}));
 const choicesSeen:unknown[]=[];const messages:string[]=[];
 const action=createIntegrationSetup({statePath,isolated:false,present:async options=>{messages.push(options.message);return 0;},setup:async choices=>{choicesSeen.push(choices);return {outcomes:[{host:'chrome',status:'pending',registration:'repaired',message:'Reload Chrome'}]};}});
 await action.firstLaunch();expect(choicesSeen).toEqual([{chrome:'setup',vscode:'skip',codex:'skip'}]);expect(messages).toEqual(['Integration refresh needs host action']);
});
