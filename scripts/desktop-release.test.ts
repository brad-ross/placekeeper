import { expect,it } from 'vitest';
import { completeInventory, verifyReleaseFiles, validateStagedDirectory } from './desktop-release.js';
import { desktopAssetNames } from '../packages/core/src/desktop-release.js';
const files=()=>Object.fromEntries([...Object.values(desktopAssetNames('0.3.0')),'placekeeper-source-v0.3.0.tar.gz','install-placekeeper.sh'].map(name=>[name,Buffer.from(name)]));
it('retains all four installers and both source assets with checksums and build provenance',()=>{expect(completeInventory('0.3.0')).toHaveLength(8);expect(completeInventory('0.3.0')).toContain('desktop-build-provenance.json');expect(completeInventory('0.3.0')).not.toContain('desktop-qualification.json');});
it('rejects missing source or installer bytes and unexpected assets',()=>{const input=files();delete input['install-placekeeper.sh'];expect(()=>verifyReleaseFiles(input,'0.3.0')).toThrow();input['install-placekeeper.sh']=Buffer.from('source');input['extra.exe']=Buffer.from('extra');expect(()=>verifyReleaseFiles(input,'0.3.0')).toThrow();});
it('hashes the exact bytes deterministically',()=>{const result=verifyReleaseFiles(files(),'0.3.0');expect(result.assets).toHaveLength(4);expect(result.checksums.split('\n').filter(Boolean)).toHaveLength(6);expect(verifyReleaseFiles(files(),'0.3.0')).toEqual(result);});

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assembleCandidate, sha256 } from './desktop-release.js';
import { releaseIdentity } from './package-source-release.js';
it('assembles only successful native results from the same commit/run and authentic source descriptor',async()=>{
 const root=await mkdtemp('/tmp/pk-release-'),input=join(root,'input'),source=join(input,'source'),commit='a'.repeat(40);
 await mkdir(source,{recursive:true});const archived=join(root,'placekeeper-source');await mkdir(archived);await writeFile(join(archived,'release-descriptor.txt'),releaseIdentity('0.3.0',commit).descriptor);
 execFileSync('tar',['-czf',join(source,'placekeeper-source-v0.3.0.tar.gz'),'-C',root,'placekeeper-source']);await writeFile(join(source,'install-placekeeper.sh'),'source bootstrap');
 try{
 for(const [target,name]of Object.entries(desktopAssetNames('0.3.0'))){const dir=join(input,target);await mkdir(dir);await writeFile(join(dir,name),name);await writeFile(join(dir,'build-result.json'),JSON.stringify({target,name,sha256:sha256(Buffer.from(name)),version:'0.3.0',commit,candidateRun:'123',status:'failed'}));}
 await expect(assembleCandidate(input,join(root,'failed-build'),'0.3.0',commit,'123')).rejects.toThrow(/provenance/);
 for(const target of Object.keys(desktopAssetNames('0.3.0'))){const file=join(input,target,'build-result.json');const record=JSON.parse(await readFile(file,'utf8'));record.status='passed';await writeFile(file,JSON.stringify(record));}
 const recordPath=join(input,'darwin-arm64','build-result.json'),record=JSON.parse(await readFile(recordPath,'utf8'));
 for(const [field,value]of Object.entries({version:'0.3.1',commit:'b'.repeat(40),candidateRun:'122',target:'darwin-x64',name:'wrong.dmg',sha256:'c'.repeat(64),status:'built'})){
  await writeFile(recordPath,JSON.stringify({...record,[field]:value}));
  await expect(assembleCandidate(input,join(root,`stale-${field}`),'0.3.0',commit,'123')).rejects.toThrow(/provenance/);
 }
 await writeFile(recordPath,JSON.stringify(record));
 const result=await assembleCandidate(input,join(root,'assembled'),'0.3.0',commit,'123');expect(result.assets).toHaveLength(4);expect(result.sources).toHaveLength(2);expect(result.assets.every(asset=>!('evidence' in asset))).toBe(true);
 await expect(validateStagedDirectory(join(root,'assembled'),result)).resolves.toMatchObject({assets:result.assets});
 const approved=structuredClone(result);
 const bytes:Record<string,Buffer>={};for(const name of Object.keys(files()))bytes[name]=await readFile(join(root,'assembled',name));
 bytes['install-placekeeper.sh']=Buffer.from('changed source bootstrap');await writeFile(join(root,'assembled/install-placekeeper.sh'),bytes['install-placekeeper.sh']);await writeFile(join(root,'assembled/SHA256SUMS'),verifyReleaseFiles(bytes,'0.3.0').checksums);
 await expect(validateStagedDirectory(join(root,'assembled'),approved)).rejects.toThrow(/different candidate/);

 await writeFile(join(archived,'release-descriptor.txt'),releaseIdentity('0.3.0','c'.repeat(40)).descriptor);execFileSync('tar',['-czf',join(source,'placekeeper-source-v0.3.0.tar.gz'),'-C',root,'placekeeper-source']);
 await expect(assembleCandidate(input,join(root,'wrong-source'),'0.3.0',commit,'123')).rejects.toThrow(/provenance/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import { assertCandidateBinding } from './desktop-release.js';
import { buildProvenance } from './desktop-release.js';
it('binds source and bootstrap to immutable candidate-run provenance, even if current draft metadata changes',()=>{
 const result=verifyReleaseFiles(files(),'0.3.0');const original=buildProvenance('0.3.0','a'.repeat(40),'123',result.assets,result.sources);
 for(const name of ['placekeeper-source-v0.3.0.tar.gz','install-placekeeper.sh']){
  const changed=structuredClone(original);changed.sources.find(source=>source.name===name)!.sha256='c'.repeat(64);expect(()=>assertCandidateBinding(changed,original)).toThrow(/different candidate/);
 }
 expect(()=>assertCandidateBinding(structuredClone(original),original)).not.toThrow();
});

it('stages an authenticated draft by release ID and checks its remote bytes', async () => {
 const root=await mkdtemp('/tmp/pk-draft-'),directory=join(root,'candidate'),bin=join(root,'bin'),commit='a'.repeat(40);
 try {
  await mkdir(directory);await mkdir(bin);
  const source=join(root,'placekeeper-source');await mkdir(source);
  await writeFile(join(source,'release-descriptor.txt'),releaseIdentity('0.3.0',commit).descriptor);
  const payloads=files();
  execFileSync('tar',['-czf',join(directory,'placekeeper-source-v0.3.0.tar.gz'),'-C',root,'placekeeper-source']);
  payloads['placekeeper-source-v0.3.0.tar.gz']=await readFile(join(directory,'placekeeper-source-v0.3.0.tar.gz'));
  for(const [name,bytes]of Object.entries(payloads))await writeFile(join(directory,name),bytes);
  const inventory=verifyReleaseFiles(payloads,'0.3.0');
  await writeFile(join(directory,'SHA256SUMS'),inventory.checksums);
  await writeFile(join(directory,'desktop-build-provenance.json'),JSON.stringify(buildProvenance('0.3.0',commit,'123',inventory.assets,inventory.sources)));
  const assets=completeInventory('0.3.0').map((name,id)=>({id:id+1,name,size:1}));
  const draft={id:42,draft:true,prerelease:false,tag_name:'v0.3.0',target_commitish:commit,assets};
  await writeFile(join(root,'release.json'),JSON.stringify(draft));
  await writeFile(join(bin,'gh'),`#!${process.execPath}\n`+String.raw`
const {readFileSync,appendFileSync}=require('node:fs');
const args=process.argv.slice(2),root=process.env.PK_DRAFT_TEST_ROOT;
appendFileSync(root+'/calls.jsonl',JSON.stringify(args)+'\n');
if(args[0]==='api'){
 const endpoint=args[1];
 if(endpoint.includes('/git/ref/')){process.stderr.write('HTTP 404');process.exit(1);}
 if(endpoint.includes('/releases/tags/')){process.stderr.write('HTTP 404: draft unavailable by tag');process.exit(1);}
 if(endpoint.includes('/releases/assets/')){
  const id=Number(endpoint.split('/').pop());
  const draft=JSON.parse(readFileSync(root+'/release.json'));
  if(process.env.PK_DRAFT_TEST_TAMPER==='1'&&id===1){process.stdout.write('changed remote bytes');process.exit(0);}
  process.stdout.write(readFileSync(root+'/candidate/'+draft.assets.find(asset=>asset.id===id).name));
 }else if(endpoint.endsWith('/releases/42'))process.stdout.write(readFileSync(root+'/release.json'));
 else process.exit(2);
}else if(args[0]==='release'&&args[1]==='view')process.stdout.write(JSON.stringify({databaseId:42}));
else if(args[0]!=='release'||!['create','upload'].includes(args[1]))process.exit(2);
`,{mode:0o755});
  const result=spawnSync(process.execPath,['--import','tsx','scripts/desktop-release.ts','stage','0.3.0',commit,'123',directory],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PK_DRAFT_TEST_ROOT:root}});
  expect(result.stderr).not.toContain('draft unavailable by tag');
  expect(result.status,result.stderr).toBe(0);
  const calls=(await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line) as string[]);
  expect(calls.filter(args=>args[0]==='api'&&args[1]!.includes('/releases/assets/'))).toHaveLength(8);
  const publication=spawnSync(process.execPath,['--import','tsx','scripts/desktop-release.ts','publish','0.3.0',commit,'123',directory,directory],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,PK_DRAFT_TEST_ROOT:root,PK_DRAFT_TEST_TAMPER:'1',RELEASE_NOTES:'Release notes'}});
  expect(publication.status).not.toBe(0);
  expect(publication.stderr).toContain('Changed remote payload');
  expect(publication.stderr).not.toContain('draft unavailable by tag');
 }finally{await rm(root,{recursive:true,force:true});}
});
