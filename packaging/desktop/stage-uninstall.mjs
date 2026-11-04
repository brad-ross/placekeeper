import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeRoot } from './install-built-app.mjs';
import { resolveLauncherRuntime } from './launcher.mjs';

if (process.argv[1] && await realpath(process.argv[1]).catch(()=>undefined)===await realpath(fileURLToPath(import.meta.url))) {
const args=process.argv.slice(2);
if (args[0]==='--staged') {
  const [,candidate,destination,parent]=args;
  const pid=Number(parent);
  if (!Number.isSafeInteger(pid)||pid<=0) throw Error('Invalid uninstall staging process');
  const deadline=Date.now()+10_000;
  while(true) {
    try { process.kill(pid,0); } catch(error) { if(error.code==='ESRCH')break;throw error; }
    if(Date.now()>=deadline) throw Error('Uninstall staging process is still running; current installation was preserved');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const { launchInstaller }=await import('./installer-entry.mjs');
  try { process.exitCode=await launchInstaller(candidate,['--placekeeper-uninstall-target',destination]); }
  finally { await rm(resolve(candidate,'..'),{recursive:true,force:true}).catch(error=>console.error(`Temporary uninstall runtime remains at ${resolve(candidate,'..')}; remove it after all uninstall processes exit. ${String(error)}`)); }
} else {
  const destination=args[0];
  const temporary=await mkdtemp(join(tmpdir(),'placekeeper-uninstall-'));
  const candidate=join(temporary,'candidate');
  try {
    await cp(destination,candidate,{recursive:true,verbatimSymlinks:true});
    const runtime=await resolveLauncherRuntime(runtimeRoot(candidate));
    const child=spawn(runtime.node,[join(runtimeRoot(candidate),'installer/stage-uninstall.mjs'),'--staged',candidate,destination,String(process.pid)],{stdio:'ignore',detached:true,env:runtime.environment,shell:false});
    await new Promise((accept,reject)=>{child.once('spawn',accept);child.once('error',reject);});child.unref();
  } catch(error) { await rm(temporary,{recursive:true,force:true});throw error; }
}

}
