import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseStartupRequest, writeStartupReceipt, verifyStartupReceipt } from '../src/startup-receipt.js';
it('accepts readiness only for the fresh exact activation attempt', async()=>{
 const root=await mkdtemp(join(tmpdir(),'pk-shell-receipt-'));
 try{
 const request={version:1 as const,attempt:'a'.repeat(48),candidateIdentity:'b'.repeat(64),receipt:join(root,'receipt.json'),profile:join(root,'profile'),fixture:join(root,'fixture.pdf')};
 expect(parseStartupRequest(JSON.stringify(request))).toEqual(request);
 await expect(writeStartupReceipt(request,'c'.repeat(64))).rejects.toThrow('identity');
 await writeStartupReceipt(request,request.candidateIdentity);await verifyStartupReceipt(request);
 const saved=JSON.parse(await readFile(request.receipt,'utf8'));await writeFile(request.receipt,JSON.stringify({...saved,attempt:'c'.repeat(48)}));
 await expect(verifyStartupReceipt(request)).rejects.toThrow('attempt');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('refuses malformed startup authority',()=>{expect(()=>parseStartupRequest('{}')).toThrow();expect(parseStartupRequest(undefined)).toBeUndefined();});
it('exposes the retained previous app after late startup failure without restoring newer user work',async()=>{
 const {createHash}=await import('node:crypto');const {mkdir}=await import('node:fs/promises');const {retainedStartupRecovery}=await import('../src/startup-receipt.js');
 const root=await mkdtemp(join(tmpdir(),'pk-late-startup-'));
 try{
 const destination=join(root,'Placekeeper.app'),attempt='a'.repeat(48),backup=join(root,'backup');
 const journalRoot=join(root,'.placekeeper-install-transactions',createHash('sha256').update(destination).digest('hex').slice(0,24));const previous=join(journalRoot,attempt,process.platform === 'darwin' ? 'previous.app' : 'previous');
 await mkdir(previous,{recursive:true});await writeFile(join(previous,'application'),'known good');await mkdir(backup);await writeFile(join(backup,'draft'),'older work');await writeFile(join(root,'current-draft'),'newer work');
 const record={version:1,destination,attempt,phase:'complete',previous,backupRoot:backup};await writeFile(join(journalRoot,'journal.json'),JSON.stringify(record));
 const guidance=await retainedStartupRecovery(destination);expect(guidance).toContain(previous);expect(guidance).toContain(backup);
 expect(await readFile(join(root,'current-draft'),'utf8')).toBe('newer work');expect(await readFile(join(backup,'draft'),'utf8')).toBe('older work');expect(await readFile(join(previous,'application'),'utf8')).toBe('known good');
 await writeFile(join(journalRoot,'journal.json'),JSON.stringify({...record,previous:root}));expect(await retainedStartupRecovery(destination)).toBeUndefined();
 }finally{await rm(root,{recursive:true,force:true});}
});
