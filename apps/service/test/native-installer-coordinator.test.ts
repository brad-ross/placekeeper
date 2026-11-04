import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { runDaemonCommand } from '../src/cli/daemon-command.js';
import { runtimeRoot } from '../../../packaging/desktop/install-built-app.mjs';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
it('coordinates a fresh installation with no control socket through verified backup and an external replacement helper',async()=>{
  const root=await mkdtemp(process.platform==='darwin'?'/tmp/pk-fresh-':join(tmpdir(),'pk-fresh-'));
  const keys=['PLACEKEEPER_DAEMON_IDENTITY','PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY'] as const;
  const previous=keys.map(key=>process.env[key]);
  try {
    const candidate=join(root,'candidate.app'),resources=runtimeRoot(candidate);
    for(const directory of ['node/bin','service','web'])await mkdir(join(resources,directory),{recursive:true});
    const node=`node/bin/node${process.platform==='win32'?'.exe':''}`;
    await writeFile(join(resources,node),'fixture node');await writeFile(join(resources,'service/main.js'),'fixture service');await writeFile(join(resources,'web/pdfium.wasm'),'fixture wasm');
    await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({schemaVersion:1,target:{platform:process.platform,arch:process.arch},daemonIdentity:'a'.repeat(64),installArtifactIdentity:'b'.repeat(64),node:{path:node,sha256:hash('fixture node'),version:'24.0.0'},service:{path:'service/main.js',sha256:hash('fixture service'),version:'0.3.0'},webAssets:{path:'web',files:[{path:'pdfium.wasm',sha256:hash('fixture wasm')}]},recovery:{readableDraftSchemaVersions:[1,2,3],writtenDraftSchemaVersion:3}}));
    process.env.PLACEKEEPER_DAEMON_IDENTITY='a'.repeat(64);process.env.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY='b'.repeat(64);
    const marker=join(root,'replacement.json');
    const helper=join(root,'replacement.mjs');
    await writeFile(helper,`import {lstat,readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';const lock=JSON.parse(await readFile(join(process.env.PLACEKEEPER_LIFECYCLE_LOCK_PATH,'owner-'+process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN+'.json'),'utf8'));process.kill(lock.pid,0);if(!(await lstat(process.env.PLACEKEEPER_INSTALL_BACKUP_ROOT)).isDirectory())throw Error('Missing verified backup');await writeFile(${JSON.stringify(marker)},JSON.stringify({args:process.argv.slice(2),backup:process.env.PLACEKEEPER_INSTALL_BACKUP_ROOT,coordinator:lock.pid}));`);
    let output='';
    const args=['coordinate-install','--candidate-app',candidate,'--installed-app',join(root,'installed.app'),'--replace-helper',helper,'--native-installer-consent','--isolated-installed-smoke','--http-port','63828','--isolated-test-root',join(root,'state')];
    expect(await runDaemonCommand(args,text=>{output+=text;})).toBe(0);
    expect(JSON.parse(output)).toEqual({ok:true,status:'installed'});
    const replaced=JSON.parse(await readFile(marker,'utf8'));expect(replaced.coordinator).toBe(process.pid);expect(replaced.args[0]).toBe(candidate);
    expect(await readdir(replaced.backup)).toEqual([]);
    await unlink(marker);await writeFile(join(resources,'service/main.js'),'changed candidate');
    let failed='';expect(await runDaemonCommand(args,text=>{failed+=text;})).toBe(2);
    const failure=JSON.parse(failed);expect(failure.error.message).toContain('Packaged runtime digest mismatch');expect(failure.error.recoveryAction).toContain('retained app versions');
    await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});
  } finally {for(const [index,key] of keys.entries()){if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}await rm(root,{recursive:true,force:true});}
});

it('forwards real replacement-helper retained-resource notices through the coordinator to installer completion',async()=>{
  const { EventEmitter }=await import('node:events');const { PassThrough }=await import('node:stream');
  const { vi }=await import('vitest');
  const { runInstaller }=await import('../../../packaging/desktop/installer-entry.mjs');
  const root=await mkdtemp(process.platform==='darwin'?'/tmp/pk-notice-':join(tmpdir(),'pk-notice-'));
  const keys=['PLACEKEEPER_DAEMON_IDENTITY','PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY'] as const;
  const previous=keys.map(key=>process.env[key]);
  try{
    const candidate=join(root,'candidate.app'),resources=runtimeRoot(candidate),destination=join(root,'installed.app');
    for(const directory of ['node/bin','service','web','installer'])await mkdir(join(resources,directory),{recursive:true});
    const node=`node/bin/node${process.platform==='win32'?'.exe':''}`;
    await writeFile(join(resources,node),'fixture node');await writeFile(join(resources,'service/main.js'),'fixture service');await writeFile(join(resources,'web/pdfium.wasm'),'fixture wasm');
    await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({schemaVersion:1,target:{platform:process.platform,arch:process.arch},daemonIdentity:'a'.repeat(64),installArtifactIdentity:'b'.repeat(64),node:{path:node,sha256:hash('fixture node'),version:'24.0.0'},service:{path:'service/main.js',sha256:hash('fixture service'),version:'0.3.0'},webAssets:{path:'web',files:[{path:'pdfium.wasm',sha256:hash('fixture wasm')}]},recovery:{readableDraftSchemaVersions:[1,2,3],writtenDraftSchemaVersion:3}}));
    process.env.PLACEKEEPER_DAEMON_IDENTITY='a'.repeat(64);process.env.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY='b'.repeat(64);
    const retained=['modified Placekeeper shortcut','edited Chrome registration'];
    await writeFile(join(resources,'installer/install-built-app.mjs'),`process.stdout.write(JSON.stringify({kind:'placekeeper-uninstall-retained',resources:${JSON.stringify(retained)}})+'\\n');process.stderr.write('retained registration warning\\n');`);
    let forwardedErrors='';
    const invoke=((_command:string,args:string[])=>{
      const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough()});
      child.stderr.on('data',data=>{forwardedErrors+=String(data);});
      queueMicrotask(()=>{void(async()=>{
        const errors=vi.spyOn(process.stderr,'write').mockImplementation(chunk=>{child.stderr.write(chunk);return true;});
        try{
          const code=await runDaemonCommand(args.slice(2),text=>{child.stdout.write(text);});
          child.stdout.end();child.stderr.end();child.emit('close',code,null);
        }catch(error){child.emit('error',error);child.emit('close',2,null);}
        finally{errors.mockRestore();}
      })();});
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    const result=await runInstaller({candidate,destination,uninstall:true,isolatedRoot:join(root,'state'),port:63827},()=>{throw Error('No active reviews need consent');},invoke);
    expect(result.retainedResources).toEqual(retained);
    expect(result.output).toContain('placekeeper-uninstall-retained');expect(forwardedErrors).toContain('retained registration warning');
  }finally{for(const [index,key] of keys.entries()){if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];}await rm(root,{recursive:true,force:true});}
});
