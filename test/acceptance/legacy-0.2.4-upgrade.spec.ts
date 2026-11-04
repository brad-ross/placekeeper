import { test, expect, type Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { MANAGEMENT_PROTOCOL_VERSION, requestControl } from '../../apps/service/src/host/launch-control.js';
test.use({actionTimeout:15_000,trace:'retain-on-failure',screenshot:'only-on-failure'});
const execute=promisify(execFile);
async function comments(path:string):Promise<string[]>{
 const pdf=await PDFDocument.load(await readFile(path));return pdf.getPages().flatMap(page=>{const annotations=page.node.lookupMaybe(PDFName.of('Annots'),PDFArray);if(!annotations)return [];return Array.from({length:annotations.size()},(_,index)=>{const value=annotations.lookup(index,PDFDict).lookup(PDFName.of('Contents'));return value instanceof PDFString||value instanceof PDFHexString?value.decodeText():'';});});
}

const publicCommit='3e37ca4b84dde61725b8e03d87dbc3023f1d1f4f';
const publicArchiveSha='d67be517bf191966ea4d380d00f75cca3b7804e4920d007adf20bbb927d62a41';
/** The authentic AppKit service is launched directly with a disposable HOME.
 * Never launch PlacekeeperMac: standard UserDefaults isolation by HOME is not
 * established. Native window/preferences/host migration remain separate gates. */
test('actual public AppKit service work survives the exact guarded DMG migration',async({browser},testInfo)=>{
 test.setTimeout(300_000);
 expect(process.platform).toBe('darwin');expect(process.arch).toBe('arm64');
 const baseline=process.env.PLACEKEEPER_LEGACY_APP,source=process.env.PLACEKEEPER_LEGACY_SOURCE,archive=process.env.PLACEKEEPER_LEGACY_ARCHIVE,artifact=process.env.PLACEKEEPER_NATIVE_INSTALLER_ARTIFACT,port=process.env.PLACEKEEPER_LEGACY_PORT;
 expect(baseline&&source&&archive&&artifact&&port,'Provide authentic built baseline, extracted source/archive, exact DMG and unused port').toBeTruthy();
 expect(createHash('sha256').update(await readFile(archive!)).digest('hex')).toBe(publicArchiveSha);
 const descriptor=await readFile(join(source!,'release-descriptor.txt'),'utf8');expect(descriptor).toContain(`commit=${publicCommit}`);expect(descriptor).toContain('version=0.2.4');
 const plist=(await execute('/usr/bin/plutil',['-convert','json','-o','-',join(baseline!,'Contents/Info.plist')])).stdout;
 expect(JSON.parse(plist)).toMatchObject({CFBundleIdentifier:'local.placekeeper',CFBundleExecutable:'PlacekeeperMac',CFBundleShortVersionString:'0.2.4'});
 const root=await mkdtemp('/tmp/pk-old-'),destination=join(root,'Applications/Placekeeper.app'),state=join(root,'Library/Application Support/Placekeeper'),socket=join(state,'control.sock'),mount=join(root,'mounted');
 await mkdir(join(root,'Applications'));await cp(baseline!,destination,{recursive:true});await mkdir(state,{recursive:true,mode:0o700});
 const pdf=join(root,'Legacy review.pdf');await copyFile(resolve('test/fixtures/pdfs/text-native.pdf'),pdf);
 const sentinel=join(state,'unknown-user-content');await writeFile(sentinel,'preserve unknown user state');
 const environment={...process.env,HOME:root,PLACEKEEPER_USER_HOME:root,PLACEKEEPER_OFFLINE:'1',PATH:'/usr/bin:/bin'};
 for(const key of Object.keys(environment))if(key.startsWith('PLACEKEEPER_')&&!['PLACEKEEPER_USER_HOME','PLACEKEEPER_OFFLINE'].includes(key))delete (environment as NodeJS.ProcessEnv)[key];
 const old=join(destination,'Contents/MacOS/placekeeper');
 const daemon=spawn(old,['daemon','--isolated-installed-smoke','--http-port',port!],{env:environment,stdio:'ignore'});let startupError:Error|undefined;daemon.once('error',error=>startupError=error);
 let mounted=false;let page:Page|undefined;let primaryFailure:unknown;
 try{
  await expect.poll(async()=>{if(startupError)throw startupError;if(daemon.exitCode!==null)throw Error(`Old service exited ${daemon.exitCode}`);return lstat(socket).then(info=>info.isSocket(),()=>false);},{timeout:30_000}).toBe(true);
  console.log('Legacy service ready; opening isolated browser review');
  const opened=JSON.parse((await execute(old,['open','--json','--surface','finder','--pdf',pdf],{env:environment})).stdout);
  expect(opened.ok).toBe(true);const reviewPage=await browser.newPage();page=reviewPage;await reviewPage.goto(opened.url);
  await expect(reviewPage.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready','true',{timeout:30_000});
  await test.step('choose the disposable legacy PDF as the real save destination',async()=>{
   await reviewPage.getByRole('button',{name:/Open automatic save options$/u}).click();
   const dialog=reviewPage.getByRole('dialog',{name:'Choose where to save annotations'});
   await dialog.getByRole('radio',{name:'Modify the original PDF'}).check();await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).toHaveCount(0);
  });
  const note=async(text:string,save:boolean)=>{
   const target=reviewPage.locator('.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]').first();const box=await target.boundingBox();expect(box).toBeTruthy();
   await target.click({button:'right',position:{x:box!.width*.7,y:box!.height*(save?.55:.75)}});await reviewPage.getByRole('menuitem',{name:'Add Page Note'}).click();
   const composer=reviewPage.getByRole('region',{name:/^Page Note(?: · 1)?$/u});await composer.getByRole('textbox',{name:'Comment',exact:true}).fill(text);if(save)await composer.getByRole('button',{name:'Save',exact:true}).click();
  };
  await test.step('save an annotation through the actual old service writer',async()=>{
   await note('Accepted by real public 0.2.4',true);await expect.poll(()=>comments(pdf),{timeout:20_000}).toContain('Accepted by real public 0.2.4');
  });
  await test.step('protect an unfinished old-service editor draft',async()=>{await note('Protected input from real public 0.2.4',false);});
  const snapshots=async()=>{const dirs=await readdir(join(state,'recovery'));return Promise.all(dirs.filter(dir=>!dir.startsWith('.')).map(async dir=>({dir,bytes:await readFile(join(state,'recovery',dir,'draft.json'),'utf8')})));};
  await expect.poll(async()=>JSON.stringify(await snapshots()).includes('Protected input from real public 0.2.4'),{timeout:15_000}).toBe(true);
  const before=await snapshots();expect(JSON.stringify(before)).toContain('Accepted by real public 0.2.4');
  const boundary=async(phase:string)=>{
   const retained=await snapshots();
   const record={phase,snapshots:retained,persistedComments:await comments(pdf)};
   const path=join(root,`legacy-${phase}.json`);await writeFile(path,JSON.stringify(record,null,2));
   await testInfo.attach(`legacy-${phase}`,{path,contentType:'application/json'});
   expect(JSON.stringify(retained),`Actual public legacy service must retain Protected Draft at ${phase}, before candidate installation`).toContain('Protected input from real public 0.2.4');
   return retained;
  };

  const status=async()=>{
   const response=await requestControl(socket,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'status'});
   if(response.kind!=='management'||response.operation!=='status')throw Error('Legacy status unavailable');
   return response.status;
  };
  const incumbent=await status();
  // Actual browser navigation releases the view while retaining this tab's
  // native back-navigation/sessionStorage semantics. No state is synthesized.
  await reviewPage.goto('about:blank');
  const afterBrowserNavigation=await boundary('after-browser-navigation');
  await expect.poll(async()=>{
   const current=await status();return current.activity.reviewPresence+current.activity.codexTasks+current.activity.transientWork;
  },{timeout:20_000}).toBe(0);
  console.log('Legacy view released; exact candidate must refuse unsafe legacy retirement');
  await execute('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,resolve(artifact!)]);mounted=true;
  const installer=join(mount,'Install Placekeeper.app/Contents/MacOS/install');
  const install=()=>new Promise<number>((accept,reject)=>{const child=spawn(installer,['--destination',destination,'--http-port',port!,'--isolated-test-root',state],{env:environment,stdio:'inherit'});child.once('error',reject);child.once('exit',code=>accept(code??2));});
  const refusal=await install();expect(refusal,'Unsafe legacy retirement must stop before replacing the app').not.toBe(0);
  const afterRefusal=await boundary('after-refused-upgrade');expect(afterRefusal).toEqual(afterBrowserNavigation);
  expect(await status()).toMatchObject({daemonIdentity:incumbent.daemonIdentity,lifecycle:'accepting'});
  expect(JSON.parse((await execute('/usr/bin/plutil',['-convert','json','-o','-',join(destination,'Contents/Info.plist')])).stdout)).toMatchObject({CFBundleExecutable:'PlacekeeperMac',CFBundleShortVersionString:'0.2.4'});
  console.log('Candidate refusal preserved actual legacy process and draft; return to legacy UI to save it');
  await reviewPage.goBack();
  await expect(reviewPage.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready','true',{timeout:30_000});
  await test.step('explicitly finish the protected legacy draft through its original browser UI',async()=>{
   const composer=reviewPage.getByRole('region',{name:/^Page Note(?: · 1)?$/u});
   if(await composer.isVisible()){
    await expect(composer.getByRole('textbox',{name:'Comment',exact:true})).toHaveValue('Protected input from real public 0.2.4');
    await composer.getByRole('button',{name:'Save',exact:true}).click();
   }else{
    const workspace=reviewPage.getByRole('button',{name:'Show workspace',exact:true});if(await workspace.isVisible())await workspace.click();
    await reviewPage.getByRole('tab',{name:'Annotations',exact:true}).click();
    const draft=reviewPage.locator('[data-reconciliation-draft]').filter({hasText:'Protected input from real public 0.2.4'});
    await draft.getByRole('button',{name:/Apply previous Page Note annotation on page 1/u}).click();
    await reviewPage.locator('[data-apply-confirmation]').getByRole('button',{name:'Apply',exact:true}).click();
   }
   await expect.poll(()=>comments(pdf),{timeout:20_000}).toContain('Protected input from real public 0.2.4');
   await expect.poll(async()=>(await snapshots()).every(snapshot=>JSON.parse(snapshot.bytes).payload.state.pendingDrafts.length===0),{timeout:15_000}).toBe(true);
  });
  const beforeRetirement=await snapshots();const beforeInstallPdf=await readFile(pdf);await reviewPage.close();
  console.log('Both legacy notes explicitly saved and no pending draft remains; requesting idle retirement');
  await expect(async()=>{const result=await requestControl(socket,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'shutdown-if-idle'});expect(result).toMatchObject({result:{status:'accepted'}});}).toPass({timeout:20_000});
  await expect.poll(()=>lstat(socket).then(()=>false,()=>true),{timeout:10_000}).toBe(true);
  const afterLegacyRetirement=await snapshots();
  // The old clean-recovery garbage collector may remove saved snapshots. The
  // annotations must now be portable in the real PDF, before candidate launch.
  expect(await comments(pdf)).toEqual(expect.arrayContaining(['Accepted by real public 0.2.4','Protected input from real public 0.2.4']));
  console.log('Safe legacy idle retirement complete; installing exact candidate DMG');
  expect(await install()).toBe(0);
  expect(await readFile(pdf)).toEqual(beforeInstallPdf);expect(await comments(pdf)).toEqual(expect.arrayContaining(['Accepted by real public 0.2.4','Protected input from real public 0.2.4']));expect(await readFile(sentinel,'utf8')).toBe('preserve unknown user state');
  const after=await snapshots();
  const evidence={schemaVersion:1,baseline:{publicCommit,publicArchiveSha,app:resolve(baseline!),identity:JSON.parse(await readFile(join(baseline!,'Contents/Resources/build-identity.json'),'utf8'))},artifact:{path:resolve(artifact!),sha256:createHash('sha256').update(await readFile(artifact!)).digest('hex')},before,afterBrowserNavigation,refusal,afterRefusal,beforeRetirement,afterLegacyRetirement,after,scope:'Actual public service protected draft blocks unsafe exact-DMG retirement with incumbent and recovery unchanged. User explicitly saves that draft through authentic legacy UI; both portable annotations and unknown user content survive the subsequent exact DMG installation. This does not establish automatic unfinished-draft migration, old AppKit UI/preferences generation, real hosts or downloaded OS approval.'};
  await writeFile(join(root,'legacy-migration-evidence.json'),JSON.stringify(evidence,null,2));await testInfo.attach('legacy-service-migration',{path:join(root,'legacy-migration-evidence.json'),contentType:'application/json'});console.log(`Legacy service migration evidence: ${join(root,'legacy-migration-evidence.json')}`);
 }catch(error){primaryFailure=error;throw error;}finally{
  // Browser leases must be released even when a selector/assertion fails.
  // Preserve the first failure and attach cleanup diagnostics instead of
  // replacing it with an expected active-review shutdown refusal.
  await page?.close().catch(error=>console.error('Legacy browser cleanup:',error));
  try{
   if(await lstat(socket).then(()=>true,()=>false)){
    const recovery=join(state,'recovery');
    const directories=await readdir(recovery,{withFileTypes:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;});
    for(const directory of directories){
     if(!directory.isDirectory()||directory.name.startsWith('.'))continue;
     const current=await readFile(join(recovery,directory.name,'draft.json'),'utf8');
     const envelope=JSON.parse(current);
     if(envelope.checksum!==createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex')||envelope.payload.schemaVersion!==3||!Array.isArray(envelope.payload.state.pendingDrafts))throw Error(`Legacy cleanup cannot prove a valid current snapshot; service retained at ${root}`);
     // A valid current generation supersedes its historical previous file.
     // Missing/invalid current is deliberately not guessed at during cleanup.
     if(envelope.payload.state.pendingDrafts.length)throw Error(`Legacy cleanup refused unsafe retirement with protected draft; service and recovery retained at ${root}`);

    }
    await expect(async()=>{
     const retired=await requestControl(socket,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'shutdown-if-idle'});expect(retired).toMatchObject({result:{status:'accepted'}});
    }).toPass({timeout:20_000});
    await expect.poll(()=>lstat(socket).then(()=>false,()=>true),{timeout:10_000}).toBe(true);
   }
  }catch(error){
   if(primaryFailure){await testInfo.attach('legacy-cleanup-failure',{body:Buffer.from(String(error)),contentType:'text/plain'});console.error('Legacy service retained for controlled recovery:',error);}
   else throw error;
  }finally{if(mounted)await execute('/usr/bin/hdiutil',['detach',mount]);}
 }
});
