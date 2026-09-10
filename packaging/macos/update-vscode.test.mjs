import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { updateVscode } from './update-vscode.mjs';
const exec = promisify(execFile);

test('app updates reinstall the bundled UI even when the extension version is unchanged', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'placekeeper-vscode-update-test-'));
  const source = resolve(root, 'Placekeeper.app/Contents/Resources/integrations/vscode');
  await mkdir(resolve(source, 'dist/web'), { recursive: true });
  await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'placekeeper-vscode', publisher: 'placekeeper-local', version: '0.1.1', engines: { vscode: '>=1.95.0' } }));
  await writeFile(resolve(source, 'dist/extension.cjs'), 'current extension');
  await writeFile(resolve(source, 'dist/web/app.js'), 'current shared interface');
  const calls = [];
  try {
    const result = await updateVscode({ appPath: resolve(root, 'Placekeeper.app'), codePath: '/fake/code', run: async (command, args, options) => {
      if (command !== '/fake/code') return exec(command, args, options);
      calls.push(args);
      if (args[0] === '--list-extensions') return { stdout: 'placekeeper-local.placekeeper-vscode@0.1.1\n' };
      assert.equal(args[2], '--force');
      const { stdout } = await exec('/usr/bin/unzip', ['-p', args[1], 'extension/dist/web/app.js']);
      assert.equal(stdout, 'current shared interface');
      const manifest = await exec('/usr/bin/unzip', ['-p', args[1], 'extension.vsixmanifest']);
      assert.match(manifest.stdout, /Microsoft.VisualStudio.Code/);
      return { stdout: 'installed' };
    } });
    assert.equal(result.status, 'updated');
    assert.equal(calls.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not enable a VS Code integration the user never installed', async () => {
  const result = await updateVscode({ appPath: '/unused', codePath: '/fake/code', run: async (_command, args) => {
    assert.equal(args[0], '--list-extensions');
    return { stdout: 'other.extension@1.0.0\n' };
  } });
  assert.equal(result.status, 'not-installed');
});

test('reports CLI failures instead of claiming the extension is current', async () => {
  await assert.rejects(updateVscode({ appPath: '/unused', codePath: '/fake/code', run: async () => { throw new Error('CLI unavailable'); } }), /CLI unavailable/);
});

test('repairs VS Code after an already-current app install without involving rollback or smoke', async () => {
  const installer = await readFile('install.sh', 'utf8');
  const replacement = await readFile('packaging/macos/install-built-app.sh', 'utf8');
  const coordination = installer.indexOf(' daemon coordinate-install ');
  const successBranch = installer.indexOf('\nfi\n', coordination);
  const update = installer.indexOf('"$repo_root/packaging/macos/update-vscode.mjs" "$app_path"');
  assert.ok(coordination >= 0 && successBranch > coordination && update > successBranch);
  assert.ok(update < installer.indexOf('Placekeeper installed successfully.'));
  assert.ok(!replacement.includes('update-vscode.mjs'));
});
