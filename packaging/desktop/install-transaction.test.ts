import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { activateInstallation, recoverInstallation } from './install-transaction.mjs';

for (const boundary of ['staging', 'retaining', 'activating', 'starting', 'committing']) it(`recovers interruption at ${boundary} without losing previous app or restoring data`, async () => {
 const root = await mkdtemp(join(tmpdir(), 'pk-journal-'));
 try {
 const built = join(root,'built'), destination=join(root,'app'), transactionRoot=join(root,'journal');
 await mkdir(built); await writeFile(join(built,'version'),'new'); await mkdir(destination); await writeFile(join(destination,'version'),'old');
 const options = { built,destination,transactionRoot, candidateIdentity:'b'.repeat(64), backupRoot:join(root,'backup'), validate:async()=>{}, ready:async()=>{}, retire:async()=>{}, checkpoint:async(phase:string)=>{if(phase===boundary) throw Object.assign(new Error('power loss'),{interrupted:true});} };
 await expect(activateInstallation(options)).rejects.toThrow('power loss');
 await recoverInstallation({...options, checkpoint:undefined});
 expect(await readFile(join(destination,'version'),'utf8')).toBe('old');
 } finally {await rm(root,{recursive:true,force:true});}
});
it('retains both versions and backup when candidate retirement is uncertain',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pk-journal-'));
 try {
 const built=join(root,'built'),destination=join(root,'app'),transactionRoot=join(root,'journal');
 await mkdir(built);await writeFile(join(built,'version'),'new');await mkdir(destination);await writeFile(join(destination,'version'),'old');
 await expect(activateInstallation({built,destination,transactionRoot,candidateIdentity:'b'.repeat(64),backupRoot:join(root,'backup'),validate:async()=>{},ready:async()=>{throw Error('renderer failed');},retire:async()=>{throw Error('still running');}})).rejects.toThrow('retirement');
 expect(await readFile(join(destination,'version'),'utf8')).toBe('new');
 const journal=JSON.parse(await readFile(join(transactionRoot,'journal.json'),'utf8'));expect(await readFile(join(journal.previous,'version'),'utf8')).toBe('old');expect(journal.phase).toBe('retirement-uncertain');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('changes only the per-user selection for an immutable runtime, and retains its previous selection',async()=>{
 const {activateRuntimeSelection,recoverRuntimeSelection}=await import('./install-transaction.mjs');
 const root=await mkdtemp(join(tmpdir(),'pk-runtime-selection-'));
 try{
 const runtime=join(root,'system-runtime');await mkdir(runtime);await writeFile(join(runtime,'sandbox'),'root-owned helper');
 const selectionPath=join(root,'selection.json');const previous={version:1,resources:join(root,'previous-runtime'),installArtifactIdentity:'a'.repeat(64)};await writeFile(selectionPath,JSON.stringify(previous));
 const options={resources:runtime,selectionPath,transactionRoot:join(root,'journal'),candidateIdentity:'b'.repeat(64),backupRoot:join(root,'backup'),validate:async()=>{},ready:async()=>{throw Object.assign(Error('interrupted shell'),{interrupted:true});},retire:async()=>{}};
 await expect(activateRuntimeSelection(options)).rejects.toThrow('interrupted');await recoverRuntimeSelection(options);
 expect(JSON.parse(await readFile(selectionPath,'utf8'))).toEqual(previous);expect(await readFile(join(runtime,'sandbox'),'utf8')).toBe('root-owned helper');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('preserves the incumbent when candidate verification fails, and retains a successful previous app for later recovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pk-retained-'));
 try{
 const built=join(root,'built'),destination=join(root,'app'),transactionRoot=join(root,'journal');await mkdir(built);await writeFile(join(built,'version'),'new');await mkdir(destination);await writeFile(join(destination,'version'),'old');
 const options={built,destination,transactionRoot,candidateIdentity:'b'.repeat(64),backupRoot:join(root,'backup'),validate:async()=>{},ready:async()=>{},retire:async()=>{throw Error('must not run');}};
 await expect(activateInstallation({...options,validate:async()=>{throw Error('copy verification failed');}})).rejects.toThrow('verification');expect(await readFile(join(destination,'version'),'utf8')).toBe('old');
 const record=await activateInstallation(options);expect(await readFile(join(record.previous,'version'),'utf8')).toBe('old');
 await writeFile(join(root,'newer-user-data'),'acknowledged after upgrade');await recoverInstallation(options);
 expect(await readFile(join(destination,'version'),'utf8')).toBe('new');expect(await readFile(join(root,'newer-user-data'),'utf8')).toBe('acknowledged after upgrade');
 }finally{await rm(root,{recursive:true,force:true});}
});

it('recovers a fresh install interrupted after activation rename and before the next journal write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pk-post-rename-'));
 try{
 const built=join(root,'built'),destination=join(root,'app');await mkdir(built);await writeFile(join(built,'version'),'candidate');
 const options={built,destination,transactionRoot:join(root,'journal'),candidateIdentity:'b'.repeat(64),backupRoot:join(root,'backup'),validate:async()=>{},ready:async()=>{throw Error('must not start');},retire:async()=>{throw Error('must not retire unstarted shell');}};
 await expect(activateInstallation({...options,checkpoint:async(phase:string)=>{if(phase==='candidate-moved')throw Object.assign(Error('post rename crash'),{interrupted:true});}})).rejects.toThrow('post rename');
 expect(JSON.parse(await readFile(join(root,'journal','journal.json'),'utf8')).phase).toBe('activating');
 const record=await recoverInstallation(options);
 await expect(readFile(join(destination,'version'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(join(record.failed,'version'),'utf8')).toBe('candidate');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('rejects a journal nested inside an app even when the child begins with two dots',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pk-nested-'));
 try{
 await expect(activateInstallation({built:join(root,'built'),destination:join(root,'app'),transactionRoot:join(root,'app','..journal'),backupRoot:join(root,'backup')})).rejects.toThrow('outside');
 }finally{await rm(root,{recursive:true,force:true});}
});
