import assert from 'node:assert/strict';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setupIntegrations, setupCodex, parseChoices } from './setup-integrations.mjs';

const appPath = '/Users/test/Applications/Placekeeper.app';
test('explicit choices are independent and reject typos before setup', () => {
  assert.deepEqual(parseChoices(['--chrome=setup', '--vscode=skip', '--codex=ask']), { chrome: 'setup', vscode: 'skip', codex: 'ask' });
  assert.throws(() => parseChoices(['--chrome=yes']), /setup.*skip.*ask/);
  assert.throws(() => parseChoices(['--unknown=skip']), /Unknown/);
});
test('no terminal skips every host without mutation and gives rerun guidance', async () => {
  const messages = [];
  const result = await setupIntegrations({ appPath, prompt: async () => undefined, write: (text) => messages.push(text), run: async () => { throw new Error('must not run'); } });
  assert.deepEqual(result.outcomes.map((item) => item.status), ['skipped', 'skipped', 'skipped']);
  assert.equal(result.exitCode, 0);
  assert.match(messages.join('\n'), /--vscode=setup/);
});
test('optional failure preserves Mac success and continues to Codex through lifecycle coordination', async () => {
  const calls = [];
  const result = await setupIntegrations({ appPath, choices: { chrome: 'skip', vscode: 'setup', codex: 'setup' }, write: () => {}, run: async (command, args) => {
    calls.push([command, args]);
    assert.equal(command, `${appPath}/Contents/MacOS/placekeeper`);
    assert.deepEqual(args.slice(0, 2), ['daemon', 'coordinate-host']);
    if (args.at(-1) === 'vscode') throw new Error('VS Code CLI failed');
    return { stdout: '{"host":"codex","status":"pending","message":"Start a new task"}\n{"ok":true,"status":"installed"}\n' };
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.mac, 'installed');
  assert.deepEqual(result.outcomes.map((item) => item.status), ['skipped', 'failed', 'pending']);
  assert.equal(result.exitCode, 3);
});
test('host deferral is pending close-and-retry, not a false completion', async () => {
  const result = await setupIntegrations({ appPath, choices: { chrome: 'setup', vscode: 'skip', codex: 'skip' }, write: () => {}, run: async () => { throw Object.assign(new Error('active review'), { code: 2 }); } });
  assert.equal(result.outcomes[0].status, 'pending');
  assert.match(result.outcomes[0].message, /Close.*retry/);
  assert.equal(result.exitCode, 0);
});
test('Codex unavailable offers the installed marketplace path without claiming enabled', async () => {
  const result = await setupCodex({ appPath, codexPath: '/missing/codex', run: async () => { throw new Error('ENOENT'); } });
  assert.equal(result.status, 'pending');
  assert.match(result.message, /marketplace/);
  assert.match(result.message, /new task/);
  assert.ok(result.path.startsWith(appPath));
});
test('Codex probes all supported commands before mutation and preserves unrelated marketplaces', async () => {
  const calls = [];
  const result = await setupCodex({ appPath, codexPath: '/fake/codex', run: async (_command, args) => {
    calls.push(args);
    if (args.includes('--help')) return { stdout: 'Usage: codex plugin marketplace add list --json --marketplace' };
    if (args[1] === 'marketplace' && args[2] === 'list') return { stdout: JSON.stringify({ marketplaces: [{ name: 'placekeeper-local', root: '/user/source' }] }) };
    if (args[1] === 'list') return { stdout: JSON.stringify({ installed: [{ pluginId: 'codex-plugin@placekeeper-installed', installed: true, enabled: true }] }) };
    return { stdout: '{}' };
  } });
  assert.equal(result.status, 'pending');
  assert.equal(calls.filter((args) => args.includes('--help')).length, 4);
  assert.ok(calls.some((args) => args.includes('codex-plugin@placekeeper-installed')));
  assert.ok(!calls.some((args) => args.includes('remove')));
});
test('Codex refuses a conflicting installed-marketplace source', async () => {
  const result = await setupCodex({ appPath, codexPath: '/fake/codex', run: async (_command, args) => {
    if (args.includes('--help')) return { stdout: 'Usage: --json --marketplace' };
    assert.equal(args[2], 'list');
    return { stdout: JSON.stringify({ marketplaces: [{ name: 'placekeeper-installed', root: '/unrelated' }] }) };
  } });
  assert.equal(result.status, 'pending');
  assert.match(result.message, /different source/);
});
test('a rerun can skip Chrome and add VS Code while retaining actual current Mac status', async () => {
  const calls = [];
  const result = await setupIntegrations({ appPath, macStatus: 'current', choices: { chrome: 'skip', vscode: 'setup', codex: 'skip' }, write: () => {}, run: async (_command, args) => {
    calls.push(args.at(-1));
    return { stdout: '{"host":"vscode","status":"pending","message":"Reload VS Code"}\n{"ok":true,"status":"installed"}\n' };
  } });
  assert.deepEqual(calls, ['vscode']);
  assert.equal(result.mac, 'current');
  assert.equal(result.exitCode, 0);
});
test('a coordinator success envelope alone never establishes host completion', async () => {
  const result = await setupIntegrations({ appPath, choices: { chrome: 'setup', vscode: 'skip', codex: 'skip' }, write: () => {}, run: async () => ({ stdout: '{"ok":true,"status":"installed"}\n' }) });
  assert.equal(result.outcomes[0].status, 'failed');
  assert.equal(result.exitCode, 3);
});
test('Codex preserves an existing disabled plugin without invoking installation commands', async () => {
  const mutations = [];
  const result = await setupCodex({ appPath, codexPath: '/fake/codex', run: async (_command, args) => {
    if (args.includes('--help')) return { stdout: 'Usage: --json --marketplace' };
    if (args.includes('add')) mutations.push(args);
    if (args[1] === 'marketplace') return { stdout: JSON.stringify({ marketplaces: [{ name: 'placekeeper-installed', marketplaceSource: { sourceType: 'local', source: `${appPath}/Contents/Resources/integrations` } }] }) };
    return { stdout: JSON.stringify({ installed: [{ pluginId: 'codex-plugin@placekeeper-installed', installed: true, enabled: false }] }) };
  } });
  assert.deepEqual(mutations, []);
  assert.equal(result.status, 'pending');
  assert.match(result.message, /state was preserved/);
});
test('Codex rejects an unverifiable plugin install rather than claiming completion', async () => {
  await assert.rejects(setupCodex({ appPath, codexPath: '/fake/codex', run: async (_command, args) => {
    if (args.includes('--help')) return { stdout: 'Usage: --json --marketplace' };
    if (args[1] === 'marketplace' && args[2] === 'list') return { stdout: '{"marketplaces":[]}' };
    if (args[1] === 'list') return { stdout: '{"installed":[]}' };
    return { stdout: '{}' };
  } }), /did not confirm/);
});
test('actual installed helper with no controlling terminal exits without prompting or host access', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [resolve('packaging/macos/setup-integrations.mjs'), appPath], { detached: true, timeout: 5_000 });
  assert.match(stdout, /No terminal was available/);
  assert.match(stdout, /Chrome: skipped/);
  assert.match(stdout, /VS Code: skipped/);
  assert.match(stdout, /Codex: skipped/);
});
test('bundled marketplace resolves its plugin relative to the installed source after checkout deletion', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'placekeeper-marketplace-test-'));
  const source = resolve(root, 'temporary-release');
  const installed = resolve(root, 'Placekeeper.app/Contents/Resources/integrations');
  try {
    await mkdir(resolve(source, '.agents/plugins'), { recursive: true });
    await cp(resolve('packaging/macos/codex-marketplace.json'), resolve(source, '.agents/plugins/marketplace.json'));
    await cp(resolve('integrations/codex-plugin'), resolve(source, 'codex-plugin'), { recursive: true });
    await cp(source, installed, { recursive: true });
    await rm(source, { recursive: true });
    const marketplace = JSON.parse(await readFile(resolve(installed, '.agents/plugins/marketplace.json'), 'utf8'));
    const plugin = JSON.parse(await readFile(resolve(installed, marketplace.plugins[0].source.path, '.codex-plugin/plugin.json'), 'utf8'));
    assert.equal(marketplace.name, 'placekeeper-installed');
    assert.equal(plugin.name, 'codex-plugin');
  } finally { await rm(root, { recursive: true, force: true }); }
});
