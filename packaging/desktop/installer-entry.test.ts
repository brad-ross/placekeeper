import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { runInstaller } from './installer-entry.mjs';
const roots: string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const hash=(bytes: string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(serviceSource?: string) {
  const root=await mkdtemp(join(tmpdir(),'placekeeper-installer-entry-'));roots.push(root);
  const candidate=join(root,'candidate');
  const resources=join(candidate,process.platform==='darwin'?'Contents/Resources/desktop':'resources/desktop');
  await mkdir(join(resources,'node/bin'),{recursive:true});await mkdir(join(resources,'service'));await mkdir(join(resources,'web'));
  const node=join(resources,'node/bin',process.platform==='win32'?'node.exe':'node');
  if(process.platform==='win32')await copyFile(process.execPath,node);
  else {await writeFile(node,`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`);await chmod(node,0o755);}
  const service=serviceSource??`import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
const args=process.argv.slice(2),destination=args[args.indexOf('--installed-app')+1];
if(!args.includes('--native-installer-consent'))throw Error('Missing consent transport');
const lines=createInterface({input:process.stdin});
process.stdout.write('{"kind":"placekeeper-install-consent","version":1}\\n');
for await(const line of lines){const decision=JSON.parse(line);if(decision.version!==1||decision.accepted!==true){console.error('Declined; incumbent remains available. Recovery backup unchanged.');process.exitCode=2;}else await writeFile(destination,'activated after consent');lines.close();break;}
`;
  await writeFile(join(resources,'service/main.js'),service);await writeFile(join(resources,'service/package.json'),'{"type":"module"}');await writeFile(join(resources,'web/pdfium.wasm'),'pdfium');
  await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({schemaVersion:1,target:{platform:process.platform,arch:process.arch},daemonIdentity:'a'.repeat(64),installArtifactIdentity:'b'.repeat(64),node:{path:`node/bin/node${process.platform==='win32'?'.exe':''}`,sha256:hash(await readFile(node))},service:{path:'service/main.js',sha256:hash(service)},webAssets:{path:'web',files:[{path:'pdfium.wasm',sha256:hash('pdfium')}]}}));
  const destination=join(root,'installed');await writeFile(destination,'incumbent');
  return {candidate,destination,root};
}
it('carries the genuine dialog decision through a real child process before any activation',async()=>{
  const {candidate,destination}=await fixture();
  let asked=false;
  await runInstaller({candidate,destination},async()=>{asked=true;expect(await readFile(destination,'utf8')).toBe('incumbent');return true;});
  expect(asked).toBe(true);expect(await readFile(destination,'utf8')).toBe('activated after consent');
});
it('decline preserves incumbent bytes and detailed recovery guidance',async()=>{
  const {candidate,destination}=await fixture();
  await expect(runInstaller({candidate,destination},async()=>false)).rejects.toThrow('Declined; incumbent remains available. Recovery backup unchanged.');
  expect(await readFile(destination,'utf8')).toBe('incumbent');
});
it('refuses changed candidate runtime bytes before invoking consent or touching target',async()=>{
  const {candidate,destination}=await fixture();
  await writeFile(join(candidate,process.platform==='darwin'?'Contents/Resources/desktop/service/main.js':'resources/desktop/service/main.js'),'changed');
  await expect(runInstaller({candidate,destination},()=>{throw Error('must not ask');})).rejects.toThrow('changed');
  expect(await readFile(destination,'utf8')).toBe('incumbent');
});

it('preserves coordinator stdout diagnostics alongside stderr warnings and exact process exit status',async()=>{
  const {candidate,destination}=await fixture(`process.stderr.write('Warning: inherited color configuration\\n');process.stdout.write(JSON.stringify({ok:false,error:{message:'Pending draft could not be protected',recoveryAction:'Keep the previous app and verified backup; retry after saving'}})+'\\n');process.exitCode=23;`);
  const error=await runInstaller({candidate,destination},()=>true).then(()=>{throw Error('expected coordinator failure');},error=>error);
  expect(error.message).toContain('exit code: 23');expect(error.message).toContain('signal: none');
  expect(error.message).toContain('Warning: inherited color configuration');
  expect(error.message).toContain('Pending draft could not be protected');expect(error.message).toContain('Keep the previous app and verified backup; retry after saving');
  expect(await readFile(destination,'utf8')).toBe('incumbent');
});
it('drains and bounds both diagnostic streams before reporting a failed coordinator',async()=>{
  const {candidate,destination}=await fixture(`process.stderr.write('w'.repeat(80_000)+' stderr tail\\n');process.stdout.write('o'.repeat(80_000)+' stdout recovery tail\\n');process.exitCode=24;`);
  const error=await runInstaller({candidate,destination},()=>true).then(()=>{throw Error('expected coordinator failure');},error=>error);
  expect(error.message.includes('stderr tail')).toBe(true);expect(error.message.includes('stdout recovery tail')).toBe(true);expect(error.message.length).toBeLessThan(132_000);
});
