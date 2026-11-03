import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLauncherRuntime } from './launcher.mjs';
import { assertLinuxUserSandbox } from './linux-sandbox.mjs';
import { packageManagerInvocation } from './package-manager.mjs';
import { runtimeRoot } from './install-built-app.mjs';
import { resolveInstallLayout, assertSafeInstallDestinationOnDisk } from './install-layout.ts';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pins = await import('./runtime-manifest.json', { with: { type: 'json' } });
const target = `${process.platform}-${process.arch}`;
if (!pins.default.targets[target]) throw new Error(`Unsupported source-install target: ${target}`);
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Source installation requires Node.js 24 or newer');
const args = process.argv.slice(2);
const choices = { chrome: 'ask', vscode: 'ask', codex: 'ask', zed: 'ask' };
for (const argument of args) {
  if (argument === '--dry-run') continue;
  const match = /^--(chrome|vscode|codex|zed)=(setup|skip|ask|manual|preview)$/u.exec(argument);
  if (!match || (match[1] !== 'zed' && ['manual', 'preview'].includes(match[2]))) throw new Error(`Unsupported installer option: ${argument}`);
  choices[match[1]] = match[2];
}
const home = process.env.PLACEKEEPER_USER_HOME ?? homedir();
const layoutOptions = { homeDirectory: home };
const { destination } = resolveInstallLayout(layoutOptions);
await assertSafeInstallDestinationOnDisk(destination, layoutOptions);
const packageRoot = join(repo, 'dist/desktop-artifacts', `Placekeeper-${target}`);
const built = process.platform === 'darwin' ? join(packageRoot, 'Placekeeper.app') : packageRoot;
const launcher = app => process.platform === 'darwin' ? join(app, 'Contents/MacOS/placekeeper') : join(runtimeRoot(app), 'bin', `placekeeper${process.platform === 'win32' ? '.exe' : ''}`);
if (process.platform === 'linux') {
  try { await assertLinuxUserSandbox(); }
  catch (error) {
    const directory = join(repo, 'dist/desktop-artifacts/make/deb', process.arch);
    console.error(`Linux source installation cannot continue: ${error.message}\nNo installed app was changed.\nBuild the supported Debian package with: pnpm install --frozen-lockfile && pnpm package:desktop\nGenerated .deb packages: ${directory}\nThen install the exact generated .deb using your OS package manager (for example, sudo apt install /absolute/path/to/generated.deb). The installer does not run privileged commands or change sandbox settings.`);
    process.exit(1);
  }
}
if (args.includes('--dry-run')) {
  console.log(`Placekeeper Electron source install (dry run)\nTarget: ${target}\nApp destination: ${destination}\nGUI executable: PlacekeeperDesktop${process.platform === 'win32' ? '.exe' : ''}\nRequires Node.js 24+, pnpm 11.16.0, and a native C compiler; Windows requires Visual Studio Developer PowerShell.\nLinux user-local installs require verified unprivileged user namespaces; Debian packages use the OS-managed sandbox helper.\nNo files were changed`);
} else {
  const run = (command, commandArgs, options = {}) => new Promise((accept, reject) => {
    const child = spawn(command, commandArgs, { cwd: repo, stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${command} exited with ${code}`)));
  });
  const { command, prefix } = await packageManagerInvocation();
  const project = (...commandArgs) => run(command, [...prefix, ...commandArgs]);
  await project('install', '--frozen-lockfile');
  await project('build:desktop');
  await project('--dir', 'apps/electron', 'package');
  await resolveLauncherRuntime(runtimeRoot(built));
  if (!(await lstat(launcher(built))).isFile()) throw new Error('The packaged desktop launcher is missing');
  await run(launcher(built), ['daemon', 'coordinate-install', '--candidate-app', built, '--installed-app', destination,
    '--replace-helper', join(repo, 'packaging/desktop/install-built-app.mjs')]);
  console.log(`Placekeeper installed successfully.\nApp: ${destination}\nCLI: ${launcher(destination)}`);
  if (process.platform === 'darwin') {
    const root = runtimeRoot(destination);
    await run(join(root, 'node/bin/node'), [join(root, 'installer/setup-integrations.mjs'), destination,
      ...Object.entries(choices).map(([key, value]) => `--${key}=${value}`)]);
  } else {
    console.log(`Editor integrations: ${join(runtimeRoot(destination), 'integrations')}\nInstall placekeeper.vsix with VS Code's Extensions: Install from VSIX command; point placekeeper.launcherPath at the CLI printed above.\nChrome and Codex host registrations use the bundled integration-registration CLI; run the CLI with integration-registration for command usage.`);
  }
}
