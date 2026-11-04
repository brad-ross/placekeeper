import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedRoot, openState, runZed, takeBuild, bindOwner, chooseZedPath, runViewSource, chooseViewerPath, editorStateRoot, processIdentity } from '../../integrations/editors/zed-adapter.mjs';

const directories = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pk-zed-adapter-')));
  directories.push(temp);
  const root = join(temp, 'paper with spaces');
  const state = join(temp, 'state');
  mkdirSync(join(root, 'chapters'), { recursive: true });
  mkdirSync(join(root, 'output'));
  const source = join(root, 'chapters', 'included.tex');
  const pdf = join(root, 'output', 'main.pdf');
  writeFileSync(source, 'included');
  writeFileSync(pdf, '%PDF');
  writeFileSync(pdf.slice(0, -4) + '.synctex.gz', 'sync');
  const configPath = join(temp, 'editor.json');
  writeFileSync(configPath, JSON.stringify({ cli: '/Applications/Zed.app/Contents/MacOS/cli', previousBuild: {} }));
  return { temp, root, source, pdf, state, configPath, db: () => openState(state) };
}
function seed(f, session = 'session') {
  const db = f.db();
  db.prepare('INSERT INTO roots(root,session) VALUES (?,?)').run(f.root, session);
  db.close();
}
function buildRow(db, fence, { owner = 10, ready = 1, process = null } = {}) {
  db.prepare('INSERT INTO builds(owner,fence,ready,process) VALUES (?,?,?,?)').run(owner, fence, ready, process);
}
function options(f, overrides = {}) {
  return { launcher: '/Placekeeper.app/Contents/MacOS/placekeeper', owner: 10, ownerIdentity: 'test-owner', db: f.db(), configPath: f.configPath, ...overrides };
}
function arg(args, name) { return args[args.indexOf(name) + 1]; }

test('approved roots persist across processes and use private state permissions', async () => {
  const f = fixture();
  let db = f.db();
  assert.equal(await approvedRoot(db, f.source, async kind => { assert.equal(kind, 'folder'); return f.root; }), f.root);
  db.close();
  db = f.db();
  assert.equal(await approvedRoot(db, f.source, () => assert.fail('must not prompt again')), f.root);
  db.close();
  assert.equal(statSync(join(f.state, 'navigation.sqlite')).mode & 0o777, 0o600);
});

test('source symlinks cannot escape a previously approved root', async () => {
  const f = fixture();
  seed(f);
  const outside = join(f.temp, 'outside.tex');
  writeFileSync(outside, 'outside');
  const link = join(f.root, 'escape.tex');
  symlinkSync(outside, link);
  const db = f.db();
  await assert.rejects(approvedRoot(db, link, async () => f.root), /containing the source/);
  db.close();
});

test('included files discover project-relative outputs independently of process cwd and cache chosen PDFs', async () => {
  const f = fixture();
  seed(f);
  const calls = [];
  const run = async (_command, args) => { calls.push(args); return { stdout: '' }; };
  assert.equal(await runZed(['zed-forward', 'manual', f.source, '12', 'output'], options(f, { run, pick: () => assert.fail('unambiguous PDF must not prompt') })), 0);
  assert.equal(arg(calls[0], '--pdf'), f.pdf);
  assert.equal(arg(calls[0], '--source'), f.source);
  assert.equal(arg(calls[0], '--session'), 'session');
  // A remembered output works even when the next task has another output hint.
  assert.equal(await runZed(['zed-forward', 'manual', f.source, '13', 'missing'], options(f, { run, pick: () => assert.fail('cached PDF must not prompt') })), 0);
});

test('first navigation approves and registers the project once', async () => {
  const f = fixture();
  const calls = [];
  let approvals = 0;
  const run = async (_command, args) => {
    calls.push(args);
    return { stdout: args[1] === 'register' ? 'new-session\n' : '' };
  };
  await runZed(['zed-forward', 'manual', f.source, '3', 'output'], options(f, { run, pick: async () => { approvals++; return f.root; } }));
  assert.equal(approvals, 1);
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['editor', 'add'], ['editor', 'register'], ['forward-search', '--pdf']]);
  assert.equal(arg(calls.at(-1), '--session'), 'new-session');
  await runZed(['zed-forward', 'manual', f.source, '4', 'output'], options(f, { run, pick: () => assert.fail('no repeat approval') }));
  assert.equal(calls.length, 4);
});

test('daemon restart renews the stored session and retries without another approval', async () => {
  const f = fixture();
  seed(f, 'expired-session');
  const sessions = [];
  const run = async (_command, args) => {
    if (args[1] === 'register') return { stdout: 'renewed-session' };
    if (args[0] === 'forward-search') {
      sessions.push(arg(args, '--session'));
      if (sessions.length === 1) throw Object.assign(new Error('secret argv'), { stderr: 'Editor session expired; register the editor again' });
    }
    return { stdout: '' };
  };
  await runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, { run, pick: () => assert.fail('no approval after restart') }));
  assert.deepEqual(sessions, ['expired-session', 'renewed-session']);
  const db = f.db();
  assert.equal(db.prepare('SELECT session FROM roots').get().session, 'renewed-session');
  db.close();
});

test('concurrent renewal reuses a newly stored session instead of registering again', async () => {
  const f = fixture();
  seed(f, 'old');
  const sessions = [];
  const run = async (_command, args) => {
    assert.notEqual(args[1], 'register');
    sessions.push(arg(args, '--session'));
    if (sessions.length === 1) {
      const db = f.db(); db.prepare('UPDATE roots SET session=?').run('concurrently-renewed'); db.close();
      throw Object.assign(new Error('expired'), { stderr: 'Editor session expired' });
    }
    return { stdout: '' };
  };
  await runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, { run }));
  assert.deepEqual(sessions, ['old', 'concurrently-renewed']);
});

test('ambiguous PDFs ask once and preserve the chosen mapping for an included file', async () => {
  const f = fixture();
  seed(f);
  writeFileSync(join(f.root, 'other.pdf'), '%PDF');
  writeFileSync(join(f.root, 'other.synctex'), 'sync');
  let picks = 0;
  const pick = async kind => { assert.equal(kind, 'pdf'); picks++; return f.pdf; };
  const run = async () => ({ stdout: '' });
  await runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, { run, pick }));
  await runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, { run, pick }));
  assert.equal(picks, 1);
});

test('out-of-order callbacks cannot consume the newer fence and then reveal a stale fence as current', () => {
  const f = fixture();
  const db = f.db();
  buildRow(db, 'before-manual');
  buildRow(db, 'after-manual');
  assert.equal(takeBuild(db, 10), undefined);
  assert.equal(db.prepare('SELECT fence FROM builds').get().fence, 'before-manual');
  assert.equal(takeBuild(db, 10), 'before-manual'); // service rejects this old token
  assert.equal(takeBuild(db, 10), undefined);
  db.close();
});

test('pending builds participate in fence agreement; independent Texlab owners do not', () => {
  const f = fixture();
  const db = f.db();
  buildRow(db, 'old', { ready: 0, process: 456 });
  buildRow(db, 'new');
  buildRow(db, 'unrelated', { owner: 20 });
  assert.equal(takeBuild(db, 10, () => true), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM builds WHERE owner=10').get().count, 1);
  assert.equal(takeBuild(db, 20), 'unrelated');
  db.close();
});

test('killed pending wrappers remain tombstones until the Texlab owner restarts', () => {
  const f = fixture();
  const db = f.db();
  buildRow(db, 'old', { ready: 0, process: 99999 });
  buildRow(db, 'new');
  assert.equal(takeBuild(db, 10, () => false), undefined);
  buildRow(db, 'fresh');
  assert.equal(takeBuild(db, 10), undefined);
  bindOwner(db, 10, 'first-lifetime');
  bindOwner(db, 10, 'restarted-lifetime');
  buildRow(db, 'after-restart');
  assert.equal(takeBuild(db, 10), 'after-restart');
  db.close();
});

test('builds preserve executable arguments and exit status even when preview service is unavailable', async () => {
  const f = fixture();
  const argv = ['-e', '$pdf_mode=1', f.source];
  const code = await runZed(['zed-build', 'latexmk', ...argv], options(f, {
    run: async () => { throw new Error('daemon offline'); },
    build: async (executable, args) => { assert.equal(executable, 'latexmk'); assert.deepEqual(args, argv); return 7; },
  }));
  assert.equal(code, 7);
  const db = f.db();
  assert.equal(takeBuild(db, 10), null);
  db.close();
});

test('successful builds capture opaque CLI fence and previews use only their owner fence', async () => {
  const f = fixture();
  seed(f);
  const calls = [];
  const run = async (_command, args) => { calls.push(args); return { stdout: args[1] === 'preview-fence' ? 'opaque-fence\n' : '' }; };
  await runZed(['zed-build', 'latexmk', f.source], options(f, { run, build: async () => 0 }));
  await runZed(['zed-forward', 'preview', f.source, '5', f.pdf], options(f, { run }));
  const forward = calls.find(args => args[0] === 'forward-search');
  assert.equal(arg(forward, '--intent'), 'preview');
  assert.equal(arg(forward, '--association'), 'opaque-fence');
  assert.equal(await runZed(['zed-forward', 'preview', f.source, '5', f.pdf], options(f, { run: () => assert.fail('no captured build') })), 0);
});

test('superseded previews finish quietly without retry or session registration', async () => {
  const f = fixture(); seed(f);
  const db = f.db(); buildRow(db, 'stale-fence'); db.close();
  let calls = 0;
  assert.equal(await runZed(['zed-forward', 'preview', f.source, '5', f.pdf], options(f, {
    run: async () => { calls++; throw Object.assign(new Error('secret argv'), { stderr: 'Preview superseded by manual navigation' }); },
  })), 0);
  assert.equal(calls, 1);
});

test('subprocess errors never expose session capabilities through uncaught errors', async () => {
  const f = fixture(); seed(f, 'PRIVATE_SESSION_CAPABILITY');
  await assert.rejects(runZed(['zed-forward', 'manual', f.source, '5', 'output'], options(f, {
    run: async () => { throw Object.assign(new Error('Command failed --session PRIVATE_SESSION_CAPABILITY'), { stderr: 'PRIVATE_SESSION_CAPABILITY' }); },
  })), error => {
    assert.match(error.message, /Check the source folder, compiled PDF, and Zed setup/);
    assert.equal(String(error.stack).includes('PRIVATE_SESSION_CAPABILITY'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('overlapping compiler wrappers completing out of order preserve the oldest outstanding fence', async () => {
  const f = fixture();
  let finishFirst, finishSecond;
  const firstCompletion = new Promise(resolve => { finishFirst = resolve; });
  const secondCompletion = new Promise(resolve => { finishSecond = resolve; });
  const first = runZed(['zed-build', 'latexmk', f.source], options(f, {
    run: async () => ({ stdout: 'old-fence' }), build: () => firstCompletion,
  }));
  const second = runZed(['zed-build', 'latexmk', f.source], options(f, {
    run: async () => ({ stdout: 'new-fence' }), build: () => secondCompletion,
  }));
  finishSecond(0);
  await second;
  let db = f.db();
  assert.equal(takeBuild(db, 10, () => true), undefined);
  assert.equal(db.prepare('SELECT fence FROM builds').get().fence, 'old-fence');
  db.close();
  finishFirst(0);
  await first;
  db = f.db();
  assert.equal(takeBuild(db, 10), 'old-fence');
  db.close();
});

test('a state tracking failure does not prevent or change normal compilation', async () => {
  const f = fixture();
  const db = f.db();
  db.exec('DROP TABLE builds');
  assert.equal(await runZed(['zed-build', 'latexmk', f.source], options(f, {
    db, run: async () => ({ stdout: 'fence' }), build: async () => 9,
  })), 9);
});

test('simultaneous first registrations forward with one winning persisted handle', async () => {
  const f = fixture(); seed(f, null);
  let completeRegistration;
  const delayedRegistration = new Promise(resolve => { completeRegistration = resolve; });
  let registrationCount = 0;
  const forwardedSessions = [];
  const run = async (_command, args) => {
    if (args[1] === 'register') {
      registrationCount++;
      if (registrationCount === 1) return delayedRegistration;
      return { stdout: 'winning-session' };
    }
    if (args[0] === 'forward-search') forwardedSessions.push(arg(args, '--session'));
    return { stdout: '' };
  };
  const first = runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, { run }));
  // Both launchers reach an async registration before either can publish.
  const second = runZed(['zed-forward', 'manual', f.source, '3', 'output'], options(f, { run }));
  await second;
  completeRegistration({ stdout: 'losing-session' });
  await first;
  assert.equal(registrationCount, 2);
  assert.deepEqual(forwardedSessions, ['winning-session', 'winning-session']);
});

test('a successful build without a captured fence consumes its callback and later builds recover', async () => {
  const f = fixture();
  await runZed(['zed-build', 'latexmk', f.source], options(f, {
    run: async () => { throw new Error('service unavailable'); }, build: async () => 0,
  }));
  const db = f.db();
  assert.equal(takeBuild(db, 10), null);
  buildRow(db, 'fresh');
  assert.equal(takeBuild(db, 10), 'fresh');
  db.close();
});

test('owner start identity clears reused PID state and removes dead Texlab owners', () => {
  const f = fixture(); const db = f.db();
  bindOwner(db, 10, 'old-start');
  buildRow(db, 'stale');
  buildRow(db, 'dead-owner', { owner: 20 });
  bindOwner(db, 10, 'new-start', () => false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM builds').get().count, 0);
  buildRow(db, 'fresh');
  bindOwner(db, 10, 'new-start', () => true);
  assert.equal(takeBuild(db, 10), 'fresh');
  db.close();
});


test('native picker invokes the app executable with literal paths and cancellation stays quiet', async () => {
  const f = fixture();
  const executable = '/Placekeeper.app/Contents/MacOS/placekeeper';
  assert.equal(await chooseZedPath('folder', f.root, { executable, run: async (command, args) => {
    assert.equal(command, executable);
    assert.deepEqual(args, ['choose-source-folder', f.root]);
    return { stdout: JSON.stringify({ selected: f.root }) };
  } }), f.root);
  assert.equal(await runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, {
    run: async (command, args) => {
      assert.equal(command, executable);
      assert.deepEqual(args, ['choose-source-folder', join(f.root, 'chapters')]);
      return { stdout: JSON.stringify({ selected: null }) };
    },
  })), 0);
});


test('delayed failed-build callbacks cannot borrow later successful fences', async () => {
  const f = fixture();
  await runZed(['zed-build', 'latexmk', f.source], options(f, {
    run: async () => ({ stdout: 'before-manual' }), build: async () => 1,
  }));
  const db = f.db();
  buildRow(db, 'after-manual');
  assert.equal(takeBuild(db, 10), undefined);
  assert.equal(db.prepare('SELECT fence FROM builds').get().fence, null);
  buildRow(db, 'after-manual');
  assert.equal(takeBuild(db, 10), undefined);
  // Only when the unidentifiable final callback consumes the old failure can
  // later builds navigate again. The failure cannot borrow a new capture.
  assert.equal(takeBuild(db, 10), null);
  buildRow(db, 'fresh');
  assert.equal(takeBuild(db, 10), 'fresh');
  db.close();
});


function viewArgs(f, editor = 'custom-code', extra = []) {
  return ['view-source', '--editor', editor, '--source', f.source, '--line', '9', ...extra];
}

test('permanent viewer uses only the configured profile and remembers first-use project/PDF choices', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'other.pdf'), '%PDF');
  writeFileSync(join(f.root, 'other.synctex'), 'sync');
  const calls = [], picks = [];
  const run = async (_command, args) => {
    calls.push(args);
    assert.notEqual(args[1], 'add');
    return { stdout: args[1] === 'register' ? 'custom-session' : '' };
  };
  const pick = async kind => { picks.push(kind); return kind === 'folder' ? f.root : f.pdf; };
  await runViewSource(viewArgs(f, 'custom-code', ['--pdf-directory', 'output']), options(f, { run, pick }));
  await runViewSource(viewArgs(f), options(f, { run, pick: () => assert.fail('remembered choices') }));
  assert.deepEqual(picks, ['folder', 'pdf']);
  assert.equal(arg(calls[0], '--profile'), 'custom-code');
  assert.equal(arg(calls.at(-1), '--session'), 'custom-session');
  assert.equal(arg(calls.at(-1), '--pdf'), f.pdf);
});

test('profile and Neovim instance scopes require separate grants and retain separate sessions', async () => {
  const f = fixture(); seed(f, 'legacy-zed');
  let approvals = 0;
  const registrations = [], forwards = [];
  const run = async (_command, args) => {
    if (args[1] === 'register') {
      registrations.push([arg(args, '--profile'), args.includes('--socket') ? arg(args, '--socket') : null]);
      return { stdout: 'session-' + registrations.length };
    }
    forwards.push(arg(args, '--session'));
    return { stdout: '' };
  };
  const invoke = (editor, socket) => runViewSource(viewArgs(f, editor, ['--pdf', f.pdf, ...(socket ? ['--socket', socket] : [])]),
    options(f, { run, pick: async () => { approvals++; return f.root; } }));
  await invoke('custom-code'); await invoke('nvim', '/tmp/nvim-a'); await invoke('nvim', '/tmp/nvim-b');
  await invoke('nvim', '/tmp/nvim-a'); await invoke('custom-code');
  assert.equal(approvals, 3);
  assert.deepEqual(registrations, [['custom-code', null], ['nvim', '/tmp/nvim-a'], ['nvim', '/tmp/nvim-b']]);
  assert.deepEqual(forwards, ['session-1', 'session-2', 'session-3', 'session-2', 'session-1']);
});

test('permanent viewer renews an expired generic session without prompting again', async () => {
  const f = fixture(); let registrations = 0, attempts = 0;
  const run = async (_command, args) => {
    if (args[1] === 'register') return { stdout: 'session-' + (++registrations) };
    if (++attempts === 2) throw Object.assign(new Error('PRIVATE_SESSION'), { stderr: 'Editor session expired' });
    return { stdout: '' };
  };
  await runViewSource(viewArgs(f, 'custom', ['--pdf', f.pdf]), options(f, { run, pick: async () => f.root }));
  await runViewSource(viewArgs(f, 'custom', ['--pdf', f.pdf]), options(f, { run, pick: () => assert.fail('no renewal approval') }));
  assert.equal(registrations, 2); assert.equal(attempts, 3);
});

test('reserved zed alias reuses installed grants and build fences', async () => {
  const f = fixture(); seed(f, 'legacy-session');
  const db = f.db(); buildRow(db, 'captured-fence'); db.close();
  const calls = [];
  await runViewSource(viewArgs(f, 'zed', ['--pdf', f.pdf, '--intent', 'preview']), options(f, {
    run: async (_command, args) => { calls.push(args); return { stdout: '' }; }, pick: () => assert.fail('existing Zed grant'),
  }));
  assert.equal(arg(calls[0], '--session'), 'legacy-session');
  assert.equal(arg(calls[0], '--association'), 'captured-fence');
  assert.equal(arg(calls[0], '--intent'), 'preview');
});

test('permanent viewer validates all arguments before making calls and sanitizes subprocess errors', async () => {
  const f = fixture();
  for (const extra of [ ['--executable', '/tmp/evil'], ['--editor', 'again'], ['--line', '0'], ['--pdf', 'relative'], ['--socket', 'relative'], ['--intent', 'follow'], ['--intent'], ['--unknown', 'x'] ]) {
    await assert.rejects(runViewSource(viewArgs(f, 'custom', extra), options(f, {
      run: () => assert.fail('invalid args must not launch'), pick: () => assert.fail('invalid args must not prompt'),
    })), /source navigation failed/);
  }
  await assert.rejects(runViewSource(viewArgs(f, 'custom', ['--pdf', f.pdf]), options(f, {
    pick: async () => f.root,
    run: async () => { throw Object.assign(new Error('PRIVATE_SESSION_CAPABILITY'), { stderr: 'PRIVATE_SESSION_CAPABILITY' }); },
  })), error => !String(error.stack).includes('PRIVATE_SESSION_CAPABILITY') && error.cause === undefined);
});

test('source aliases retain SyncTeX spelling while canonical containment prevents escapes', async () => {
  const f = fixture(); seed(f);
  const alias = join(f.root, 'alias.tex'); symlinkSync(f.source, alias);
  const args = viewArgs({ ...f, source: alias }, 'zed', ['--pdf', f.pdf]);
  await runViewSource(args, options(f, { pick: () => assert.fail('approved canonical source'),
    run: async (_command, argv) => { assert.equal(arg(argv, '--source'), alias); return { stdout: '' }; } }));
  const outside = join(f.temp, 'outside.tex'); writeFileSync(outside, 'outside');
  const escape = join(f.root, 'escape.tex'); symlinkSync(outside, escape);
  await assert.rejects(runViewSource(viewArgs({ ...f, source: escape }, 'zed', ['--pdf', f.pdf]), options(f, {
    pick: async () => f.root, run: () => assert.fail('escape cannot forward'),
  })), /source navigation failed/);
});

test('generic native picker uses generic aliases and handles cancellation quietly', async () => {
  const f = fixture();
  await chooseViewerPath('pdf', f.root, { executable: '/installed/placekeeper', run: async (_command, args) => {
    assert.deepEqual(args, ['choose-source-pdf', f.root]); return { stdout: JSON.stringify({ selected: f.pdf }) };
  } });
  assert.equal(await runViewSource(viewArgs(f), options(f, { run: async (_command, args) => {
    assert.equal(args[0], 'choose-source-folder'); return { stdout: JSON.stringify({ selected: null }) };
  } })), 0);
});

test('chooser responses are bounded structured selections rather than raw authority', async () => {
  const f = fixture();
  await chooseViewerPath('folder', f.root, { executable: '/installed/placekeeper', run: async (_command, _args, options) => {
    assert.equal(options.timeout, 125000); assert.equal(options.maxBuffer, 16 * 1024);
    return { stdout: JSON.stringify({ selected: f.root }) };
  } });
  for (const stdout of [f.root, JSON.stringify({ selected: 'relative' }), JSON.stringify({ selected: f.root, executable: '/bin/sh' })]) {
    await assert.rejects(chooseViewerPath('folder', f.root, { executable: '/installed/placekeeper', run: async () => ({ stdout }) }));
  }
});

test('editor state follows each platform user-private application state location', () => {
  assert.equal(editorStateRoot({ platform: 'darwin', home: '/Users/brad', env: {} }), '/Users/brad/Library/Application Support/Placekeeper/zed');
  assert.equal(editorStateRoot({ platform: 'linux', home: '/home/brad', env: { XDG_STATE_HOME: '/state' } }), '/state/placekeeper/zed');
  assert.equal(editorStateRoot({ platform: 'linux', home: '/home/brad', env: { XDG_STATE_HOME: 'relative' } }), '/home/brad/.local/state/placekeeper/zed');
  assert.equal(editorStateRoot({ platform: 'win32', home: 'C:\\Users\\brad', env: { LOCALAPPDATA: 'C:\\Users\\brad\\AppData\\Local' } }), 'C:\\Users\\brad\\AppData\\Local\\Placekeeper\\zed');
});

test('preview owner identities use native process start identities with bounded commands', async () => {
  assert.equal(await processIdentity(123, { platform: 'linux', read: path => path.endsWith('boot_id') ? 'boot\n' : '123 (texlab process) ' + ['S', ...Array(18).fill('0'), '987'].join(' ') }), 'boot:987');
  assert.equal(await processIdentity(123, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, run: async (command, args, options) => {
    assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.match(args.at(-1), /Get-Process -Id 123/u); assert.equal(options.timeout, 5000);
    return { stdout: '12345678' };
  } }), '12345678');
});

test('unidentifiable preview owners cannot jump while manual navigation remains usable', async () => {
  const f = fixture(); seed(f);
  const unavailable = async () => { throw new Error('process start unavailable'); };
  assert.equal(await runZed(['zed-forward', 'preview', f.source, '2', f.pdf], options(f, { ownerIdentity: unavailable, run: () => assert.fail('uncertain preview cannot forward') })), 0);
  assert.equal(await runZed(['zed-forward', 'manual', f.source, '2', 'output'], options(f, { ownerIdentity: unavailable, run: async () => ({ stdout: '' }), pick: () => assert.fail('approved project does not prompt') })), 0);
});
