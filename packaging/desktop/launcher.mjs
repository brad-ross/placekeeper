import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve this installation only. A selected candidate never falls back to PATH
 * or the installed Mac application. This also works while its GUI is closed. */
export async function resolveLauncherRuntime(root, target = { platform: process.platform, arch: process.arch }) {
  const physicalRoot = await realpath(root);
  const manifest = JSON.parse(await readFile(resolve(physicalRoot, 'runtime-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.target?.platform !== target.platform || manifest.target?.arch !== target.arch ||
      !/^[a-f0-9]{64}$/u.test(manifest.daemonIdentity ?? '') || !/^[a-f0-9]{64}$/u.test(manifest.installArtifactIdentity ?? '')) {
    throw new Error('The selected Placekeeper runtime manifest is invalid');
  }
  async function verify(base, file) {
    if (!file || typeof file.path !== 'string' || isAbsolute(file.path) || file.path.includes('\0') || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '')) throw new Error('Invalid runtime asset');
    const path = await realpath(resolve(base, file.path));
    const suffix = relative(base, path);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) || !(await stat(path)).isFile()) throw new Error('Runtime asset escapes installation');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== file.sha256) throw new Error('Selected runtime asset changed');
    return path;
  }
  if (manifest.node?.path !== `node/bin/node${target.platform === 'win32' ? '.exe' : ''}` || manifest.service?.path !== 'service/main.js') throw new Error('Invalid bundled runtime layout');
  const node = await verify(physicalRoot, manifest.node);
  const service = await verify(physicalRoot, manifest.service);
  if (!manifest.webAssets || !Array.isArray(manifest.webAssets.files) || manifest.webAssets.files.length === 0 || manifest.webAssets.path !== 'web') throw new Error('Invalid runtime web assets');
  if (!manifest.webAssets.files.some(file => file.path === 'pdfium.wasm')) throw new Error('Packaged PDFium runtime is missing');
  const expectedAssets = new Set();
  for (const file of manifest.webAssets.files) expectedAssets.add(await verify(resolve(physicalRoot, 'web'), file));
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (!entry.isFile() || !expectedAssets.delete(path)) throw new Error('Unidentified packaged web asset');
    }
  }
  await inspect(resolve(physicalRoot, 'web'));
  if (expectedAssets.size) throw new Error('Incomplete packaged web assets');
  return { node, service, environment: {
    ...process.env,
    PLACEKEEPER_PDFIUM_WASM: resolve(physicalRoot, 'web/pdfium.wasm'),
    PLACEKEEPER_DAEMON_IDENTITY: manifest.daemonIdentity,
    PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: manifest.installArtifactIdentity,
  } };
}

export function desktopExecutable(root, platform = process.platform) {
  return resolve(root, platform === 'darwin' ? '../../MacOS/PlacekeeperCandidate' : `../../PlacekeeperCandidate${platform === 'win32' ? '.exe' : ''}`);
}

function capture(invoke, executable, args, environment) {
  return new Promise((accept, reject) => {
    const child = invoke(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'inherit'], env: environment });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; if (Buffer.byteLength(output) > 65536) child.kill(); });
    child.once('error', reject);
    child.once('exit', code => Buffer.byteLength(output) > 65536 ? reject(new Error('Launch receipt too large')) : accept({ code: code ?? 2, output }));
  });
}

export async function main(args = process.argv.slice(2), root = dirname(fileURLToPath(import.meta.url)), invoke = spawn) {
  try {
    const runtime = await resolveLauncherRuntime(root);
    if (['open', 'open-link'].includes(args[0]) && args.includes('--desktop')) {
      const executable = desktopExecutable(root);
      if (!(await stat(executable)).isFile()) throw new Error('The selected desktop executable is missing');
      const staged = await capture(invoke, runtime.node, [runtime.service, ...args], runtime.environment);
      const receipt = JSON.parse(staged.output);
      if (staged.code !== 0 || receipt.ok !== true || !['opened', 'focused'].includes(receipt.kind)) {
        process.stdout.write(staged.output); return staged.code;
      }
      if (receipt.surface !== 'electron' || receipt.native !== true || !/^[A-Za-z0-9_-]{43}$/u.test(receipt.launchId ?? '')) throw new Error('Invalid desktop launch receipt');
      try {
        const child = invoke(executable, ['--placekeeper-launch', receipt.launchId], { shell: false, stdio: 'ignore', detached: true, env: process.env });
        await new Promise((accept, reject) => { child.once('error', reject); child.once('spawn', accept); });
        child.unref();
      } catch (error) {
        await capture(invoke, runtime.node, [runtime.service, 'electron-cancel-launch', receipt.launchId], runtime.environment).catch(() => undefined);
        throw error;
      }
      process.stdout.write(staged.output); return 0;
    }
    const child = invoke(runtime.node, [runtime.service, ...args], { shell: false, stdio: 'inherit', env: runtime.environment });
    return await new Promise((accept, reject) => {
      child.once('error', reject);
      child.once('exit', code => accept(code ?? 2));
    });
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { kind: 'input-unavailable', message: 'The selected Placekeeper installation is unavailable or changed.', recoveryAction: 'Select a complete matching installation' } })}\n`);
    return 2;
  }
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === await realpath(fileURLToPath(import.meta.url))) process.exitCode = await main();
