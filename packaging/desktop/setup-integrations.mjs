import { createHash, randomUUID } from 'node:crypto';
import { resolveInstallLayout } from './install-layout.ts';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile, open, realpath, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { integrationLauncher } from './launcher.mjs';

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600}); await rename(temporary,path); }
  finally { await rm(temporary,{force:true}); }
}
export const hosts = ['chrome', 'vscode', 'codex'];
export function parseChoices(args) {
  const choices = {};
  for (const arg of args) {
    const match = /^--(chrome|vscode|codex|zed)=(ask|setup|skip|manual|preview)$/u.exec(arg);
    if (!match || (match[1] !== 'zed' && ['manual','preview'].includes(match[2])) || choices[match[1]]) throw Error(`Invalid integration choice: ${arg}`);
    choices[match[1]] = match[2];
  }
  return choices;
}
export async function promptFromTerminal(host) {
  let terminal;
  try { terminal = await open(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r+'); } catch { return false; }
  try {
    await terminal.write(host === 'zed' ? 'zed: jump on demand, after build, or skip? [manual/preview/skip, default skip] ' : `${host}: set up optional integration? [y/N] `);
    let line = ''; const byte = Buffer.alloc(1);
    for (;;) { const {bytesRead} = await terminal.read(byte, 0, 1, null); if (!bytesRead || byte[0] === 10 || byte[0] === 13) break; line += byte.toString(); }
    if(host === 'zed' && ['manual','preview'].includes(line.trim().toLowerCase())) return line.trim().toLowerCase();
    return /^(?:y|yes|setup)$/iu.test(line.trim());
  } finally { await terminal.close(); }
}
export function integrationStatePath(home = homedir(), platform = process.platform, env = process.env) {
  return join(resolveInstallLayout({platform,homeDirectory:home,env}).supportRoot, 'integrations/choices.json');
}
export async function setupIntegrations({appPath, resources, choices = {}, statePath, home = homedir(), platform = process.platform, run = promisify(execFile), prompt = async () => false, write = () => {}, codePath}) {
  resources ??= join(resolve(appPath), platform === 'darwin' ? 'Contents/Resources/desktop' : 'resources/desktop');
  statePath ??= integrationStatePath(home, platform);
  const prior = await readFile(statePath,'utf8').then(JSON.parse, error => { if(error.code === 'ENOENT') return {choices:{}}; throw error; });
  const selected = {};
  for (const host of hosts) selected[host] = choices[host] === 'setup' ? true : choices[host] === 'skip' ? false : choices[host] === 'ask' ? await prompt(host) === true : prior.choices?.[host] === true;
  await mkdir(dirname(statePath),{recursive:true,mode:0o700});
  await atomicJson(statePath,{schemaVersion:1,choices:selected});
  const manifest = JSON.parse(await readFile(join(resources,'runtime-manifest.json'),'utf8'));
  const launcher = await integrationLauncher(resources,manifest.installArtifactIdentity,platform);
  const suffix = platform === 'win32' ? '.exe' : '';
  const outcomes = [];
  for (const host of hosts) {
    if (!selected[host]) { outcomes.push({host,status:'skipped',message:'No setup changes requested.'}); continue; }
    try {
      const owned = dirname(statePath);
      const receipt = join(owned,`${host}.receipt.json`);
      let destination; let args;
      if (host === 'codex') {
        destination = join(owned,'codex');
        args = ['--destination',destination,'--node',join(resources,`node/bin/node${suffix}`),'--server',join(resources,'codex-mcp/server.js'),'--launcher',launcher];
      } else if (host === 'vscode') {
        destination = join(owned,'vscode-settings.json');
        args = ['--destination',destination,'--launcher',launcher];
      } else {
        destination = platform === 'darwin' ? join(home,'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.placekeeper.chrome.json') : platform === 'linux' ? join(home,'.config/google-chrome/NativeMessagingHosts/com.placekeeper.chrome.json') : join(owned,'com.placekeeper.chrome.json');
        const native = launcher === '/usr/bin/placekeeper' ? '/usr/bin/placekeeper-chrome-native-host' : join(resources,`bin/placekeeper-chrome-native-host${suffix}`);
        args = ['--destination',destination,'--native-host',native];
      }
      const {stdout} = await run(launcher,['integration-registration',host,'--receipt',receipt,...args]);
      const result = JSON.parse(stdout);
      if (result.ok !== true) throw Error(result.error?.message ?? 'Registration failed');
      let message;
      let registration = result.registration ?? 'registered';
      if (host === 'vscode') {
        const vsix = join(resources,'integrations/placekeeper.vsix');
        const code = codePath ?? (process.env.PLACEKEEPER_HOST_PATH ?? process.env.PATH ?? '').split(delimiter).map(path=>join(path,platform === 'win32' ? 'code.cmd' : 'code')).find(existsSync);
        // Always use the supported installer, including equal-version payload refresh.
        const vsixSha256 = createHash('sha256').update(await readFile(vsix)).digest('hex');
        const hostReceipt = join(owned,'vscode-host.receipt.json');
        const installed = await readFile(hostReceipt,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return undefined;throw error;});
        if (installed && (installed.schemaVersion !== 1 || !/^[a-f0-9]{64}$/u.test(installed.vsixSha256 ?? ''))) throw Error('Inspect the retained VS Code host receipt');
        if (code && platform !== 'win32' && installed?.vsixSha256 !== vsixSha256) {
          await run(code,['--install-extension',vsix,'--force']);
          await atomicJson(hostReceipt,{schemaVersion:1,vsixSha256});
          registration = 'repaired';
        }
        message = `VS Code launcher setting prepared at ${destination}. Apply it in VS Code settings. ${code && platform !== 'win32' ? 'The bundled extension was submitted to VS Code.' : `Install ${vsix} using Extensions: Install from VSIX.`} Reload VS Code, check enablement, and verify a PDF handoff.`;
      } else if (host === 'chrome') message = `Chrome native host registered. Load or update the unpacked extension at ${join(resources,'integrations/chrome-extension')}, approve permissions, reload Chrome and verify a PDF handoff. A previous 0.2.4 extension must be reloaded from this folder.`;
      else message = `Codex plugin prepared at ${destination}. In Codex Plugins add this local marketplace, install or update codex-plugin, review trust and enablement, fully restart Codex, and verify the Placekeeper skill, display tool and trusted hooks. Previous 0.2.4 plugin caches require reinstall or update and restart.`;
      outcomes.push({host,status:'pending',registration,hostAction:'pending',path:destination,message});
    } catch (error) { outcomes.push({host,status:'failed',message:`${error.message}. Existing edited or unowned registrations are preserved; inspect the ownership receipt before retrying.`}); }
  }
  // Retain the published Mac source installer's optional Zed operation.
  if (choices.zed && choices.zed !== 'skip') {
    const answer = choices.zed === 'ask' ? await prompt('zed') : choices.zed;
    if (answer) {
      try {
        if (platform !== 'darwin') throw Error('Use the bundled editor integration guide to configure Zed on this platform');
        const installedApp = appPath ?? resolve(resources,'../../..');
        const {stdout} = await run(launcher,['daemon','coordinate-host','--installed-app',installedApp,'--host-helper',join(resources,'installer/setup-integrations.mjs'),'--','--host',installedApp,'zed',answer === 'preview' ? 'preview' : 'manual']);
        const result = stdout.split(/\r?\n/u).filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(item=>item.host==='zed');
        if(!result) throw Error('Zed setup did not report an outcome');
        outcomes.push(result);
      } catch(error) { outcomes.push({host:'zed',status:'failed',message:error.message}); }
    } else outcomes.push({host:'zed',status:'skipped',message:'No setup changes requested.'});
  }
  for (const result of outcomes) write(`${result.host}: ${result.status}. ${result.message}`);
  return {outcomes,exitCode:outcomes.some(result=>result.status==='failed')?3:0};
}
if (process.argv[1] && await realpath(process.argv[1]).catch(()=>undefined) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    if(process.argv[2] === '--host') {
      if(!process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN || process.argv[4] !== 'zed') throw Error('Legacy host setup requires coordinated Zed setup');
      const {setupZed} = await import('./setup-zed.mjs');
      console.log(JSON.stringify({host:'zed',...await setupZed({appPath:process.argv[3],mode:process.argv[5]})}));
    } else {
      const result = await setupIntegrations({appPath:process.argv[2], choices:parseChoices(process.argv.slice(3)),prompt:promptFromTerminal,write:console.log}); process.exitCode=result.exitCode;
    }
  }
  catch(error) { console.error(error.message); process.exitCode=3; }
}
