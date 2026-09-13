import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'vitest';
import { packageVscode, updateVscode } from './update-vscode.mjs';
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
    assert.equal(calls.length, 3);
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

test('explicit first installation is allowed and verified after supported CLI install', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'placekeeper-vscode-first-test-'));
  const source = resolve(root, 'Contents/Resources/integrations/vscode');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'placekeeper-vscode', publisher: 'placekeeper-local', version: '0.1.1', engines: { vscode: '>=1.95.0' } }));
  let installed = false;
  try {
    const result = await updateVscode({ appPath: root, codePath: '/fake/code', installIfMissing: true, run: async (command, args, options) => {
      if (command !== '/fake/code') return exec(command, args, options);
      if (args[0] === '--list-extensions') return { stdout: installed ? 'placekeeper-local.placekeeper-vscode@0.1.1' : '' };
      installed = true;
      return { stdout: 'installed' };
    } });
    assert.equal(result.status, 'installed');
    assert.equal(result.version, '0.1.1');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repairs selected integrations after app coordination using durable installed helpers', async () => {
  const installer = await readFile('install.sh', 'utf8');
  const replacement = await readFile('packaging/macos/install-built-app.sh', 'utf8');
  const coordination = installer.indexOf(' daemon coordinate-install ');
  const setup = installer.indexOf('/installer/setup-integrations.mjs');
  assert.ok(coordination >= 0 && setup > coordination);
  assert.ok(!replacement.includes('update-vscode.mjs'));
  assert.match(installer, /exit "\$coordination_status"/);
});

test('successful CLI exit without the installed version fails verification and removes staging', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'placekeeper-vscode-verify-test-'));
  const source = resolve(root, 'Contents/Resources/integrations/vscode');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'placekeeper-vscode', publisher: 'placekeeper-local', version: '0.1.1', engines: { vscode: '>=1.95.0' } }));
  let archive;
  try {
    await assert.rejects(updateVscode({ appPath: root, codePath: '/fake/code', installIfMissing: true, run: async (command, args, options) => {
      if (command !== '/fake/code') return exec(command, args, options);
      if (args[0] === '--list-extensions') return { stdout: '' };
      archive = args[1];
      return { stdout: 'installed' };
    } }), /did not report/);
    await assert.rejects(readFile(archive), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('packaging retains a valid manual VSIX after temporary staging is deleted', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'placekeeper-vscode-manual-test-'));
  const source = resolve(root, 'Contents/Resources/integrations/vscode');
  const outputPath = resolve(root, 'Contents/Resources/integrations/placekeeper.vsix');
  await mkdir(source, { recursive: true });
  await writeFile(resolve(source, 'package.json'), JSON.stringify({ name: 'placekeeper-vscode', publisher: 'placekeeper-local', version: '0.1.1', engines: { vscode: '>=1.95.0' } }));
  try {
    await packageVscode({ appPath: root, outputPath });
    await rm(source, { recursive: true });
    const { stdout } = await exec('/usr/bin/unzip', ['-p', outputPath, 'extension/package.json']);
    assert.equal(JSON.parse(stdout).name, 'placekeeper-vscode');
  } finally { await rm(root, { recursive: true, force: true }); }
});
