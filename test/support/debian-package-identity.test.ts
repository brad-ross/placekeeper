import { expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readDebianPackageIdentity, requireDebianCandidateIdentity } from './debian-package-identity.js';
const candidate='a'.repeat(64),stale='b'.repeat(64),artifact=resolve('exact-candidate.deb');
it('reads the supplied deb identity through dpkg-deb into a disposable extraction root',async()=>{
 let temporary='';
 const identity=await readDebianPackageIdentity(artifact,async(command,args)=>{
  expect(command).toBe('dpkg-deb');expect(args.slice(0,2)).toEqual(['--extract',artifact]);
  temporary=args[2]!;expect(isAbsolute(temporary)).toBe(true);
  const path=join(temporary,'usr/lib/placekeeper/payload/identity');await mkdir(dirname(path),{recursive:true});await writeFile(path,`${candidate}\n`);
 });
 expect(identity).toBe(candidate);await expect(readFile(join(temporary,'usr/lib/placekeeper/payload/identity'))).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['available marker','materialized runtime manifest','selected per-user runtime'])('rejects stale %s instead of qualifying new package bytes',source=>{
 expect(()=>requireDebianCandidateIdentity(candidate,stale,source)).toThrow(/supplied Debian package/);
 expect(()=>requireDebianCandidateIdentity(candidate,candidate,source)).not.toThrow();
});
it('rejects malformed embedded identity and cleans extraction state',async()=>{
 let temporary='';
 await expect(readDebianPackageIdentity(artifact,async(_command,args)=>{
  temporary=args[2]!;const path=join(temporary,'usr/lib/placekeeper/payload/identity');await mkdir(dirname(path),{recursive:true});await writeFile(path,'not-a-candidate\n');
 })).rejects.toThrow(/identity/);
 await expect(readFile(join(temporary,'usr/lib/placekeeper/payload/identity'))).rejects.toMatchObject({code:'ENOENT'});
});
