// Invoked by the installed launcher. Texlab gives its compiler and viewer the
// same parent process, but supplies no build identifier to the viewer callback.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const exec = promisify(execFile);
const profile = 'placekeeper-zed';
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
};
export function openState(directory = join(homedir(), 'Library/Application Support/Placekeeper/zed')) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'navigation.sqlite');
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS roots(root TEXT PRIMARY KEY, session TEXT);
    CREATE TABLE IF NOT EXISTS viewer_roots(scope TEXT, root TEXT, session TEXT, PRIMARY KEY(scope,root));
    CREATE TABLE IF NOT EXISTS viewer_outputs(scope TEXT, source TEXT, pdf TEXT NOT NULL, PRIMARY KEY(scope,source));
    CREATE TABLE IF NOT EXISTS owners(owner INTEGER PRIMARY KEY, identity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outputs(source TEXT PRIMARY KEY, pdf TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS builds(id INTEGER PRIMARY KEY, owner INTEGER, fence TEXT, ready INTEGER DEFAULT 0, process INTEGER);`);
  if (!db.prepare('PRAGMA table_info(builds)').all().some(column => column.name === 'process')) {
    db.exec('ALTER TABLE builds ADD COLUMN process INTEGER');
  }
  return db;
}

// Remove the newest completed build, but require ALL outstanding builds to
// agree. If two callbacks arrive out of order, the older fence survives until
// both callbacks have been consumed. A missing callback can only suppress a jump.
const isAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
export function takeBuild(db, owner, alive = isAlive) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // A killed wrapper cannot mark its build complete. Keep a lifetime
    // tombstone so an unidentifiable late callback cannot borrow another fence.
    for (const row of db.prepare('SELECT id, process FROM builds WHERE owner=? AND ready=0').all(owner)) {
      if (row.process && !alive(row.process)) db.prepare('UPDATE builds SET ready=-1, fence=NULL WHERE id=?').run(row.id);
    }
    const builds = db.prepare('SELECT * FROM builds WHERE owner=? ORDER BY id DESC').all(owner);
    const completed = builds.find(row => row.ready === 1);
    // Unknown canceled callbacks cannot be correlated. Retain tombstones for
    // this Texlab lifetime rather than letting a delayed callback borrow a
    // newer build's fence. A Texlab restart resets its owner identity.
    if (completed) db.prepare('DELETE FROM builds WHERE id=?').run(completed.id);
    const fence = completed && builds.every(row => row.fence === completed.fence) ? completed.fence : undefined;
    db.exec('COMMIT');
    return fence;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function bindOwner(db, owner, identity, alive = isAlive) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare('SELECT DISTINCT owner FROM builds WHERE owner!=?').all(owner)) {
      if (!alive(row.owner)) {
        db.prepare('DELETE FROM builds WHERE owner=?').run(row.owner);
        db.prepare('DELETE FROM owners WHERE owner=?').run(row.owner);
      }
    }
    const previous = db.prepare('SELECT identity FROM owners WHERE owner=?').get(owner)?.identity;
    if (previous !== undefined && previous !== identity) db.prepare('DELETE FROM builds WHERE owner=?').run(owner);
    db.prepare('INSERT OR REPLACE INTO owners(owner,identity) VALUES (?,?)').run(owner, identity);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
async function processIdentity(owner) {
  const value = (await exec('/bin/ps', ['-p', String(owner), '-o', 'lstart='])).stdout.trim();
  if (!value) throw new Error('Texlab owner process is unavailable');
  return value;
}

class SelectionCancelled extends Error {}
export async function chooseZedPath(kind, start, { executable, run = exec }) {
  try {
    const result = await run(executable, [kind === 'folder' ? '--zed-choose-folder' : '--zed-choose-pdf', start]);
    return realpathSync(result.stdout.replace(/\n$/u, ''));
  } catch (error) {
    if (error.code === 2) throw new SelectionCancelled();
    throw error;
  }
}
export async function approvedRoot(db, source, pick, scope) {
  const canonical = realpathSync(source);
  const roots = scope === undefined ? db.prepare('SELECT root FROM roots ORDER BY length(root) DESC').all()
    : db.prepare('SELECT root FROM viewer_roots WHERE scope=? ORDER BY length(root) DESC').all(scope);
  const existing = roots.find(({ root }) => inside(root, canonical));
  if (existing) return existing.root;
  const root = realpathSync(await pick('folder', dirname(canonical)));
  if (!statSync(root).isDirectory() || !inside(root, canonical) || root === dirname(root)) {
    throw new Error('Select the project folder containing the source file.');
  }
  if (scope === undefined) db.prepare('INSERT OR IGNORE INTO roots(root) VALUES (?)').run(root);
  else db.prepare('INSERT OR IGNORE INTO viewer_roots(scope,root) VALUES (?,?)').run(scope, root);
  return root;
}
async function manualPdf(db, source, root, pdfDirectory, pick, scope) {
  const previous = scope === undefined ? db.prepare('SELECT pdf FROM outputs WHERE source=?').get(source)?.pdf
    : db.prepare('SELECT pdf FROM viewer_outputs WHERE scope=? AND source=?').get(scope, source)?.pdf;
  if (previous && existsSync(previous)) return previous;
  const candidates = new Set();
  for (const directory of new Set([dirname(source), root, resolve(root, pdfDirectory || 'build')])) {
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.pdf$/iu.test(entry.name)) continue;
      const pdf = join(directory, entry.name);
      if (['.synctex', '.synctex.gz'].some(ext => existsSync(pdf.slice(0, -4) + ext))) candidates.add(pdf);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : pick('pdf', root);
}

async function compile(executable, argv) {
  return new Promise((done, fail) => {
    const child = spawn(executable, argv, { stdio: 'inherit', shell: false,
      env: { ...process.env, PATH: (process.env.PATH || '/usr/bin:/bin') + ':/Library/TeX/texbin' } });
    child.once('error', fail);
    child.once('exit', status => done(status ?? 1));
  });
}
export async function runZed(args, { launcher, owner, run = exec, pick, db,
  build = compile, alive = isAlive, ownerIdentity = processIdentity, configPath = join(homedir(), 'Library/Application Support/Placekeeper/zed/editor.json') }) {
  try {
    pick ??= (kind, start) => chooseZedPath(kind, start, { executable: join(dirname(launcher), 'PlacekeeperMac'), run });
    try { db ??= openState(); } catch (error) {
      if (args[0] !== 'zed-build') throw error;
      const [, executable, ...argv] = args;
      if (!executable || executable === launcher) throw new Error('Invalid Zed build command');
      return await build(executable, argv);
    }
    let tracked = true;
    try { bindOwner(db, owner, typeof ownerIdentity === 'function' ? await ownerIdentity(owner) : ownerIdentity, alive); }
    catch (error) { if (args[0] !== 'zed-build') throw error; tracked = false; }
    const call = async argv => (await run(launcher, argv, { maxBuffer: 64 * 1024 })).stdout.trim();
    if (args[0] === 'zed-build') {
      const [, executable, ...argv] = args;
      if (!executable || executable === launcher) throw new Error('Invalid Zed build command');
      let fence = null;
      // A preview failure must never prevent the user's normal compilation.
      try { fence = await call(['editor', 'preview-fence']) || null; } catch {}
      let id;
      try { if (tracked) id = db.prepare('INSERT INTO builds(owner,fence,process) VALUES (?,?,?)').run(owner, fence, process.pid).lastInsertRowid; } catch {}
      const finish = success => {
        if (id === undefined) return;
        try {
          if (success) db.prepare('UPDATE builds SET ready=1 WHERE id=?').run(id);
          else db.prepare('UPDATE builds SET ready=1, fence=NULL WHERE id=?').run(id);
        } catch {}
      };
      try {
        const code = await build(executable, argv);
        finish(code === 0);
        return code;
      } catch (error) { finish(false); throw error; }
    }

    const [, mode, file, line, destination] = args;
    if (args[0] !== 'zed-forward' || !['manual', 'preview'].includes(mode) || !file || !isAbsolute(file) ||
        !Number.isSafeInteger(Number(line)) || Number(line) < 1 || args.length > 5) throw new Error('Invalid Zed source location');
    const fence = mode === 'preview' ? takeBuild(db, owner, alive) : undefined;
    if (mode === 'preview' && !fence) return 0;
    return await navigate({ db, file, line, destination: mode === 'preview' ? destination : undefined,
      pdfDirectory: mode === 'manual' ? destination : undefined, pick, call, configPath, fence, editor: 'zed' });
  } catch (error) {
    if (error instanceof SelectionCancelled) return 0;
    // execFile errors include the entire argv (including session capabilities).
    // Never let those errors reach the launcher's uncaught-exception output.
    throw new Error('Placekeeper Zed integration failed. Check the source folder, compiled PDF, and Zed setup.');
  } finally { try { db?.close(); } catch {} }
}

async function navigate({ db, file, line, destination, pdfDirectory, pick, call, configPath, fence, editor, socket }) {
    // Keep the editor's lexical source spelling for SyncTeX, while approvedRoot
    // resolves symlinks before checking the grant's containment.
    const source = file;
    const selectedProfile = editor === 'zed' ? profile : editor;
    const scope = editor === 'zed' && !socket ? undefined : JSON.stringify([selectedProfile, socket ?? null]);
    const currentSession = root => scope === undefined
      ? db.prepare('SELECT session FROM roots WHERE root=?').get(root)?.session
      : db.prepare('SELECT session FROM viewer_roots WHERE scope=? AND root=?').get(scope, root)?.session;
    const root = await approvedRoot(db, source, pick, scope);
    const pdf = realpathSync(destination ?? await manualPdf(db, source, root, pdfDirectory, pick, scope));
    let session = currentSession(root);
    const register = async () => {
      const observed = currentSession(root);
      if (editor === 'zed') {
        const { cli } = JSON.parse(readFileSync(configPath, 'utf8'));
        await call(['editor', 'add', '--name', profile, '--executable', cli, '--args-json', '["{file}:{line}:{column}"]']);
      }
      const value = await call(['editor', 'register', '--profile', selectedProfile, '--source-root', root, ...(socket ? ['--socket', socket] : [])]);
      // Registration is asynchronous across launcher processes. Publish with
      // compare-and-swap so racing callers all forward using the winning handle.
      const updated = scope === undefined
        ? db.prepare('UPDATE roots SET session=? WHERE root=? AND session IS ?').run(value, root, observed)
        : db.prepare('UPDATE viewer_roots SET session=? WHERE scope=? AND root=? AND session IS ?').run(value, scope, root, observed);
      return updated.changes ? value : currentSession(root);
    };
    const forward = value => call(['forward-search', '--pdf', pdf, '--source', source, '--line', line, '--session', value,
      ...(fence ? ['--intent', 'preview', '--association', fence] : [])]);
    try { session ||= await register(); await forward(session); }
    catch (error) {
      if (String(error.stderr).includes('Preview superseded')) return 0;
      if (!session || !String(error.stderr).includes('Editor session expired')) throw error;
      const latest = currentSession(root);
      session = latest && latest !== session ? latest : await register();
      try { await forward(session); }
      catch (retry) { if (String(retry.stderr).includes('Preview superseded')) return 0; throw retry; }
    }
    if (scope === undefined) db.prepare('INSERT OR REPLACE INTO outputs(source,pdf) VALUES (?,?)').run(source, pdf);
    else db.prepare('INSERT OR REPLACE INTO viewer_outputs(scope,source,pdf) VALUES (?,?,?)').run(scope, source, pdf);
    return 0;
}

// Permanent installed viewer: callers can select a trusted profile, never an
// executable or argument template. The reserved zed alias retains old grants.
export async function runViewSource(args, options) {
  let db = options.db;
  try {
    const allowed = new Set(['--editor', '--source', '--line', '--pdf', '--pdf-directory', '--socket', '--intent']);
    const values = new Map();
    if (args[0] !== 'view-source') throw new Error('Invalid viewer command');
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!allowed.has(key) || values.has(key) || !value || value.includes('\0')) throw new Error('Invalid viewer option');
      values.set(key, value);
    }
    const editor = values.get('--editor'), file = values.get('--source'), line = values.get('--line');
    const destination = values.get('--pdf'), pdfDirectory = values.get('--pdf-directory'), socket = values.get('--socket');
    const intent = values.get('--intent') ?? 'explicit';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(editor ?? '') ||
        !file || !isAbsolute(file) || !/^[1-9][0-9]*$/u.test(line ?? '') || !Number.isSafeInteger(Number(line)) ||
        (destination !== undefined && !isAbsolute(destination)) || (socket !== undefined && !isAbsolute(socket)) ||
        !['explicit', 'preview'].includes(intent) || (intent === 'preview' && (editor !== 'zed' || !destination || socket))) {
      throw new Error('Invalid viewer source location');
    }
    const { launcher, run = exec, owner = process.ppid, alive = isAlive, ownerIdentity = processIdentity,
      configPath = join(homedir(), 'Library/Application Support/Placekeeper/zed/editor.json') } = options;
    db ??= openState();
    const call = async argv => (await run(launcher, argv, { maxBuffer: 64 * 1024 })).stdout.trim();
    let fence;
    if (intent === 'preview') {
      bindOwner(db, owner, typeof ownerIdentity === 'function' ? await ownerIdentity(owner) : ownerIdentity, alive);
      fence = takeBuild(db, owner, alive);
      if (!fence) return 0;
    }
    const pick = options.pick ?? ((kind, start) => chooseViewerPath(kind, start, {
      executable: join(dirname(launcher), 'PlacekeeperMac'), run }));
    return await navigate({ db, file, line, destination, pdfDirectory, socket, editor, configPath, call, pick, fence });
  } catch (error) {
    if (error instanceof SelectionCancelled) return 0;
    throw new Error('Placekeeper source navigation failed. Check the source folder, compiled PDF, and configured editor profile.');
  } finally { try { db?.close(); } catch {} }
}

export async function chooseViewerPath(kind, start, { executable, run = exec }) {
  try {
    const result = await run(executable, [kind === 'folder' ? '--choose-source-folder' : '--choose-source-pdf', start]);
    return realpathSync(result.stdout.replace(/\n$/u, ''));
  } catch (error) {
    if (error.code === 2) throw new SelectionCancelled();
    throw error;
  }
}
