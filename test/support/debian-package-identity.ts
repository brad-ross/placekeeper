import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
const execute=promisify(execFile);
type Extract=(command:string,args:string[])=>Promise<unknown>;
/** Package metadata, rather than a possibly stale host marker, names the
 * candidate this native qualification is permitted to approve. */
export async function readDebianPackageIdentity(artifact:string,extract:Extract=execute):Promise<string>{
 const temporary=await mkdtemp(join(tmpdir(),'pk-deb-payload-'));
 try{
  await extract('dpkg-deb',['--extract',resolve(artifact),temporary]);
  const identity=(await readFile(join(temporary,'usr/lib/placekeeper/payload/identity'),'utf8')).trim();
  if(!/^[a-f0-9]{64}$/u.test(identity))throw Error('Invalid supplied Debian package identity');
  return identity;
 }finally{await rm(temporary,{recursive:true,force:true});}
}
export function requireDebianCandidateIdentity(candidate:string,observed:unknown,source:string):void{
 if(!/^[a-f0-9]{64}$/u.test(candidate)||observed!==candidate)throw Error(`${source} does not match the supplied Debian package identity`);
}
