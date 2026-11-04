import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { desktopExecutable, resolveLauncherRuntime } from './launcher.mjs';
import { assertSafeInstallDestinationOnDisk, resolveInstallLayout } from './install-layout.ts';
import { activateInstallation } from './install-transaction.mjs';
const execute = promisify(execFile);
export function runtimeRoot(app, platform = process.platform) { return join(app, platform === 'darwin' ? 'Contents/Resources/desktop' : 'resources/desktop'); }
async function verifyLease(context) {
  if (!isAbsolute(context.lockPath ?? '') || !/^[A-Za-z0-9_-]{32}$/u.test(context.lockToken ?? '')) throw new Error('App replacement requires the coordinator lifecycle lease');
  const record = JSON.parse(await readFile(join(context.lockPath, `owner-${context.lockToken}.json`), 'utf8'));
  if (record.version !== 1 || record.token !== context.lockToken || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('Invalid coordinator lifecycle lease');
  process.kill(record.pid, 0);
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
  const run=(executable,args,env={...process.env,...leaseEnvironment})=>invoke(executable,args,{env,timeout:30_000,maxBuffer:65_536});
  return activateInstallation({ built,destination,transactionRoot,previousLocation,backupRoot:context.backupRoot,candidateIdentity:candidate.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY,
    validate:async staged=>{await verifyLease(context);await assertSafeInstallDestinationOnDisk(destination,guardOptions);const runtime=await resolveLauncherRuntime(runtimeRoot(staged));if(runtime.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY!==candidate.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY)throw Error('Staged candidate changed');},
    ready:async (record,persist)=>{
      await verifyLease(context);
      record.serviceLaunchRequested=true;await persist();
      await run(readiness,['daemon','ensure-ready','--receipt',record.receipt,...isolation]);
      const fixture=join(dirname(record.shellReceipt),'Startup check.pdf');await writeFile(fixture,fixturePdf(),{flag:'wx'});
      const request={version:1,attempt:record.attempt,candidateIdentity:record.candidateIdentity,receipt:record.shellReceipt,profile:join(dirname(record.shellReceipt),'electron-profile'),fixture:await realpath(fixture)};
      const installed=await resolveLauncherRuntime(runtimeRoot(destination));
      record.shellLaunchRequested=true;await persist();
      await run(desktopExecutable(runtimeRoot(destination)),isolation,{...installed.environment,...leaseEnvironment,PLACEKEEPER_STARTUP_REQUEST:JSON.stringify(request)});
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
      await run(readiness,['daemon','stop-ready','--receipt',record.receipt,...isolation]);},
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const[built,destination,readiness,port,isolatedRoot]=process.argv.slice(2);await installBuiltApp(built,destination,readiness,port,execute,isolatedRoot);}
