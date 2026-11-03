import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { configureZed, replaceZedFiles, setupZed } from './setup-zed.mjs';

const launcher = '/Applications/Placekeeper.app/Contents/MacOS/placekeeper';
const settings = `{
  // Keep my theme and TeX command.
  "theme": "One Dark",
  "lsp": {"texlab": {"settings": {"texlab": {"build": {
    "executable": "/custom/latexmk", "args": ["-pdf", "-outdir=output", "%f"],
    "onSave": false, "pdfDirectory": "output", "auxDirectory": "aux",
  }}}}}
}`;
const build = text => parse(text).lsp.texlab.settings.texlab.build;
test('preview preserves JSONC and compiler argv, is idempotent, and restores manual build behavior', () => {
  const preview = configureZed(settings, '[{"label":"My task","command":"echo"}]', { launcher, mode: 'preview' });
  assert.match(preview.settings, /Keep my theme/);
  assert.equal(parse(preview.settings).theme, 'One Dark');
  assert.deepEqual(build(preview.settings).args, ['zed-build', '/custom/latexmk', '-pdf', '-outdir=output', '%f']);
  assert.deepEqual(parse(preview.settings).lsp.texlab.settings.texlab.forwardSearch, { executable: launcher, args: ['view-source', '--editor', 'zed', '--source', '%f', '--line', '%l', '--pdf', '%p', '--intent', 'preview'] });
  assert.equal(build(preview.settings).pdfDirectory, 'output');
  assert.equal(build(preview.settings).auxDirectory, 'aux');
  const again = configureZed(preview.settings, preview.tasks, { launcher, mode: 'preview', previousBuild: preview.previousBuild });
  assert.deepEqual(again, preview);
  const manual = configureZed(again.settings, again.tasks, { launcher, mode: 'manual', previousBuild: again.previousBuild });
  assert.deepEqual(build(manual.settings), { ...build(settings), forwardSearchAfter: false });
  assert.equal(parse(manual.tasks)[0].label, 'My task');
  const task = parse(manual.tasks)[1];
  assert.equal(task.env.PLACEKEEPER_PDF_DIR, 'output');
  assert.deepEqual(task.args, ['view-source', '--editor', 'zed', '--source', '"$PLACEKEEPER_SOURCE"', '--line', '"$PLACEKEEPER_LINE"', '--pdf-directory', '"$PLACEKEEPER_PDF_DIR"']);
});
test('legacy installed tasks migrate to the shared command and preserve unrelated JSONC', () => {
  const legacy = '[\n  // Keep my other task.\n  {"label":"Other","command":"echo"},\n  {"label":"Placekeeper: Forward SyncTeX","args":["zed-forward","manual"]}\n]';
  const updated = configureZed(settings, legacy, { launcher, mode: 'manual' });
  assert.match(updated.tasks, /Keep my other task/);
  assert.deepEqual(parse(updated.tasks)[0], { label: 'Other', command: 'echo' });
  assert.equal(parse(updated.tasks)[1].args[0], 'view-source');
  assert.deepEqual(configureZed(updated.settings, updated.tasks, { launcher, mode: 'manual' }), updated);
});
test('switching default preview to manual restores absent build overrides', () => {
  const preview = configureZed('{}', '[]', { launcher, mode: 'preview' });
  const manual = configureZed(preview.settings, preview.tasks, { launcher, mode: 'manual', previousBuild: preview.previousBuild });
  assert.deepEqual(build(manual.settings), { forwardSearchAfter: false });
  assert.equal(parse(manual.tasks)[0].env.PLACEKEEPER_PDF_DIR, '.');
});
test('malformed JSONC, unexpected shapes and conflicting user tasks fail before writes', () => {
  for (const text of ['{"lsp":', '[]', '{"lsp": false}', '{"lsp":{"texlab":{"settings":{"texlab":{"build":{"args":"shell"}}}}}}']) {
    assert.throws(() => configureZed(text, '[]', { launcher, mode: 'manual' }));
  }
  assert.throws(() => configureZed('{}', '[{"label":"Placekeeper: Forward SyncTeX","command":"user"}]', { launcher, mode: 'manual' }), /already uses/);
  assert.throws(() => configureZed('{}', '[{"label":"Placekeeper: Forward SyncTeX","args":["view-source","--editor","other"]}]', { launcher, mode: 'manual' }), /already uses/);
  assert.throws(() => configureZed('{}', '[]', { launcher, mode: 'bad' }), /mode/);
});
test('installed setup is private, works through symlinked settings, reruns and switches modes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'placekeeper-zed-'));
  try {
    const config = join(home, '.config');
    await mkdir(join(config, 'zed'), { recursive: true });
    const target = join(home, 'dotfile.json');
    await writeFile(target, settings);
    await symlink(target, join(config, 'zed/settings.json'));
    const options = { home, config, appPath: '/Applications/Placekeeper.app', candidates: [process.execPath] };
    assert.equal((await setupZed({ ...options, mode: 'preview' })).status, 'completed');
    const configPath = join(home, 'Library/Application Support/Placekeeper/zed/editor.json');
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(configPath)).sourceRoot, undefined);
    await setupZed({ ...options, mode: 'preview' });
    await setupZed({ ...options, mode: 'manual' });
    assert.equal(build(await readFile(target, 'utf8')).onSave, false);
    assert.equal(build(await readFile(target, 'utf8')).executable, '/custom/latexmk');
    await writeFile(target, '{bad');
    const before = await readFile(configPath, 'utf8');
    await assert.rejects(setupZed(options), /invalid JSON/);
    assert.equal(await readFile(configPath, 'utf8'), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('absent editor stays pending and concurrent settings edits are preserved', async () => {
  const home = await mkdtemp(join(tmpdir(), 'placekeeper-zed-'));
  try {
    assert.equal((await setupZed({ home, candidates: [], appPath: '/missing' })).status, 'pending');
    const path = join(home, 'settings.json');
    await writeFile(path, 'new user edit');
    await assert.rejects(replaceZedFiles([{ path, before: 'old', after: 'our edit' }]), /changed during setup/);
    assert.equal(await readFile(path, 'utf8'), 'new user edit');
    const first = join(home, 'first');
    await assert.rejects(replaceZedFiles([{ path: first, before: undefined, after: 'our edit' }, { path: first, before: undefined, after: 'second write' }]));
    await assert.rejects(readFile(first), /ENOENT/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
