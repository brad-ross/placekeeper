import { spawn } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLauncherRuntime, desktopExecutable } from './launcher.mjs';

const runtimeStore = '/opt/placekeeper/runtimes';
export function linuxSelectionPath(env = process.env) {
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir();
  const state = env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, '.local/state');
  return join(state, 'placekeeper/installer/selected-runtime.json');
}
async function rootOwned(path, directory) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== 0 || (info.mode & 0o022)) throw Error(`Runtime is not immutable and root-owned: ${path}`);
  return info;
}
export function assertSandboxMount(mountInfo, sandbox) {
  const unescape = value => value.replace(/\\([0-7]{3})/gu, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = mountInfo.trim().split('\n').map(line => line.split(' ')).filter(fields => fields.length >= 10);
  const matching = mounts.filter(fields => { const point=unescape(fields[4]); return sandbox === point || sandbox.startsWith(point === '/' ? '/' : point + '/'); }).sort((a,b) => b[4].length-a[4].length);
  if (!matching.length) throw Error('Cannot verify sandbox filesystem policy');
  const fields = matching[0]; const separator = fields.indexOf('-');
  const options = `${fields[5]},${fields[separator + 3] ?? ''}`.split(',');
  if (options.includes('noexec') || options.includes('nosuid')) throw Error('Placekeeper needs an executable, SUID-capable filesystem for its sandbox. Ask an administrator to relocate the runtime; do not disable the sandbox.');
}
export async function validateImmutableRuntime(resources) {
  const app = resolve(resources, '../..');
  const artifact = app.slice(app.lastIndexOf('/') + 1);
  if (!/^[a-f0-9]{64}$/u.test(artifact) || app !== join(runtimeStore, artifact) || resources !== join(app, 'resources/desktop')) throw Error('Unexpected immutable runtime location');
  for (const path of ['/opt', '/opt/placekeeper', runtimeStore, app]) await rootOwned(path, true);
  async function inspect(path) {
    await rootOwned(path, true);
    for (const item of await readdir(path, { withFileTypes: true })) {
      const child = join(path,item.name);
      if (item.isDirectory()) await inspect(child); else await rootOwned(child,false);
    }
  }
  await inspect(app);
  const marker = join(app, '.complete'); await rootOwned(marker,false);
  if ((await readFile(marker,'utf8')).trim() !== artifact) throw Error('Incomplete immutable runtime');
  const sandbox=join(app,'chrome-sandbox'); const helper=await rootOwned(sandbox,false);
  if ((helper.mode & 0o7777) !== 0o4755) throw Error('The root-owned sandbox helper needs mode 4755; ask an administrator to reinstall the package.');
  assertSandboxMount(await readFile('/proc/self/mountinfo','utf8'),sandbox);
  const runtime=await resolveLauncherRuntime(resources);
  if (runtime.environment.PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY !== artifact) throw Error('Immutable runtime identity mismatch');
  return runtime;
}
async function selected() {
  const record=await readFile(linuxSelectionPath(),'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});
  if (record === null) return null;
  if (record.version!==1 || !/^[a-f0-9]{64}$/u.test(record.installArtifactIdentity ?? '') || record.resources!==join(runtimeStore,record.installArtifactIdentity,'resources/desktop')) throw Error('Invalid per-user runtime selection; preserve the selection and recovery journal for manual recovery');
  await validateImmutableRuntime(record.resources);
  return record;
}
function wait(child) { return new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',code=>accept(code??2));}); }
export async function dispatch(args=process.argv.slice(2)) {
  if (process.getuid?.()===0) throw Error('Launch Placekeeper as your ordinary user, not root');
  let current=await selected();
  await rootOwned('/opt/placekeeper/available',false);
  const available=(await readFile('/opt/placekeeper/available','utf8')).trim();
  if (!/^[a-f0-9]{64}$/u.test(available)) throw Error('Invalid available runtime marker');
  const resources=join(runtimeStore,available,'resources/desktop');
  await validateImmutableRuntime(resources);
  const explicitLaunch=!args.length || /^(?:placekeeper(?:-navigation)?:|\/)/u.test(args[0]) || ['open','open-link'].includes(args[0]) || /\.pdf$/iu.test(args[0]);
  if (!current || explicitLaunch && current.installArtifactIdentity!==available) {
    const { launchInstaller }=await import(pathToFileURL(join(resources,'installer/installer-entry.mjs')).href);
    const code=await launchInstaller(join(runtimeStore,available),['--immutable-runtime','--destination',join(runtimeStore,available)]);
    if (code!==0) return code;
    current=await selected();
    if (!current) throw Error('No runtime activated; launch Placekeeper again to finish installation');
  }
  const runtime=await validateImmutableRuntime(current.resources);
  if (!args.length || /^(?:placekeeper(?:-navigation)?:|\/)/u.test(args[0]) || /\.pdf$/iu.test(args[0])) return wait(spawn(desktopExecutable(current.resources),args,{stdio:'inherit',env:runtime.environment,shell:false}));
  const vscode=args[0]==='--vscode-launcher';
  return wait(spawn(runtime.node,[join(current.resources,vscode?'vscode-launcher.mjs':'launcher.mjs'),...(vscode?args.slice(1):args)],{stdio:'inherit',env:runtime.environment,shell:false}));
}
if (process.argv[1] && await realpath(process.argv[1]).catch(()=>undefined)===await realpath(fileURLToPath(import.meta.url))) {
  try { process.exitCode=await dispatch(); } catch(error) { console.error(String(error)); process.exitCode=2; }
}
