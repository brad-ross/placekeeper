import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readDebianPackageIdentity, requireDebianCandidateIdentity } from '../support/debian-package-identity.js';
import { MANAGEMENT_PROTOCOL_VERSION, requestControl } from '../../apps/service/src/host/launch-control.js';
const execute=promisify(execFile);
// Requires the exact deb to have been installed by apt/dpkg. An operator is
// present to approve the actual installation/setup dialogs on the native host.
test('exact Debian package activates through its installed ordinary-user dispatcher',async({},testInfo)=>{
 test.setTimeout(300_000);expect(process.platform).toBe('linux');expect(process.getuid?.()).not.toBe(0);
 const artifact=process.env.PLACEKEEPER_NATIVE_INSTALLER_ARTIFACT;expect(artifact).toBeTruthy();
 const sha256=createHash('sha256').update(await readFile(resolve(artifact!))).digest('hex');
 const identity=await readDebianPackageIdentity(resolve(artifact!));
 const available=(await readFile('/opt/placekeeper/available','utf8')).trim();requireDebianCandidateIdentity(identity,available,'Available runtime marker');
 const runtime=join('/opt/placekeeper/runtimes',identity),sandbox=await lstat(join(runtime,'chrome-sandbox'));
 expect(sandbox.uid).toBe(0);expect(sandbox.mode&0o7777).toBe(0o4755);expect(await readFile(join(runtime,'.complete'),'utf8')).toBe(`${identity}\n`);
 const manifest=JSON.parse(await readFile(join(runtime,'resources/desktop/runtime-manifest.json'),'utf8'));requireDebianCandidateIdentity(identity,manifest.installArtifactIdentity,'Materialized runtime manifest');
 const home=await mkdtemp('/tmp/pk-deb-'),state=join(home,'.local/state/placekeeper'),socket=join(state,'control.sock');
 const environment={...process.env,HOME:home,XDG_STATE_HOME:join(home,'.local/state'),XDG_CONFIG_HOME:join(home,'.config'),XDG_DATA_HOME:join(home,'.local/share')};
 for(const key of Object.keys(environment))if(key.startsWith('PLACEKEEPER_'))delete (environment as NodeJS.ProcessEnv)[key];
 try{
  const doctor=JSON.parse((await execute('/usr/bin/placekeeper',['doctor','--json','--offline','--writer','--pdf',resolve('test/fixtures/pdfs/text-native.pdf')],{env:environment,timeout:240_000})).stdout);
  expect(doctor).toMatchObject({ok:true,offline:true});
  const selected=JSON.parse(await readFile(join(state,'installer/selected-runtime.json'),'utf8'));requireDebianCandidateIdentity(identity,selected.installArtifactIdentity,'Selected per-user runtime');expect(selected.resources).toBe(join(runtime,'resources/desktop'));
  if(process.env.GITHUB_ENV)await appendFile(process.env.GITHUB_ENV,`PLACEKEEPER_TEST_EXECUTABLE=${join(runtime,'PlacekeeperDesktop')}\n`);
  await writeFile(join(home,'debian-native-evidence.json'),JSON.stringify({schemaVersion:1,artifact:resolve(artifact!),sha256,identity,available,materializedIdentity:manifest.installArtifactIdentity,selected,doctor,scope:'Exact installed Debian package, sandbox ownership and per-user dispatcher activation only; removal/purge, multiple users, OS approval, full lifecycle and real hosts remain separate.'},null,2));
  await testInfo.attach('debian-native-evidence',{path:join(home,'debian-native-evidence.json'),contentType:'application/json'});
  console.log(`Debian native evidence: ${join(home,'debian-native-evidence.json')}`);
 }finally{
  if(await lstat(socket).then(()=>true,()=>false)){
   const result=await requestControl(socket,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'shutdown-if-idle'});expect(result).toMatchObject({result:{status:'accepted'}});
   await expect.poll(()=>lstat(socket).then(()=>false,()=>true),{timeout:10_000}).toBe(true);
  }
 }
});
