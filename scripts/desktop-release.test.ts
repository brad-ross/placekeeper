import { expect,it } from 'vitest';
import { completeInventory, verifyReleaseFiles, validateStagedDirectory } from './desktop-release.js';
import { desktopAssetNames } from '../packages/core/src/desktop-release.js';
const files=()=>Object.fromEntries([...Object.values(desktopAssetNames('0.3.0')),'placekeeper-source-v0.3.0.tar.gz','install-placekeeper.sh'].map(name=>[name,Buffer.from(name)]));
it('retains all four installers and both source assets with checksums and qualification',()=>expect(completeInventory('0.3.0')).toHaveLength(8));
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
 for(const [target,name]of Object.entries(desktopAssetNames('0.3.0'))){const dir=join(input,target);await mkdir(dir);await writeFile(join(dir,name),name);await writeFile(join(dir,'build-result.json'),JSON.stringify({target,name,sha256:sha256(Buffer.from(name)),version:'0.3.0',commit,candidateRun:'123',nativeQualificationRun:'123',status:'built'}));}
 await expect(assembleCandidate(input,join(root,'not-qualified'),'0.3.0',commit,'123')).rejects.toThrow(/provenance/);
 for(const target of Object.keys(desktopAssetNames('0.3.0'))){const file=join(input,target,'build-result.json');const record=JSON.parse(await readFile(file,'utf8'));record.status='passed';await writeFile(file,JSON.stringify(record));}
 const result=await assembleCandidate(input,join(root,'assembled'),'0.3.0',commit,'123');expect(result.assets).toHaveLength(4);expect(result.sources).toHaveLength(2);expect(result.assets.every(asset=>asset.evidence.length===0)).toBe(true);
 await expect(validateStagedDirectory(join(root,'assembled'),result)).rejects.toThrow(/evidence/);
 const approved=structuredClone(result);
 for(const asset of approved.assets)for(const scenario of requiredScenarios(asset.target))asset.evidence.push({scenario,status:'passed',category:['downloaded-os-approval','legacy-0.2.4-migration'].includes(scenario)?'interactive':scenario==='real-host-integrations'?'real-host':'automated',reference:'https://github.com/brad-ross/placekeeper/issues/1',sha256:asset.sha256,commit,candidateRun:'123'});
 await expect(validateStagedDirectory(join(root,'assembled'),approved)).resolves.toMatchObject({assets:result.assets.map(({evidence,...asset})=>asset)});
 const bytes:Record<string,Buffer>={};for(const name of Object.keys(files()))bytes[name]=await readFile(join(root,'assembled',name));
 bytes['install-placekeeper.sh']=Buffer.from('changed source bootstrap');await writeFile(join(root,'assembled/install-placekeeper.sh'),bytes['install-placekeeper.sh']);await writeFile(join(root,'assembled/SHA256SUMS'),verifyReleaseFiles(bytes,'0.3.0').checksums);
 await expect(validateStagedDirectory(join(root,'assembled'),approved)).rejects.toThrow(/Source payload hash/);

 await writeFile(join(archived,'release-descriptor.txt'),releaseIdentity('0.3.0','c'.repeat(40)).descriptor);execFileSync('tar',['-czf',join(source,'placekeeper-source-v0.3.0.tar.gz'),'-C',root,'placekeeper-source']);
 await expect(assembleCandidate(input,join(root,'wrong-source'),'0.3.0',commit,'123')).rejects.toThrow(/provenance/);
 }finally{await rm(root,{recursive:true,force:true});}
});

import { assertCandidateBinding } from './desktop-release.js';
import { qualificationTemplate, requiredScenarios } from './validate-desktop-qualification.js';
it('binds reviewed source and bootstrap to immutable candidate-run provenance, even if current draft metadata changes',()=>{
 const result=verifyReleaseFiles(files(),'0.3.0');const original=qualificationTemplate('0.3.0','a'.repeat(40),'123',result.assets,result.sources);
 for(const name of ['placekeeper-source-v0.3.0.tar.gz','install-placekeeper.sh']){
  const changed=structuredClone(original);changed.sources.find(source=>source.name===name)!.sha256='c'.repeat(64);expect(()=>assertCandidateBinding(changed,original)).toThrow(/different candidate/);
 }
 expect(()=>assertCandidateBinding(structuredClone(original),original)).not.toThrow();
});
