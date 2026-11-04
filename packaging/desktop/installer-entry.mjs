import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLauncherRuntime } from './launcher.mjs';
import { resolveInstallLayout } from './install-layout.ts';
export { resolveInstallLayout };
import { runtimeRoot } from './install-built-app.mjs';

/** The complete candidate runs the coordinator. The bootstrap never mutates an
 * installed tree. Consent is requested only after the incumbent preview. */
export async function runInstaller({ candidate, destination = resolveInstallLayout().destination, immutable = false, uninstall = false, isolatedRoot, port }, consent, invoke = spawn) {
  if (![candidate, destination].every(isAbsolute) || resolve(candidate) === resolve(destination) && !immutable && !uninstall) throw Error('Expected distinct absolute candidate and installation paths');
  const runtime = await resolveLauncherRuntime(runtimeRoot(candidate));
  const helper = join(runtimeRoot(candidate), 'installer/install-built-app.mjs');
  const args = [runtime.service, 'daemon', 'coordinate-install', '--candidate-app', candidate, '--installed-app', destination, '--replace-helper', helper, '--native-installer-consent',
    ...(immutable ? ['--immutable-runtime'] : []), ...(uninstall ? ['--uninstall-only'] : []), ...(port === undefined ? [] : ['--isolated-installed-smoke', '--http-port', String(port), '--isolated-test-root', isolatedRoot])];
  if (port !== undefined && (!isolatedRoot || !isAbsolute(isolatedRoot))) throw Error('Isolated installation requires an absolute state root');
  return new Promise((accept, reject) => {
    const child = invoke(runtime.node, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: runtime.environment });
    let output = '', errors = '', pending = '', consentPending = false;
    let retainedResources=[];
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { errors = (errors + data).slice(-65536); });
    child.stdout.on('data', data => {
      output = (output + data).slice(-65536); pending += data;
      if (pending.length > 65536) { pending=''; child.stdin.end(); return; }
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { const notice=JSON.parse(line);if(notice.kind==='placekeeper-uninstall-retained'&&Array.isArray(notice.resources)&&notice.resources.every(value=>typeof value==='string'))retainedResources=notice.resources; } catch { /* Ordinary coordinator output is retained below. */ }
        if (line === '{"kind":"placekeeper-install-consent","version":1}' && !consentPending) {
          consentPending = true;
          void Promise.resolve().then(consent).then(accepted => child.stdin.end(`${JSON.stringify({ version: 1, accepted: accepted === true })}\n`), () => child.stdin.end('{"version":1,"accepted":false}\n'));
        }
      }
    });
    let processError;
    child.once('error', error => { processError=error; });
    // close follows exit and stdio drainage; a warning on stderr must never
    // suppress the coordinator's actionable diagnostic on stdout.
    child.once('close', (code, signal) => {
      if(code===0&&!signal&&!processError){accept({ destination, output, retainedResources });return;}
      reject(Error([`Installation stopped (exit code: ${code ?? 'unavailable'}; signal: ${signal ?? 'none'})`,...(processError?[`Process error: ${processError.message}`]:[]),`Standard error:\n${errors.trim() || '(empty)'}`,`Standard output:\n${output.trim() || '(empty)'}`].join('\n\n'),processError?{cause:processError}:undefined));
    });
  });
}

/** Extraction-only bootstraps and the DMG wrapper enter the isolated installer
 * route in Electron, never ordinary review startup. */
export async function launchInstaller(candidate, args = [], invoke = spawn) {
  const runtime = await resolveLauncherRuntime(runtimeRoot(candidate));
  const executable = join(candidate, process.platform === 'darwin' ? 'Contents/MacOS/PlacekeeperDesktop' : `PlacekeeperDesktop${process.platform === 'win32' ? '.exe' : ''}`);
  const child = invoke(executable, ['--placekeeper-install', candidate, ...args], { shell: false, stdio: 'inherit', env: runtime.environment });
  return new Promise((accept, reject) => { child.once('error', reject); child.once('exit', code => accept(code ?? 2)); });
}
if (process.argv[1] && await realpath(process.argv[1]).catch(()=>undefined) === await realpath(fileURLToPath(import.meta.url))) {
  const [candidate, ...args] = process.argv.slice(2);
  if (!candidate || !isAbsolute(candidate)) throw Error('Expected an absolute candidate bundle');
  process.exitCode = await launchInstaller(candidate, args);
}
