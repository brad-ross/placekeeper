import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** OS-managed immutable runtimes publish integration commands through the
 * installed dispatcher. Derive that path from the verified layout and ownership,
 * never from an inherited launcher environment variable. */
export async function integrationLauncher(root, artifactIdentity, platform = process.platform) {
  const local=resolve(root, `bin/placekeeper${platform === 'win32' ? '.exe' : ''}`);
  if(platform!=='linux'||! /^[a-f0-9]{64}$/u.test(artifactIdentity)||root!==`/opt/placekeeper/runtimes/${artifactIdentity}/resources/desktop`)return local;
  const directories=['/opt','/opt/placekeeper','/opt/placekeeper/runtimes',`/opt/placekeeper/runtimes/${artifactIdentity}`,`/opt/placekeeper/runtimes/${artifactIdentity}/resources`,root,'/usr','/usr/bin'];
  for(const path of [...directories,'/usr/bin/placekeeper']) {
    const info=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
    if(!info||info.isSymbolicLink()||info.uid!==0||(info.mode&0o022)||(path==='/usr/bin/placekeeper'?!info.isFile()||!(info.mode&0o111):!info.isDirectory()))return local;
  }
  return '/usr/bin/placekeeper';
}

/** Resolve this installation only. The launcher never falls back to PATH
 * or a different installation. This also works while its GUI is closed. */
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
  let codexMcp;
  if (manifest.codexMcp !== undefined) {
    if (manifest.codexMcp.path !== 'codex-mcp/server.js') throw new Error('Invalid bundled MCP layout');
    codexMcp = await verify(physicalRoot, manifest.codexMcp);
  }
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
  return { node, service, codexMcp, environment: {
    ...process.env,
    PLACEKEEPER_APP_RESOURCES: physicalRoot,
    PLACEKEEPER_LAUNCHER: await integrationLauncher(physicalRoot, manifest.installArtifactIdentity, target.platform),
    PLACEKEEPER_PDFIUM_WASM: resolve(physicalRoot, 'web/pdfium.wasm'),
    PLACEKEEPER_DAEMON_IDENTITY: manifest.daemonIdentity,
    PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY: manifest.installArtifactIdentity,
  } };
}

export function desktopExecutable(root, platform = process.platform) {
  return resolve(root, platform === 'darwin' ? '../../MacOS/PlacekeeperDesktop' : `../../PlacekeeperDesktop${platform === 'win32' ? '.exe' : ''}`);
}

function capture(invoke, executable, args, environment, { maxBytes = 65536, timeoutMs } = {}) {
  return new Promise((accept, reject) => {
    const child = invoke(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'inherit'], env: environment });
    let output = '';
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { child.kill(); reject(new Error('Desktop command timed out')); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (Buffer.byteLength(output) <= maxBytes) output += chunk; if (Buffer.byteLength(output) > maxBytes) child.kill(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); Buffer.byteLength(output) > maxBytes ? reject(new Error('Desktop command output too large')) : accept({ code: code ?? 2, output }); });
  });
}

export async function main(args = process.argv.slice(2), root = dirname(fileURLToPath(import.meta.url)), invoke = spawn) {
  try {
    const runtime = await resolveLauncherRuntime(root);
    if (['choose-source-folder', 'choose-source-pdf', 'choose-neovim-endpoint'].includes(args[0])) {
      const kind = args[0] === 'choose-source-folder' ? 'folder' : args[0] === 'choose-source-pdf' ? 'pdf' : 'endpoint';
      if (kind === 'endpoint' ? args.length !== 1 : args.length !== 2 || !isAbsolute(args[1]) || args[1].includes('\0')) throw new Error('Invalid desktop chooser arguments');
      const executable = desktopExecutable(root);
      if (!(await stat(executable)).isFile()) throw new Error('The selected desktop executable is missing');
      const result = await capture(invoke, executable, ['--placekeeper-choose', kind, ...args.slice(1)], runtime.environment, { maxBytes: 16 * 1024, timeoutMs: 120_000 });
      if (result.code !== 0) return result.code;
      const choice = JSON.parse(result.output);
      if (choice === null || typeof choice !== 'object' || Object.keys(choice).join() !== 'selected' || (choice.selected !== null && typeof choice.selected !== 'string')) throw new Error('Invalid desktop chooser result');
      process.stdout.write(`${JSON.stringify(choice)}\n`);
      return 0;
    }
    if (args[0] === 'codex-mcp') {
      if (args.length !== 1 || runtime.codexMcp === undefined) throw new Error('The verified bundled MCP server is missing');
      const child = invoke(runtime.node, [runtime.codexMcp], { shell: false, stdio: 'inherit', env: runtime.environment });
      return await new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('exit', code => accept(code ?? 2));
      });
    }
    if (['view-source', 'zed-forward', 'zed-build'].includes(args[0])) {
      const adapter = resolve(runtime.environment.PLACEKEEPER_APP_RESOURCES, 'integrations/editors/zed-adapter.mjs');
      if (!(await stat(adapter)).isFile()) throw new Error('The bundled editor adapter is missing');
      // The adapter has no standalone entry point. Run its public function in
      // our verified Node with the verified environment and original editor
      // owner, preserving the compiler/preview parent relationship.
      const source = 'const adapter = await import(process.argv[1]); process.exitCode = await adapter[process.argv[2]](JSON.parse(process.argv[5]), { owner: Number(process.argv[3]), launcher: process.argv[4] });';
      const child = invoke(runtime.node, ['--input-type=module', '--eval', source,
        pathToFileURL(adapter).href, args[0] === 'view-source' ? 'runViewSource' : 'runZed',
        String(process.ppid), runtime.environment.PLACEKEEPER_LAUNCHER, JSON.stringify(args)],
        { shell: false, stdio: 'inherit', env: runtime.environment });
      return await new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('exit', code => accept(code ?? 2));
      });
    }
    if (['open', 'open-link'].includes(args[0]) && !args.includes('--surface') && !args.includes('--desktop')) args = [...args, '--desktop', 'electron'];
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
        const child = invoke(executable, ['--placekeeper-launch', receipt.launchId], { shell: false, stdio: 'ignore', detached: true, env: runtime.environment });
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
