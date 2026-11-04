import { expect,it } from 'vitest';
import { completeInventory, verifyReleaseFiles, validateStagedDirectory } from './desktop-release.js';
import { desktopAssetNames } from '../packages/core/src/desktop-release.js';
const files=()=>Object.fromEntries([...Object.values(desktopAssetNames('0.3.0')),'placekeeper-source-v0.3.0.tar.gz','install-placekeeper.sh'].map(name=>[name,Buffer.from(name)]));
it('retains all four installers and both source assets with checksums and build provenance',()=>{expect(completeInventory('0.3.0')).toHaveLength(8);expect(completeInventory('0.3.0')).toContain('desktop-build-provenance.json');expect(completeInventory('0.3.0')).not.toContain('desktop-qualification.json');});
it('rejects missing source or installer bytes and unexpected assets',()=>{const input=files();delete input['install-placekeeper.sh'];expect(()=>verifyReleaseFiles(input,'0.3.0')).toThrow();input['install-placekeeper.sh']=Buffer.from('source');input['extra.exe']=Buffer.from('extra');expect(()=>verifyReleaseFiles(input,'0.3.0')).toThrow();});
it('hashes the exact bytes deterministically',()=>{const result=verifyReleaseFiles(files(),'0.3.0');expect(result.assets).toHaveLength(4);expect(result.checksums.split('\n').filter(Boolean)).toHaveLength(6);expect(verifyReleaseFiles(files(),'0.3.0')).toEqual(result);});

import { execFileSync } from 'node:child_process';
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
