import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyEdits, findNodeAtLocation, modify, parse, parseTree } from 'jsonc-parser';

const taskLabel = 'Placekeeper: Forward SyncTeX';
const texlab = ['lsp', 'texlab', 'settings', 'texlab'];
const build = [...texlab, 'build'];
const formattingOptions = { insertSpaces: true, tabSize: 2 };
function json(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error('Fix invalid JSON in Zed settings or tasks before running setup.');
  return value;
}
function set(text, path, value) {
  if (value === undefined && !findNodeAtLocation(parseTree(text), path)) return text;
  return applyEdits(text, modify(text, path, value, { formattingOptions }));
}
export function configureZed(settings, tasks, { launcher, mode, previousBuild }) {
  if (!['manual', 'preview'].includes(mode)) throw new Error('Zed mode must be manual or preview');
  const data = json(settings);
  const entries = json(tasks);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(entries)) throw new Error('Unexpected Zed settings or tasks format');
  for (const path of [texlab, build, [...texlab, 'forwardSearch']]) {
    for (let i = 1; i <= path.length; i++) {
      const value = path.slice(0, i).reduce((value, key) => value?.[key], data);
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Unexpected Zed Texlab settings format');
    }
  }
  const existing = data.lsp?.texlab?.settings?.texlab?.build ?? {};
  const wrapped = existing.args?.[0] === 'zed-build' && existing.executable?.endsWith('/Contents/MacOS/placekeeper');
  const executable = wrapped ? existing.args[1] : existing.executable;
  const argv = wrapped ? existing.args.slice(2) : existing.args;
  if ((executable !== undefined && typeof executable !== 'string') ||
    (argv !== undefined && (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')))) throw new Error('Invalid existing Texlab build command');
  if (previousBuild !== undefined && (!previousBuild || typeof previousBuild !== 'object' || Array.isArray(previousBuild))) throw new Error('Invalid saved Zed build settings; repair editor.json before setup');
  if (existing.pdfDirectory !== undefined && typeof existing.pdfDirectory !== 'string') throw new Error('Invalid Texlab PDF directory');
  const savedBuild = (wrapped ? previousBuild : undefined) ?? Object.fromEntries(['executable', 'args', 'onSave', 'forwardSearchAfter'].filter(key => Object.hasOwn(existing, key)).map(key => [key, existing[key]]));
  settings = set(settings, [...texlab, 'forwardSearch', 'executable'], launcher);
  settings = set(settings, [...texlab, 'forwardSearch', 'args'], ['zed-forward', 'preview', '%f', '%l', '%p']);
  settings = set(settings, [...build, 'forwardSearchAfter'], mode === 'preview');
  if (mode === 'preview') {
    settings = set(settings, [...build, 'onSave'], true);
    settings = set(settings, [...build, 'executable'], launcher);
    // Match the extension's default latexmk arguments when the user supplied none.
    settings = set(settings, [...build, 'args'], ['zed-build', executable || 'latexmk', ...(argv ??
      ['-e', '$pdf_mode = 1 unless $pdf_mode != 0; if ($ARGV[-1] =~ /\\.log$/ or $ARGV[-1] =~ /latexmkrc$/) { exit 0; };',
        '-interaction=nonstopmode', '-synctex=1', '%f'])]);
  } else if (wrapped) {
    settings = set(settings, [...build, 'executable'], previousBuild ? previousBuild.executable : executable);
    settings = set(settings, [...build, 'args'], previousBuild ? previousBuild.args : argv);
    if (previousBuild) settings = set(settings, [...build, 'onSave'], previousBuild.onSave);
  }
  const index = entries.findIndex(entry => entry?.label === taskLabel);
  if (index >= 0 && entries[index]?.args?.[0] !== 'zed-forward') throw new Error('A Zed user task already uses the Placekeeper task name. Rename it and retry.');
  const task = { label: taskLabel, command: '"$PLACEKEEPER_LAUNCHER"', args: ['zed-forward', 'manual', '"$PLACEKEEPER_SOURCE"', '"$PLACEKEEPER_LINE"', '"$PLACEKEEPER_PDF_DIR"'],
    env: { PLACEKEEPER_LAUNCHER: launcher, PLACEKEEPER_SOURCE: '$ZED_FILE', PLACEKEEPER_LINE: '$ZED_ROW', PLACEKEEPER_PDF_DIR: existing.pdfDirectory ?? '.' },
    save: 'none', reveal: 'never', hide: 'on_success' };
  tasks = set(tasks, [index >= 0 ? index : entries.length], task);
  json(settings); json(tasks);
  return { settings, tasks, ...(mode === 'preview' ? { previousBuild: savedBuild } : {}) };
}

async function read(path, fallback) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function replace(path, before, after) {
  if (before === after) return;
  await mkdir(dirname(path), { recursive: true });
  // Respect a symlinked dotfile rather than replacing its symlink.
  let dest = path, mode = 0o600;
  try { dest = await realpath(path); mode = (await lstat(dest)).mode & 0o777; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const tmp = dest + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, after, { flag: 'wx', mode });
    if (await read(path, undefined) !== before) throw new Error('Zed settings changed during setup. Retry setup.');
    await rename(tmp, dest);
  } finally { await rm(tmp, { force: true }); }
}

// Stage all content before mutation. On failure, restore only files still equal to
// our write, so a concurrent editor change is never overwritten by rollback.
export async function replaceZedFiles(files) {
  const completed = [];
  try {
    for (const file of files) {
      if (await read(file.path, undefined) !== file.before) throw new Error('Zed settings changed during setup. Retry setup.');
    }
    for (const file of files) {
      await replace(file.path, file.before, file.after);
      completed.push(file);
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const file of completed.reverse()) {
      try {
        if (await read(file.path, undefined) !== file.after) continue;
        if (file.before === undefined) await rm(file.path);
        else await replace(file.path, file.after, file.before);
      } catch { rollbackFailures.push(file.path); }
    }
    throw new Error(`${error.message}${rollbackFailures.length ? ` Partial setup remains in: ${rollbackFailures.join(', ')}.` : ' Setup changes were rolled back.'}`);
  }
}

export async function setupZed({ appPath, mode = 'manual', home = homedir(), config = process.env.XDG_CONFIG_HOME || join(home, '.config'), candidates }) {
  let cli;
  for (const candidate of candidates ?? ['/Applications/Zed.app/Contents/MacOS/cli', join(home, 'Applications/Zed.app/Contents/MacOS/cli'),
    ...(process.env.PLACEKEEPER_HOST_PATH || process.env.PATH || '').split(':').filter(Boolean).map(dir => resolve(dir, 'zed'))]) {
    try { await access(candidate, constants.X_OK); cli = await realpath(candidate); break; } catch {}
  }
  if (!cli) return { status: 'pending', message: 'Install Zed and its LaTeX extension, then retry Zed setup.' };
  if (!['manual', 'preview'].includes(mode)) throw new Error('Zed mode must be manual or preview');
  const root = join(config, 'zed');
  await mkdir(root, { recursive: true });
  const lockPath = join(root, '.placekeeper-setup.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another Zed setup is running. Retry when it finishes. If setup was interrupted, remove ${lockPath} and retry.`);
    throw error;
  }
  try {
    const settingsPath = join(root, 'settings.json'), tasksPath = join(root, 'tasks.json');
    const configPath = join(home, 'Library/Application Support/Placekeeper/zed/editor.json');
    const [settings, tasks, saved] = await Promise.all([read(settingsPath), read(tasksPath), read(configPath)]);
    let prior;
    try { prior = saved === undefined ? {} : JSON.parse(saved); }
    catch { throw new Error(`Fix invalid JSON in ${configPath} before running Zed setup.`); }
    if (!prior || typeof prior !== 'object' || Array.isArray(prior)) throw new Error(`Invalid Zed setup state in ${configPath}`);
    const updated = configureZed(settings ?? '{}', tasks ?? '[]', { launcher: join(appPath, 'Contents/MacOS/placekeeper'), mode, previousBuild: prior.previousBuild });
    await replaceZedFiles([
      { path: configPath, before: saved, after: JSON.stringify({ cli, ...(updated.previousBuild ? { previousBuild: updated.previousBuild } : {}) }) },
      { path: tasksPath, before: tasks, after: updated.tasks },
      { path: settingsPath, before: settings, after: updated.settings },
    ]);
    return { status: 'completed', message: 'Zed configured for ' + (mode === 'preview' ? 'jump after build' : 'jump on demand') + '. Install or enable Zed’s existing LaTeX extension. Open a TeX project and choose task: spawn → ' + taskLabel + '. Approve the source folder on first use.' };
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}
