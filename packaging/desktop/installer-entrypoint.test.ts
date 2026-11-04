import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
const execute=promisify(execFile);
const here=dirname(fileURLToPath(import.meta.url));
it.skipIf(process.platform==='win32')('executes the actual activation helper through an aliased parent and refuses invalid installation inputs',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pk-helper-entry-'));
  try {
    const alias=join(root,'aliased-desktop');await symlink(here,alias,'dir');
    const result=await execute(process.execPath,[join(alias,'install-built-app.mjs'),'relative-candidate','relative-destination','relative-readiness']).then(()=>undefined,error=>error);
    expect(result,'the activation helper must execute and reject invalid inputs instead of silently exiting zero').toBeDefined();
    expect(result.code).not.toBe(0);expect(result.stderr).toContain('Expected distinct absolute app paths');
  } finally {await rm(root,{recursive:true,force:true});}
});
it('importing the activation and bootstrap modules remains inert',async()=>{
  const source=`await import(${JSON.stringify(pathToFileURL(join(here,'install-built-app.mjs')).href)});await import(${JSON.stringify(pathToFileURL(join(here,'installer-entry.mjs')).href)});await import(${JSON.stringify(pathToFileURL(join(here,'linux-dispatcher.mjs')).href)});await import(${JSON.stringify(pathToFileURL(join(here,'stage-uninstall.mjs')).href)});process.stdout.write('imports remained inert');`;
  const result=await execute(process.execPath,['--input-type=module','--eval',source]);
  expect(result.stdout).toBe('imports remained inert');expect(result.stderr).toBe('');
});
