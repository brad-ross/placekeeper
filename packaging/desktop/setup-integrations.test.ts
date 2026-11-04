import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error portable bundled helper
import { setupIntegrations } from './setup-integrations.mjs';
it('skips independently by default and persists only explicit choices', async () => {
 const root = await mkdtemp(join(tmpdir(), 'pk-setup-'));
 const statePath = join(root, 'choices.json'); const calls: string[][] = [];
 const run = async (_: string, args: string[]) => { calls.push(args); return { stdout: JSON.stringify({ok:true,status:'registered'}) }; };
 await mkdir(join(root, 'resources/desktop'), {recursive:true});
 await writeFile(join(root, 'resources/desktop/runtime-manifest.json'), JSON.stringify({installArtifactIdentity:'a'.repeat(64)}));
 const first = await setupIntegrations({appPath:root,platform:"linux",statePath,home:root,run});
 expect(first.outcomes.map((o: {status:string})=>o.status)).toEqual(['skipped','skipped','skipped']); expect(calls).toEqual([]);
 const second = await setupIntegrations({appPath:root,platform:"linux",statePath,home:root,choices:{chrome:'setup'},run});
 expect(second.outcomes[0]).toMatchObject({host:'chrome',status:'pending'});
 expect(second.outcomes[0].message).toMatch(/Chrome.*reload|reload.*Chrome/s);
 expect(JSON.parse(await readFile(statePath,'utf8')).choices).toEqual({chrome:true,vscode:false,codex:false});
});
it('refreshes changed equal-version VSIX bytes once through the host installer', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-vsix-')); const resources=join(root,'resources');
 await mkdir(join(resources,'integrations'),{recursive:true});
 await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({installArtifactIdentity:'a'.repeat(64)}));
 await writeFile(join(resources,'integrations/placekeeper.vsix'),'payload one');
 const cli=join(root,'code');await writeFile(cli,'fixture');
 const calls: string[][]=[];
 const run=async (_:string,args:string[])=>{calls.push(args);return {stdout:JSON.stringify({ok:true,status:'registered',registration:'current'})};};
 const options={resources,statePath:join(root,'state/choices.json'),home:root,platform:'linux',codePath:cli,choices:{vscode:'setup'},run};
 await setupIntegrations(options);await setupIntegrations(options);
 expect(calls.filter(args=>args[0]==='--install-extension')).toHaveLength(1);
 await writeFile(join(resources,'integrations/placekeeper.vsix'),'payload two');
 await setupIntegrations(options);
 expect(calls.filter(args=>args[0]==='--install-extension')).toHaveLength(2);
 expect(calls.filter(args=>args[0]==='--install-extension').every(args=>args.includes('--force'))).toBe(true);
});
it('executes the installed setup entrypoint through a filesystem alias', async () => {
 const {cp,symlink}=await import('node:fs/promises');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const root=await mkdtemp(join(tmpdir(),'pk-alias-'));
 const appPath=join(root,'Placekeeper.app');
 const resources=join(appPath,process.platform==='darwin'?'Contents/Resources/desktop':'resources/desktop');
 const installer=join(resources,'installer');await mkdir(installer,{recursive:true});
 for(const file of ['setup-integrations.mjs','launcher.mjs','install-layout.ts']) await cp(join(process.cwd(),'packaging/desktop',file),join(installer,file));
 await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({installArtifactIdentity:'a'.repeat(64)}));
 const alias=join(root,'setup-alias.mjs');await symlink(join(installer,'setup-integrations.mjs'),alias);
 const {stdout}=await promisify(execFile)(process.execPath,[alias,appPath,'--chrome=skip','--vscode=skip','--codex=skip'],{env:{...process.env,HOME:root,USERPROFILE:root,LOCALAPPDATA:join(root,'local'),XDG_STATE_HOME:join(root,'state')}});
 expect(stdout).toContain('chrome: skipped');expect(stdout).toContain('codex: skipped');
});
it('ignores relative state-root overrides', async () => {
 // @ts-expect-error portable helper
 const {integrationStatePath}=await import('./setup-integrations.mjs');
 expect(integrationStatePath('/safe/home','linux',{XDG_STATE_HOME:'relative'})).toBe('/safe/home/.local/state/placekeeper/integrations/choices.json');
 expect(integrationStatePath('C:\\Users\\review','win32',{LOCALAPPDATA:'relative'})).toBe('C:\\Users\\review\\AppData\\Local\\Placekeeper/integrations/choices.json');
});
