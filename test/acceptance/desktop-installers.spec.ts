import { MANAGEMENT_PROTOCOL_VERSION, requestControl } from '../../apps/service/src/host/launch-control.js';
import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const execute=promisify(execFile);
/** Explicit interactive native qualification. The ordinary portable suite does
 * not select this file. Missing native evidence fails this gate; it is never a
 * reason to count a package as qualified. Approve the actual installer dialogs
 * on the native host while this test waits. Debian lifecycle and downloaded OS
 * approval remain separate native-host qualification obligations. */
test('the exact native installer reaches guarded shell readiness in an isolated installation',async()=>{
  test.setTimeout(240_000);
  const artifact=process.env.PLACEKEEPER_NATIVE_INSTALLER_ARTIFACT;
  expect(artifact,'Provide the exact DMG or Setup.exe on its native host').toBeTruthy();
  expect(['darwin','win32']).toContain(process.platform);
  const root=await mkdtemp(process.platform==='darwin'?'/tmp/pk-native-':join(tmpdir(),'pk-native-'));
  const destination=join(root,process.platform==='darwin'?'Placekeeper.app':'Placekeeper');
  const state=join(root,'state');
  const port=process.env.PLACEKEEPER_NATIVE_INSTALLER_PORT;
  expect(port,'Provide an unused isolated service port').toMatch(/^\d+$/u);
  const digest=createHash('sha256').update(await readFile(resolve(artifact!))).digest('hex');
  const mount=join(root,'mounted');
  let mounted=false;
  try {
    let executable=resolve(artifact!);
    if(process.platform==='darwin') {
      if(process.env.PLACEKEEPER_REQUIRE_DOWNLOADED_APPROVAL==='1')expect((await execute('/usr/bin/xattr',['-p','com.apple.quarantine',executable])).stdout.trim()).not.toBe('');
      await execute('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,executable]);mounted=true;
      executable=join(mount,'Install Placekeeper.app/Contents/MacOS/install');
    }
    const args=['--destination',destination,'--http-port',port!,'--isolated-test-root',state];
    const child=spawn(executable,args,{stdio:'inherit',shell:false});
    const code=await new Promise<number>((accept,reject)=>{child.once('error',reject);child.once('exit',code=>accept(code??2));});
    expect(code).toBe(0);
    const transactions=join(root,'.placekeeper-install-transactions');
    const entries=await readdir(transactions);
    expect(entries.length).toBe(1);
    const journal=JSON.parse(await readFile(join(transactions,entries[0]!,'journal.json'),'utf8'));
    expect(journal.phase).toBe('complete');expect(journal.destination).toBe(destination);
    const receipt=JSON.parse(await readFile(journal.shellReceipt,'utf8'));
    expect(receipt.rendererReady).toBe(true);expect(receipt.candidateIdentity).toBe(journal.candidateIdentity);expect(receipt.attempt).toBe(journal.attempt);
    await writeFile(join(root,'native-evidence.json'),JSON.stringify({schemaVersion:1,artifact:resolve(artifact!),sha256:digest,platform:process.platform,architecture:process.arch,actualInstallerEntry:executable,guardedActivation:journal,scope:'fresh isolated install and actual renderer/PDF readiness; OS approval, upgrade, uninstall and legacy migration require separate evidence'},null,2));
    // Leave complete evidence and runtime available for the native-host runner.
    console.log(`Native installer evidence: ${join(root,'native-evidence.json')}`);
  } finally {
    try {
      const socketPath=join(state,'control.sock');
      const present=await lstat(socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;});
      if(present) {
        const shutdown=await requestControl(socketPath,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'shutdown-if-idle'});
        expect(shutdown).toMatchObject({kind:'management',operation:'shutdown-if-idle',result:{status:'accepted'}});
        await expect.poll(()=>lstat(socketPath).then(()=>false,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return true;throw error;}),{timeout:5_000}).toBe(true);
        await writeFile(join(root,'native-cleanup.json'),JSON.stringify({isolatedServiceShutdown:shutdown,evidenceRetained:true},null,2));
      }
    } finally { if(mounted)await execute('/usr/bin/hdiutil',['detach',mount]); }
  }
});
