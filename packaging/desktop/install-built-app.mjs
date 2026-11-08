import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { desktopExecutable, resolveLauncherRuntime } from './launcher.mjs';
import { assertSafeInstallDestinationOnDisk, resolveInstallLayout, removeOwnedInstallationFiles } from './install-layout.ts';
import { activateInstallation, activateRuntimeSelection } from './install-transaction.mjs';
const execute = promisify(execFile);
export function runtimeRoot(app, platform = process.platform) { return join(app, platform === 'darwin' ? 'Contents/Resources/desktop' : 'resources/desktop'); }
async function verifyLease(context) {
  if (!isAbsolute(context.lockPath ?? '') || !/^[A-Za-z0-9_-]{32}$/u.test(context.lockToken ?? '')) throw new Error('App replacement requires the coordinator lifecycle lease');
  const record = JSON.parse(await readFile(join(context.lockPath, `owner-${context.lockToken}.json`), 'utf8'));
  if (record.version !== 1 || record.token !== context.lockToken || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('Invalid coordinator lifecycle lease');
  process.kill(record.pid, 0);
}
async function recoveryDigest(path) {
  const hash = createHash('sha256');
  async function visit(entry, name) {
    const info = await lstat(entry);
    if (info.isDirectory()) {
      hash.update(JSON.stringify(['directory', name]));
      for (const child of (await readdir(entry)).sort()) await visit(join(entry, child), join(name, child));
    } else if (info.isFile()) {
      const file = createHash('sha256');
      for await (const chunk of createReadStream(entry)) file.update(chunk);
      hash.update(JSON.stringify(['file', name, file.digest('hex')]));
    } else {
      throw Error('Recovery backup contains an unexpected entry');
    }
  }
  if (!(await lstat(path)).isDirectory()) throw Error('Recovery backup is not a directory');
  await visit(path, '');
  return hash.digest('hex');
}
async function removeDuplicateBackup(previous, current, lockPath) {
  const installer = join(dirname(lockPath), 'installer');
  if (previous === current || ![previous, current].every(path =>
    dirname(path) === installer && /^recovery-backup-\d+$/u.test(basename(path)))) return;
  if (!(await lstat(installer)).isDirectory()) return;
  const old = await recoveryDigest(previous).catch(error => { if(error.code!=='ENOENT') throw error; });
  if (old && old === await recoveryDigest(current)) await rm(previous, {recursive:true});
}
async function validatePublicLegacyMacInstallation(destination) {
  if(process.platform!=='darwin')throw Error('Not a supported legacy installation');
  const contents=join(destination,'Contents'),resources=join(contents,'Resources');
  for(const path of [contents,join(contents,'MacOS'),resources,join(resources,'node'),join(resources,'node/bin'),join(resources,'service'),join(resources,'web')]) {
    const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Invalid legacy application layout');
  }
  const plistPath=join(contents,'Info.plist');
  if(!(await lstat(plistPath)).isFile())throw Error('Missing legacy application plist');
  const plist=JSON.parse((await execute('/usr/bin/plutil',['-convert','json','-o','-',plistPath])).stdout);
  if(plist.CFBundleIdentifier!=='local.placekeeper'||plist.CFBundleExecutable!=='PlacekeeperMac'||plist.CFBundleShortVersionString!=='0.2.4'||plist.CFBundleVersion!=='0.2.4'||plist.CFBundlePackageType!=='APPL')throw Error('Not the supported public macOS legacy application');
  const identityPath=join(resources,'build-identity.json');
  const identityInfo=await lstat(identityPath);if(!identityInfo.isFile()||identityInfo.isSymbolicLink())throw Error('Invalid legacy build identity file');
  const identity=JSON.parse(await readFile(identityPath,'utf8'));
  if(identity.managementProtocolVersion!==1||! /^[a-f0-9]{64}$/u.test(identity.daemonIdentity??'')||! /^[a-f0-9]{64}$/u.test(identity.installArtifactIdentity??''))throw Error('Invalid legacy build identity');
  const executables=[join(contents,'MacOS/PlacekeeperMac'),join(contents,'MacOS/placekeeper'),join(resources,'node/bin/node')];
  for(const path of [...executables,join(resources,'launcher.mjs'),join(resources,'service/main.js'),join(resources,'web/app.js'),join(resources,'web/pdfium.wasm')]) {
    const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||(executables.includes(path)&&!(info.mode&0o111)))throw Error('Incomplete public legacy application');
  }
}
async function validateExistingInstallation(destination) {
  const existing=await lstat(destination).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!existing)return;
  if(!existing.isDirectory()||existing.isSymbolicLink())throw Error('The existing destination is not a recognized complete Placekeeper installation; choose an empty destination');
  try {
    const manifest=await lstat(join(runtimeRoot(destination),'runtime-manifest.json')).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(!manifest) {await validatePublicLegacyMacInstallation(destination);return;}
    const runtime=await resolveLauncherRuntime(runtimeRoot(destination));
    for(const executable of [runtime.node,desktopExecutable(runtimeRoot(destination))]) {
      const info=await lstat(executable);if(!info.isFile()||info.isSymbolicLink()||(process.platform!=='win32'&&!(info.mode&0o111)))throw Error('Installed executable is missing or not executable');
    }
  } catch(error) { throw Error('The existing destination is not a recognized complete Placekeeper installation. Its contents were preserved; choose an empty destination.',{cause:error}); }
}
function fixturePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>','<< /Length 0 >>\nstream\n\nendstream'];
  let pdf='%PDF-1.4\n'; const offsets=[0];
  for (const [index,object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf+=`${index+1} 0 obj\n${object}\nendobj\n`; }
  const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return pdf;
}
/** Runs only after coordinated retirement and verified recovery backup. The
 * coordinator stays alive and holds its lease through shell readiness. */
export async function installBuiltApp(built, destination, readiness, port, invoke = execute, isolatedRoot, supplied = {}) {
  if (![built,destination,readiness].every(isAbsolute) || resolve(built) === resolve(destination)) throw new Error('Expected distinct absolute app paths');
  const context={ lockPath:process.env.PLACEKEEPER_LIFECYCLE_LOCK_PATH, lockToken:process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN, backupRoot:process.env.PLACEKEEPER_INSTALL_BACKUP_ROOT, ...supplied };
  await verifyLease(context);
  if (!isAbsolute(context.backupRoot ?? '')) throw new Error('Verified recovery backup location is required');
  const guardOptions = isolatedRoot ? { homeDirectory:isolatedRoot, env:{} } : undefined;
  await assertSafeInstallDestinationOnDisk(destination, guardOptions);
  await validateExistingInstallation(destination);
  const transactionRoot=context.transactionRoot ?? join(dirname(destination), '.placekeeper-install-transactions', createHash('sha256').update(resolve(destination)).digest('hex').slice(0,24));
  await assertSafeInstallDestinationOnDisk(transactionRoot, guardOptions);
  const legacyRoot=resolveInstallLayout(guardOptions).legacySourceRoot;
  let previousLocation;
  if(legacyRoot && resolve(legacyRoot)!==resolve(destination)) {
    const legacy=await lstat(join(runtimeRoot(legacyRoot),'runtime-manifest.json')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    if(legacy){ const runtime=await resolveLauncherRuntime(runtimeRoot(legacyRoot)); previousLocation={ app:legacyRoot, installArtifactIdentity:runtime.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY, retainedInPlace:true }; }
  }
  const candidate=await resolveLauncherRuntime(runtimeRoot(built));
  if (!(await lstat(desktopExecutable(runtimeRoot(built)))).isFile()) throw new Error('Desktop executable is missing');
  const expected=process.platform==='darwin'?join(destination,'Contents/MacOS/placekeeper'):join(runtimeRoot(destination),'bin',`placekeeper${process.platform==='win32'?'.exe':''}`);
  if (resolve(readiness)!==resolve(expected)) throw new Error('Unexpected installed readiness executable');
  await mkdir(dirname(destination),{recursive:true});
  const isolation=port===undefined?[]:['--isolated-installed-smoke','--http-port',port,...(isolatedRoot===undefined?[]:['--isolated-test-root',isolatedRoot])];
  const leaseEnvironment={PLACEKEEPER_LIFECYCLE_LOCK_PATH:context.lockPath,PLACEKEEPER_LIFECYCLE_LOCK_TOKEN:context.lockToken};
  const run=(executable,args,env={...process.env,...leaseEnvironment},timeout=30_000)=>invoke(executable,args,{env,timeout,maxBuffer:65_536});
  async function checkMacLaunch(app, attemptDirectory) {
    const profile = await mkdtemp(join(attemptDirectory, 'launch-check-'));
    try {
      await run(join(app, 'Contents/MacOS/placekeeper'), ['--installer-preflight'], undefined, 45_000);
      await run(desktopExecutable(runtimeRoot(app)), ['--placekeeper-installer-preflight', profile], undefined, 45_000);
    } catch (error) {
      throw Error('The new Placekeeper app could not start. If macOS blocked it, review the notice in System Settings → Privacy & Security, then retry this installer.', {cause:error});
    } finally {
      await rm(profile, {recursive:true, force:true}).catch(error => console.error('Installer check profile could not be removed:', error.message));
    }
  }
  return activateInstallation({ built,destination,transactionRoot,copy:process.platform==='darwin' ? async (source,target)=>{await execute('/usr/bin/ditto',['--rsrc','--extattr','--acl','--qtn',source,target]);} : undefined,previousLocation,backupRoot:context.backupRoot,candidateIdentity:candidate.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY,
    validate:async staged=>{
      await verifyLease(context);
      await assertSafeInstallDestinationOnDisk(destination,guardOptions);
      await validateExistingInstallation(destination);
      const runtime=await resolveLauncherRuntime(runtimeRoot(staged));
      if(runtime.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY!==candidate.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY)throw Error('Staged candidate changed');
    },
    ...(process.platform==='darwin' ? {
      verifyPreflightCopy:async staged=>{await execute('/usr/bin/codesign',['--verify','--deep','--strict',staged]);},
      preflight:checkMacLaunch,
      // macOS can assess the same app again at its final path. Until this
      // succeeds, the journal can restore the old app without retiring a service.
      beforeStart:checkMacLaunch,
      removeDuplicateBackup:(previous,current)=>removeDuplicateBackup(previous,current,context.lockPath),
      cleanup:async record=>{
        const directory=dirname(record.shellReceipt);
        await rm(join(directory, 'electron-profile'), {recursive:true, force:true});
        await rm(join(directory, 'Startup check.pdf'), {force:true});
      },
    } : {}),
    removePrevious:process.platform==='darwin' ? async previous=>{
      // Unsealed bundles can contain user-added files. Keep those for inspection.
      return execute('/usr/bin/codesign',['--verify','--deep','--strict',previous]).then(()=>true,()=>false);
    } : undefined,
    ...readinessCallbacks({ app:destination, readiness, context, isolation, run }),
  });
}
function readinessCallbacks({ app, readiness, context, isolation, run }) {
  const leaseEnvironment={PLACEKEEPER_LIFECYCLE_LOCK_PATH:context.lockPath,PLACEKEEPER_LIFECYCLE_LOCK_TOKEN:context.lockToken};
  return {
    ready:async (record,persist)=>{
      await verifyLease(context);
      record.serviceLaunchRequested=true;await persist();
      await run(readiness,['daemon','ensure-ready','--receipt',record.receipt,...isolation]);
      const fixture=join(dirname(record.shellReceipt),'Startup check.pdf');await writeFile(fixture,fixturePdf(),{flag:'wx'});
      const request={version:1,attempt:record.attempt,candidateIdentity:record.candidateIdentity,receipt:record.shellReceipt,profile:join(dirname(record.shellReceipt),'electron-profile'),fixture:await realpath(fixture)};
      const installed=await resolveLauncherRuntime(runtimeRoot(app));
      record.shellLaunchRequested=true;await persist();
      await run(desktopExecutable(runtimeRoot(app)),isolation,{...installed.environment,...leaseEnvironment,PLACEKEEPER_STARTUP_REQUEST:JSON.stringify(request)});
      const receipt=JSON.parse(await readFile(record.shellReceipt,'utf8'));
      if(receipt.version!==1||receipt.attempt!==record.attempt||receipt.candidateIdentity!==record.candidateIdentity||receipt.rendererReady!==true||!Number.isSafeInteger(receipt.pid)||receipt.pid<=0)throw Error('Installed shell did not acknowledge this activation attempt');
      const started=JSON.parse(await readFile(`${record.shellReceipt}.started`,'utf8'));
      if(started.attempt!==record.attempt||started.candidateIdentity!==record.candidateIdentity||started.pid!==receipt.pid)throw Error('Installed shell receipt does not match the launched process');
      try { process.kill(receipt.pid,0); throw Error('Startup probe has not retired'); } catch(error){if(error.code!=='ESRCH')throw error;}
    },
    retire:async record=>{await verifyLease(context);
      if(record.serviceLaunchRequested && !await lstat(record.receipt).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('Candidate service process identity is unavailable; preserve both app versions for manual recovery');
      const shell=await readFile(`${record.shellReceipt}.started`,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(shell){
        if(shell.attempt!==record.attempt||shell.candidateIdentity!==record.candidateIdentity||!Number.isSafeInteger(shell.pid)||shell.pid<=0)throw Error('Candidate shell process identity is uncertain');
        try { process.kill(shell.pid,0); throw Error('Candidate shell remains running; close it before retrying recovery'); } catch(error){if(error.code!=='ESRCH')throw error;}
      } else if(record.shellLaunchRequested) throw Error('Candidate shell start is uninspectable; preserve both app versions for manual recovery');
      const retiring=record.resources ? await resolveLauncherRuntime(record.resources) : undefined;
      if(retiring && retiring.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY!==record.candidateIdentity)throw Error('Retained runtime identity changed; preserve selections for manual recovery');
      await run(record.resources?join(record.resources,'bin/placekeeper'):readiness,['daemon','stop-ready','--receipt',record.receipt,...isolation],retiring?{...retiring.environment,...leaseEnvironment}:undefined);},
  };
}
export async function installImmutableRuntime(built, _destination, readiness, port, invoke = execute, isolatedRoot, supplied = {}) {
  const context={ lockPath:process.env.PLACEKEEPER_LIFECYCLE_LOCK_PATH, lockToken:process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN, backupRoot:process.env.PLACEKEEPER_INSTALL_BACKUP_ROOT, ...supplied };
  await verifyLease(context);
  if (!isAbsolute(context.backupRoot ?? '')) throw Error('Verified recovery backup location is required');
  const { validateImmutableRuntime, linuxSelectionPath } = await import('./linux-dispatcher.mjs');
  const resources=runtimeRoot(built);
  await validateImmutableRuntime(resources);
  const candidate=await resolveLauncherRuntime(resources);
  const selectionPath=linuxSelectionPath(isolatedRoot ? { HOME:isolatedRoot } : process.env);
  const transactionRoot=join(dirname(selectionPath),'runtime-activation');
  const isolation=port===undefined?[]:['--isolated-installed-smoke','--http-port',port,...(isolatedRoot===undefined?[]:['--isolated-test-root',isolatedRoot])];
  const leaseEnvironment={PLACEKEEPER_LIFECYCLE_LOCK_PATH:context.lockPath,PLACEKEEPER_LIFECYCLE_LOCK_TOKEN:context.lockToken};
  const run=(executable,args,env={...process.env,...leaseEnvironment})=>invoke(executable,args,{env,timeout:30_000,maxBuffer:65_536});
  return activateRuntimeSelection({ resources,selectionPath,transactionRoot,backupRoot:context.backupRoot,candidateIdentity:candidate.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY,
    validate:validateImmutableRuntime,...readinessCallbacks({ app:built,readiness:join(resources,'bin/placekeeper'),context,isolation,run }) });
}

export async function uninstallApp(built,destination,_readiness,_port,_invoke,isolatedRoot) {
  if (!['win32','darwin'].includes(process.platform) || resolve(built)===resolve(destination)) throw Error('Uninstall requires a separately staged complete runtime');
  const context={lockPath:process.env.PLACEKEEPER_LIFECYCLE_LOCK_PATH,lockToken:process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN,backupRoot:process.env.PLACEKEEPER_INSTALL_BACKUP_ROOT};
  await verifyLease(context);
  if(!isAbsolute(context.backupRoot??''))throw Error('Uninstall requires a verified recovery backup');
  await assertSafeInstallDestinationOnDisk(destination,isolatedRoot?{homeDirectory:isolatedRoot,env:{}}:undefined);
  await resolveLauncherRuntime(runtimeRoot(destination));
  const transactionRoot=join(dirname(destination),'.placekeeper-install-transactions',createHash('sha256').update(resolve(destination)).digest('hex').slice(0,24),'uninstall-'+Date.now());
  await assertSafeInstallDestinationOnDisk(transactionRoot,isolatedRoot?{homeDirectory:isolatedRoot,env:{}}:undefined);
  await mkdir(transactionRoot,{recursive:true,mode:0o700});
  const previous=join(transactionRoot,process.platform==='darwin'?'previous.app':'previous');
  if(process.platform==='darwin') {
    await verifyLease(context);
    if(!isolatedRoot)await execute('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',['-u',destination]);
    await writeFile(join(transactionRoot,'uninstall.json'),JSON.stringify({version:1,destination,previous,backupRoot:context.backupRoot,phase:'retaining'})+'\n',{flag:'wx',mode:0o600});
    await rename(destination,previous);
    await writeFile(join(transactionRoot,'uninstall.json'),JSON.stringify({version:1,destination,previous,backupRoot:context.backupRoot,phase:'complete'})+'\n',{mode:0o600});
    console.log(`Removed installed bundle. Complete recovery app: ${previous}. Protected recovery backup: ${context.backupRoot}.`);
    return;
  }
  const inventory=JSON.parse(await readFile(join(destination,'installation-files.json'),'utf8'));
  if(inventory.version!==1||!Array.isArray(inventory.files)||inventory.files.some(file=>typeof file!=='string'))throw Error('Installation ownership inventory is unavailable; installed files are preserved');
  await cp(destination,previous,{recursive:true,verbatimSymlinks:true});
  await writeFile(join(transactionRoot,'uninstall.json'),JSON.stringify({version:1,destination,previous,backupRoot:context.backupRoot,phase:'retained'})+'\n',{flag:'wx',mode:0o600});
  await verifyLease(context);
  const { unregisterWindowsInstallation }=await import('./windows-registration.mjs');
  try {
    const retained=isolatedRoot?[]:await unregisterWindowsInstallation(destination);
    if(retained.length)console.log(JSON.stringify({kind:'placekeeper-uninstall-retained',resources:retained}));
    await removeOwnedInstallationFiles(destination,inventory.files);
    await writeFile(join(transactionRoot,'uninstall.json'),JSON.stringify({version:1,destination,previous,backupRoot:context.backupRoot,phase:'complete'})+'\n',{mode:0o600});
  } catch(error) { throw Error(`Uninstall could not finish. Preserve remaining files in ${destination}. Complete recovery app: ${previous}. Protected recovery backup: ${context.backupRoot}. Close all Placekeeper sessions before manual recovery.`,{cause:error}); }
  console.log(`Removed app-owned files. Unknown files remain in ${destination}. Complete recovery app: ${previous}. Protected recovery backup: ${context.backupRoot}.`);
}

if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>undefined)===await realpath(fileURLToPath(import.meta.url))){const immutable=process.argv[2]==='--immutable-runtime',uninstall=process.argv[2]==='--uninstall-only';const[built,destination,readiness,port,isolatedRoot]=process.argv.slice(immutable||uninstall?3:2);await (uninstall?uninstallApp:immutable?installImmutableRuntime:installBuiltApp)(built,destination,readiness,port,execute,isolatedRoot);}
