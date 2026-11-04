import { establishPrivateDirectory } from "../src/platform/private-storage.js";
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ inspect:vi.fn(), request:vi.fn() }));
vi.mock('../src/host/launch-control.js', async original => ({ ...await original<typeof import('../src/host/launch-control.js')>(), inspectDaemonCompatibility:mocks.inspect, requestControl:mocks.request }));
import { acquireLifecycleLock } from '../src/host/lifecycle-lock.js';
import { electronAppControlThroughDaemon, electronRuntimeThroughDaemon } from '../src/host/service-daemon.js';
const registration = {protocolVersion:1 as const,type:'register-app' as const,appInstanceId:'app_probe_1234',processId:process.pid,startIdentity:'start_probe_1234',buildIdentity:'build_probe_1234'};
async function fixture() {
 const root = await mkdtemp(join(tmpdir(),'pk-probe-lease-'));
 await establishPrivateDirectory(root);
 const paths = {appSupportRoot:root,recoveryRoot:join(root,'recovery'),socketPath:join(root,'control.sock'),lifecycleLockPath:join(root,'lease'),webAssetsRoot:join(root,'web')};
 const owner = await acquireLifecycleLock(paths.lifecycleLockPath);
 return {root,paths,owner};
}
beforeEach(()=>{
 vi.clearAllMocks();
 mocks.inspect.mockResolvedValue({kind:'exact',status:{lifecycle:'accepting'}});
 mocks.request.mockImplementation(async (_path,request)=>request.kind==='electron-app-control'?{kind:'electron-app-control',response:{protocolVersion:1,type:'ack',appInstanceId:'app_probe_1234'}}:{kind:'electron-runtime',response:{protocolVersion:1,windowId:'window_probe_1234',attemptId:'attempt_probe_1234',requestId:'request_probe_1234',type:'failure',code:'invalid'}});
});
it('completes startup registration and document admission while the actual installer owner lease remains held',async()=>{
 const {root,paths,owner}=await fixture();
 try{
 await expect(electronAppControlThroughDaemon(registration,undefined,paths,owner.token)).resolves.toMatchObject({type:'ack'});
 await expect(electronRuntimeThroughDaemon('app_probe_1234','helper_probe_1234',{protocolVersion:1,type:'admit',windowId:'window_probe_1234',attemptId:'attempt_probe_1234',requestId:'request_probe_1234',sourcePath:join(root,'fixture.pdf')},undefined,paths,owner.token)).resolves.toMatchObject({type:'failure',code:'invalid'});
 const entries=await readdir(paths.lifecycleLockPath);
 expect(entries).toEqual([`owner-${owner.token}.json`]);
 expect(JSON.parse(await readFile(join(paths.lifecycleLockPath,entries[0]!),'utf8'))).toMatchObject({pid:process.pid,token:owner.token});
 expect(mocks.request).toHaveBeenCalledTimes(2);
 }finally{await owner.release();await rm(root,{recursive:true,force:true});}
});
it('refuses an invalid probe token without contacting the service or disturbing the actual owner',async()=>{
 const {root,paths,owner}=await fixture();
 try{
 await expect(electronAppControlThroughDaemon(registration,undefined,paths,'x'.repeat(32))).rejects.toMatchObject({reason:'transient-busy'});
 expect(mocks.request).not.toHaveBeenCalled();expect(await readdir(paths.lifecycleLockPath)).toEqual([`owner-${owner.token}.json`]);
 }finally{await owner.release();await rm(root,{recursive:true,force:true});}
},10_000);
it('blocks ordinary registration despite an inherited environment token while the owner still holds the lease',async()=>{
 const {root,paths,owner}=await fixture();const saved=process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN;process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN=owner.token;
 try{
 await expect(electronAppControlThroughDaemon(registration,undefined,paths)).rejects.toMatchObject({reason:'transient-busy'});
 expect(mocks.request).not.toHaveBeenCalled();expect(await readdir(paths.lifecycleLockPath)).toEqual([`owner-${owner.token}.json`]);
 }finally{if(saved===undefined)delete process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN;else process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN=saved;await owner.release();await rm(root,{recursive:true,force:true});}
},10_000);
