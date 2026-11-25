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
 expect(first.outcomes.map((o: {status:string})=>o.status)).toEqual(['skipped','skipped','skipped','skipped']); expect(calls).toEqual([]);
 const second = await setupIntegrations({appPath:root,platform:"linux",statePath,home:root,choices:{chrome:'setup'},run});
 expect(second.outcomes[0]).toMatchObject({host:'chrome',status:'pending'});
 expect(second.outcomes[0].message).toMatch(/Chrome.*reload|reload.*Chrome/s);
 expect(JSON.parse(await readFile(statePath,'utf8')).choices).toEqual({chrome:true,vscode:false,codex:false,claude:false});
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
 const {stdout}=await promisify(execFile)(process.execPath,[alias,appPath,'--chrome=skip','--vscode=skip','--codex=skip','--claude=skip'],{env:{...process.env,HOME:root,USERPROFILE:root,LOCALAPPDATA:join(root,'local'),XDG_STATE_HOME:join(root,'state')}});
 expect(stdout).toContain('chrome: skipped');expect(stdout).toContain('codex: skipped');expect(stdout).toContain('claude: skipped');
});
it('ignores relative state-root overrides', async () => {
 // @ts-expect-error portable helper
 const {integrationStatePath}=await import('./setup-integrations.mjs');
 expect(integrationStatePath('/safe/home','linux',{XDG_STATE_HOME:'relative'})).toBe(join('/safe/home', '.local', 'state', 'placekeeper', 'integrations', 'choices.json'));
 expect(integrationStatePath('C:\\Users\\review','win32',{LOCALAPPDATA:'relative'})).toBe(join('C:\\Users\\review\\AppData\\Local\\Placekeeper', 'integrations', 'choices.json'));
});
it('parses Claude Desktop choices wherever Codex choices are accepted', async () => {
 // @ts-expect-error portable helper
 const {parseChoices,labels}=await import('./setup-integrations.mjs');
 expect(parseChoices(['--codex=skip','--claude=setup'])).toEqual({codex:'skip',claude:'setup'});
 expect(parseChoices(['--claude=ask'])).toEqual({claude:'ask'});
 for (const bad of [['--claude=manual'],['--claude=yes'],['--claude=skip','--claude=setup']]) expect(()=>parseChoices(bad)).toThrow('Invalid integration choice');
 expect(labels.claude).toBe('Claude Desktop (experimental)');
 // @ts-expect-error legacy helper
 const legacy=await import('../macos/setup-integrations.mjs');
 expect(legacy.parseChoices(['--claude=skip'])).toEqual({claude:'skip'});
 expect(()=>legacy.parseChoices(['--claude=preview'])).toThrow('setup, skip, or ask');
 const installer=await readFile(join(process.cwd(),'packaging/desktop/source-install.mjs'),'utf8');
 expect(installer).toContain("claude: 'ask'");expect(installer).toContain('codex|claude|zed');
});
it('registers Claude Desktop through the installed launcher with the bundled node and MCP server', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-claude-setup-'));const resources=join(root,'resources');
 await mkdir(resources,{recursive:true});await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({installArtifactIdentity:'a'.repeat(64)}));
 const calls: string[][]=[];let registration='registered';
 const run=async (_:string,args:string[])=>{calls.push(args);return {stdout:JSON.stringify({ok:true,status:'registered',registration})};};
 const options={resources,statePath:join(root,'state/choices.json'),home:root,platform:'linux',choices:{claude:'setup'},run};
 const missing=await setupIntegrations(options);
 expect(missing.outcomes[3]).toMatchObject({host:'claude',status:'pending',hostAction:'host-not-found'});
 expect(missing.outcomes[3]).not.toHaveProperty('registration');
 expect(missing.outcomes[3].message).toContain('Claude Desktop was not found');expect(missing.outcomes[3].message).toContain('Help → Set Up Integrations');expect(missing.exitCode).toBe(0);expect(calls).toEqual([]);
 await expect(readFile(join(root,'.config/Claude/claude_desktop_config.json'))).rejects.toMatchObject({code:'ENOENT'});
 await mkdir(join(root,'.config/Claude'),{recursive:true});
 const config=join(root,'.config/Claude/claude_desktop_config.json');
 const first=await setupIntegrations({...options,choices:{}});
 expect(calls).toEqual([['integration-registration','claude','--receipt',join(root,'state/claude.receipt.json'),'--destination',config,'--node',join(resources,'node/bin/node'),'--server',join(resources,'codex-mcp/server.js'),'--launcher',join(resources,'bin/placekeeper')]]);
 expect(first.outcomes[3]).toMatchObject({host:'claude',status:'pending',registration:'registered',path:config});
 expect(first.outcomes[3].message).toMatch(/Fully quit Claude Desktop/);
 expect(first.outcomes[3].message).toContain('File → Open in Claude');expect(first.outcomes[3].message).toContain('allow the Placekeeper tool');
 registration='current';expect((await setupIntegrations(options)).outcomes[3]).toMatchObject({registration:'current'});
 const skipped=await setupIntegrations({...options,choices:{claude:'skip'}});
 expect(skipped.outcomes[3]).toMatchObject({host:'claude',status:'skipped'});expect(calls).toHaveLength(2);
 const windows=await setupIntegrations({...options,platform:'win32',env:{APPDATA:join(root,'Roaming')}});
 expect(windows.outcomes[3]).toMatchObject({hostAction:'host-not-found',path:join(root,'Roaming','Claude','claude_desktop_config.json')});
});
it('reports a refused Claude Desktop merge as a failed integration', async () => {
 const root=await mkdtemp(join(tmpdir(),'pk-claude-refused-'));const resources=join(root,'resources');
 await mkdir(resources,{recursive:true});await writeFile(join(resources,'runtime-manifest.json'),JSON.stringify({installArtifactIdentity:'a'.repeat(64)}));
 await mkdir(join(root,'Library/Application Support/Claude'),{recursive:true});
 const run=async ()=>({stdout:JSON.stringify({ok:false,error:{message:'Claude Desktop configuration is not valid JSON; it was left unchanged'}})});
 const result=await setupIntegrations({resources,statePath:join(root,'state/choices.json'),home:root,platform:'darwin',choices:{claude:'setup'},run});
 expect(result.outcomes[3]).toMatchObject({host:'claude',status:'failed'});expect(result.outcomes[3].message).toContain('left unchanged');expect(result.exitCode).toBe(3);
});
