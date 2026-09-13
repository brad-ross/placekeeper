import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { updateVscode } from './update-vscode.mjs';
import { setupChrome } from './setup-chrome.mjs';

const execute = promisify(execFile);
const hosts = ['chrome', 'vscode', 'codex'];
const labels = { chrome: 'Chrome (experimental)', vscode: 'VS Code', codex: 'Codex' };
const marketplaceName = 'placekeeper-installed';

export function parseChoices(args) {
  const choices = {};
  for (const argument of args) {
    const match = /^--(chrome|vscode|codex)=(.*)$/u.exec(argument);
    if (!match) throw new Error(`Unknown integration option: ${argument}`);
    if (!['setup', 'skip', 'ask'].includes(match[2])) throw new Error(`${match[1]} choice must be setup, skip, or ask`);
    if (choices[match[1]]) throw new Error(`Duplicate integration option: ${match[1]}`);
    choices[match[1]] = match[2];
  }
  return choices;
}

// Read the controlling terminal, never the release bootstrap's stdin.
export async function promptFromTerminal(host) {
  let terminal;
  try { terminal = await open('/dev/tty', 'r+'); } catch { return undefined; }
  try {
    for (;;) {
      await terminal.write(`${labels[host]} integration: set up or skip? [setup/skip, default skip] `);
      let line = '';
      const byte = Buffer.alloc(1);
      for (;;) {
        const { bytesRead } = await terminal.read(byte, 0, 1, null);
        if (!bytesRead) return undefined;
        if (byte[0] === 10 || byte[0] === 13) break;
        line += byte.toString();
      }
      const answer = line.trim().toLowerCase();
      if (['setup', 'yes', 'y'].includes(answer)) return true;
      if (['skip', 'no', 'n', ''].includes(answer)) return false;
      await terminal.write('Enter setup or skip.\n');
    }
  } finally { await terminal.close(); }
}

export async function setupCodex({ appPath, codexPath, run = execute }) {
  const marketplace = resolve(appPath, 'Contents/Resources/integrations');
  const guidance = `Local marketplace: ${marketplace}. In Codex, add this local marketplace and install codex-plugin@${marketplaceName}; review trust and enablement, then start a new task.`;
  const pending = (message) => ({ status: 'pending', path: marketplace, message: `${message} ${guidance}` });
  codexPath ??= [
    ...(process.env.PLACEKEEPER_HOST_PATH ?? process.env.PATH ?? '').split(':').filter(Boolean).map((directory) => resolve(directory, 'codex')),
    resolve(homedir(), 'Applications/ChatGPT.app/Contents/Resources/codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ].find((candidate) => existsSync(candidate));
  if (!codexPath) return pending('Codex CLI is unavailable; finish setup in Codex.');
  // Probe every required supported interface before mutating a source or plugin.
  for (const args of [['plugin', 'marketplace', 'list'], ['plugin', 'marketplace', 'add'], ['plugin', 'add'], ['plugin', 'list']]) {
    try {
      const { stdout } = await run(codexPath, [...args, '--help']);
      if (!stdout.includes('--json') || (args.length === 2 && args[1] === 'list' && !stdout.includes('--marketplace'))) {
        return pending('This Codex CLI does not expose the required supported setup commands.');
      }
    } catch { return pending('Codex CLI is unavailable or does not support plugin setup.'); }
  }
  const listed = JSON.parse((await run(codexPath, ['plugin', 'marketplace', 'list', '--json'])).stdout);
  if (!Array.isArray(listed.marketplaces)) throw new Error('Codex returned an unrecognized marketplace list');
  const existing = listed.marketplaces.find((entry) => entry.name === marketplaceName);
  if (existing && (existing.marketplaceSource?.sourceType !== 'local' || existing.marketplaceSource.source !== marketplace)) {
    return pending('The installed marketplace name already belongs to a different source; resolve that conflict in Codex before adding it.');
  }
  const before = JSON.parse((await run(codexPath, ['plugin', 'list', '--marketplace', marketplaceName, '--json'])).stdout);
  if (!Array.isArray(before.installed)) throw new Error('Codex returned an unrecognized installed plugin list');
  const previous = before.installed.find((plugin) => plugin.pluginId === `codex-plugin@${marketplaceName}` && plugin.installed === true);
  if (previous && previous.enabled !== true) {
    return pending('The existing Codex plugin is disabled or its enablement is unknown; its state was preserved. To refresh it, use Codex plugin management to update or reinstall this plugin and choose enablement explicitly.');
  }
  await run(codexPath, ['plugin', 'marketplace', 'add', marketplace, '--json']);
  await run(codexPath, ['plugin', 'add', `codex-plugin@${marketplaceName}`, '--json']);
  const plugins = JSON.parse((await run(codexPath, ['plugin', 'list', '--marketplace', marketplaceName, '--json'])).stdout);
  if (!Array.isArray(plugins.installed) || !plugins.installed.some((plugin) => plugin.pluginId === `codex-plugin@${marketplaceName}` && plugin.installed === true)) {
    throw new Error('Codex did not confirm the plugin payload after installation');
  }
  return pending('Codex plugin payload installed. Host trust, enablement, and a new task still require confirmation in Codex.');
}

export async function setupHost({ appPath, host, run = execute }) {
  if (host === 'chrome') return { host, ...await setupChrome(appPath) };
  if (host === 'codex') return { host, ...await setupCodex({ appPath, run }) };
  if (host === 'vscode') {
    const result = await updateVscode({ appPath, installIfMissing: true, run });
    return { host, status: 'pending', message: result.status === 'editor-unavailable'
      ? `VS Code CLI is unavailable. In VS Code, run Extensions: Install from VSIX and select ${result.path}, then reload the editor and check extension enablement.`
      : `VS Code extension ${result.status} (${result.version}). Reload VS Code and check extension enablement.`, ...('path' in result ? { path: result.path } : {}) };
  }
  throw new Error(`Unknown host: ${host}`);
}

export async function setupIntegrations({ appPath, choices = {}, prompt = promptFromTerminal, run = execute, write = console.log, macStatus = process.env.PLACEKEEPER_MAC_STATUS === 'current' ? 'current' : 'installed' }) {
  const outcomes = [];
  let noTerminal = false;
  // No lifecycle lock is held while asking the user. Each selected stage
  // independently rechecks the installed identity and active work below.
  for (const host of hosts) {
    const choice = choices[host] ?? 'ask';
    const answer = choice === 'setup' ? true : choice === 'skip' ? false : await prompt(host);
    if (answer === undefined) noTerminal = true;
    if (!answer) { outcomes.push({ host, status: 'skipped', message: 'No setup changes requested.' }); continue; }
    write(`Setting up ${labels[host]}…`);
    try {
      const { stdout } = await run(resolve(appPath, 'Contents/MacOS/placekeeper'), [
        'daemon', 'coordinate-host', '--installed-app', appPath,
        '--host-helper', resolve(appPath, 'Contents/Resources/installer/setup-integrations.mjs'),
        '--', '--host', appPath, host,
      ], { timeout: 330_000, maxBuffer: 1_048_576 });
      const result = stdout.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }).find((entry) => entry.host === host);
      if (!result || !['completed', 'pending'].includes(result.status) || typeof result.message !== 'string') {
        throw new Error('Host setup did not return a verifiable outcome');
      }
      outcomes.push(result);
    } catch (error) {
      outcomes.push({ host, status: error.code === 2 ? 'pending' : 'failed', message: error.code === 2
        ? 'Close active Placekeeper reviews/tasks and retry setup; existing work was preserved.'
        : `${error.stderr?.trim() || error.message}. Retry this integration after resolving the diagnostic.` });
    }
  }
  write(`\nMac: ${macStatus === 'current' ? 'already current' : 'installed'}.`);
  for (const result of outcomes) write(`${labels[result.host]}: ${result.status}. ${result.message}`);
  if (noTerminal) write('No terminal was available. Rerun in a terminal, or choose explicitly: --chrome=setup --vscode=setup --codex=setup (use =skip to decline).');
  write(`Add or repair integrations later by rerunning the install command, or run:\n"${resolve(appPath, 'Contents/Resources/node/bin/node')}" "${resolve(appPath, 'Contents/Resources/installer/setup-integrations.mjs')}" "${appPath}" --chrome=ask --vscode=ask --codex=ask`);
  return { mac: macStatus, outcomes, exitCode: outcomes.some((result) => result.status === 'failed') ? 3 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === '--host') {
      if (!process.env.PLACEKEEPER_LIFECYCLE_LOCK_TOKEN) throw new Error('Host setup requires daemon coordinate-host');
      console.log(JSON.stringify(await setupHost({ appPath: process.argv[3], host: process.argv[4] })));
    } else {
      if (!process.argv[2]) throw new Error('Usage: setup-integrations.mjs <installed-app> [--chrome=setup|skip|ask] [--vscode=setup|skip|ask] [--codex=setup|skip|ask]');
      const result = await setupIntegrations({ appPath: resolve(process.argv[2]), choices: parseChoices(process.argv.slice(3)) });
      process.exitCode = result.exitCode;
    }
  } catch (error) { console.error(error.message); process.exitCode = 3; }
}
