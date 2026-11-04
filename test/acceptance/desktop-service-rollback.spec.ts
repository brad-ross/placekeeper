import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLifecycleLock } from '../../apps/service/src/host/lifecycle-lock.js';
import { backupRecoveryAndVerify } from '../../apps/service/src/host/upgrade-coordinator.js';
import type { InstallationCommand } from '../../packaging/desktop/install-built-app.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rename, copyFile, lstat, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { installBuiltApp, runtimeRoot } from '../../packaging/desktop/install-built-app.mjs';
import { switchDesktopService } from '../../apps/service/src/cli/desktop-service-switch.js';
import { MANAGEMENT_PROTOCOL_VERSION, requestControl } from '../../apps/service/src/host/launch-control.js';
import type { CandidateDaemonReceipt, DaemonPaths } from '../../apps/service/src/host/service-daemon.js';
import { resolvePackagedRuntime, type PackagedRuntimeManifest } from '../../apps/service/src/platform/runtime-layout.js';
import { SessionBroker } from '../../apps/service/src/sessions/session-broker.js';
import type { RecoverableDraftV3 } from '../../apps/service/src/recovery/draft-snapshot.js';

const electronResources = process.env.PLACEKEEPER_ROLLBACK_ELECTRON_RESOURCES;
const previousDesktopResources = process.env.PLACEKEEPER_ROLLBACK_PREVIOUS_DESKTOP_RESOURCES;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

async function readManifest(root: string): Promise<PackagedRuntimeManifest> {
  const manifest = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8')) as PackagedRuntimeManifest;
  await resolvePackagedRuntime(root, manifest, manifest);
  expect(manifest.recovery?.readableDraftSchemaVersions).toContain(3);
  return manifest;
}

async function readProtectedDraft(directory: string): Promise<RecoverableDraftV3> {
  // Inspection remains read-only while the packaged service owns recovery.
  const envelope = JSON.parse(await readFile(join(directory, 'draft.json'), 'utf8')) as { checksum: string; payload: RecoverableDraftV3 };
  expect(createHash('sha256').update(JSON.stringify(envelope.payload)).digest('hex')).toBe(envelope.checksum);
  return envelope.payload;
}

// No default installation discovery is allowed for this qualification. Both
// roots are explicit, verified, newly built artifacts; all review state and
// daemon endpoints belong to the temporary directory created below.
test('packaged desktop to previous desktop to current desktop service rollback preserves acknowledged recovery', async ({}, testInfo) => {
  test.skip(!electronResources || !previousDesktopResources, 'Set PLACEKEEPER_ROLLBACK_ELECTRON_RESOURCES and PLACEKEEPER_ROLLBACK_PREVIOUS_DESKTOP_RESOURCES to newly built packaged resource roots.');
  test.setTimeout(90_000);
  const selectedElectron = await realpath(resolve(electronResources!));
  const selectedPrevious = await realpath(resolve(previousDesktopResources!));
  expect(selectedElectron).not.toBe(selectedPrevious);
  const electronManifest = await readManifest(selectedElectron);
  const previousManifest = await readManifest(selectedPrevious);
  expect((await stat(join(selectedPrevious, 'electron-web/electron.html'))).isFile()).toBe(true);
  expect((await stat(join(selectedElectron, 'electron-web/electron.html'))).isFile()).toBe(true);
  expect(previousManifest.installArtifactIdentity).not.toBe(electronManifest.installArtifactIdentity);
  const root = await mkdtemp(join(tmpdir(), 'placekeeper-service-rollback-'));
  const source = join(root, 'Disposable acknowledged review.pdf');
  await copyFile(resolve('test/fixtures/pdfs/multi-page-text.pdf'), source);
  const originalPdf = await readFile(source);
  const paths: DaemonPaths = {
    appSupportRoot: root,
    recoveryRoot: join(root, 'recovery'),
    socketPath: join(root, 'control.sock'),
    lifecycleLockPath: join(root, 'lifecycle.lock'),
    isolatedTestRoot: root,
    httpPort: await freePort(),
    webAssetsRoot: join(selectedElectron, 'web'),
  };
  expect(paths.appSupportRoot).toBe(paths.isolatedTestRoot);
  const seed = new SessionBroker({ recoveryRoot: paths.recoveryRoot });
  let sessionId = '';
  const acceptedComment = 'Accepted review content must survive both service switches.';
  const protectedText = 'Acknowledged editor input must survive the retained reader.';
  try {
    const opened = await seed.openReview({ pdfPath: source, surface: 'codex-native' });
    if (opened.kind !== 'opened') throw new Error('The disposable seed unexpectedly offered recovery');
    sessionId = opened.launch.sessionId;
    const timestamp = new Date().toISOString();
    const accepted = await seed.acceptMutation(sessionId, {
      type: 'add', expectedRevision: 0,
      item: {
        id: randomUUID(), kind: 'highlight', pageIndex: 0, createdAt: timestamp, updatedAt: timestamp,
        payload: { quote: 'rollback fixture', prefix: '', suffix: '', reliable: true, comment: acceptedComment,
          rect: { x: 72, y: 92, width: 80, height: 14 }, segmentRects: [{ x: 72, y: 92, width: 80, height: 14 }] },
      },
    });
    await seed.acceptMutation(sessionId, {
      type: 'put-draft', expectedRevision: accepted.revision, expectedDraftRevision: -1,
      draft: {
        id: randomUUID(), ownerViewId: 'rollback_fixture_view', baseGeneration: 1, revision: 0,
        kind: 'pageNote', pageIndex: 0, text: protectedText,
        anchor: { kind: 'page', pageIndex: 0, rect: { x: 100, y: 100, width: 20, height: 20 } },
        disposition: { kind: 'resolved', generation: 1 }, status: 'protected', createdAt: timestamp, updatedAt: timestamp,
      },
    });
  } finally { await seed.quiesceForShutdown(); }
  if (!sessionId) throw new Error("The disposable fixture was not acknowledged");
  const sessionDirectory = join(paths.recoveryRoot, sessionId);
  const acknowledged = await readProtectedDraft(sessionDirectory);
  expect(acknowledged.state.revision).toBe(2);
  expect(acknowledged.state.items[0]?.payload.comment).toBe(acceptedComment);
  expect(acknowledged.state.pendingDrafts[0]?.text).toBe(protectedText);
  const evidence: unknown[] = [{ event: 'accepted-fixture', root, sessionId: sessionId!, revision: acknowledged.state.revision }];
  let started = false;
  let previousPid: number | undefined;
  let primaryFailure: unknown;
  try {
    for (const [index, resources, manifest, label] of [
      [0, selectedElectron, electronManifest, 'electron-before'],
      [1, selectedPrevious, previousManifest, 'previous-desktop'],
      [2, selectedElectron, electronManifest, 'electron-after'],
    ] as const) {
      const backup = join(root, `recovery-backup-${index}`);
      const receiptPath = join(root, `readiness-${index}.json`);
      await test.step(`Select ${label} after drain, backup, and exact readiness`, async () => {
        await switchDesktopService({ resources, backup, receipt: receiptPath, paths });
        started = true;
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as CandidateDaemonReceipt;
        expect(receipt.daemonIdentity).toBe(manifest.daemonIdentity);
        expect(receipt.pid).not.toBe(previousPid);
        previousPid = receipt.pid;
        const status = await requestControl(paths.socketPath, { kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'status' });
        expect(status).toMatchObject({ kind: 'management', operation: 'status', status: {
          daemonIdentity: manifest.daemonIdentity, readinessToken: receipt.readinessToken, lifecycle: 'accepting',
        } });
        const copied = await readProtectedDraft(join(backup, sessionId!));
        expect(copied.state.revision).toBe(acknowledged.state.revision);
        expect(copied.state.items).toEqual(acknowledged.state.items);
        expect(copied.state.pendingDrafts).toEqual(acknowledged.state.pendingDrafts);
        expect(Date.parse(copied.acknowledgedAt)).toBeGreaterThanOrEqual(Date.parse(acknowledged.acknowledgedAt));
        if (copied.source.disposition !== 'local') throw new Error('The disposable source ownership unexpectedly changed');
        const snapshotRelative = relative(paths.recoveryRoot, copied.source.sourceSnapshotPath);
        expect(isAbsolute(snapshotRelative) || snapshotRelative.startsWith('..')).toBe(false);
        const copiedPdf = await readFile(join(backup, snapshotRelative));
        expect(createHash('sha256').update(copiedPdf).digest('hex')).toBe(copied.state.source.digest);
        evidence.push({ event: 'selected', label, manifestIdentity: manifest.installArtifactIdentity, receipt, backup });
      });
      await test.step(`${label} reads and resumes the same protected review`, async () => {
        const runtimeKind = 'electron-runtime';
        const appControlKind = 'electron-app-control';
        const appInstanceId = `app_rollback_reader_${index}`;
        const helperId = `helper_rollback_reader_${index}`;
        const envelope = { protocolVersion: 1, windowId: `window_rollback_reader_${index}`, attemptId: `attempt_rollback_reader_${index}` };
        const registration = await requestControl(paths.socketPath, { kind: appControlKind, message: {
          protocolVersion: 1, type: 'register-app', appInstanceId, processId: process.pid,
          startIdentity: `start_rollback_reader_${index}`, buildIdentity: manifest.installArtifactIdentity,
        } });
        expect(registration).toMatchObject({ kind: appControlKind, response: { type: 'ack' } });
        try {
          // Native admission avoids minting an unused browser bootstrap, which
          // would correctly keep the incumbent busy during the next switch.
          const offer = await requestControl(paths.socketPath, { kind: runtimeKind, appInstanceId, helperId,
            message: { ...envelope, type: 'admit', requestId: `request_rollback_offer_${index}`, sourcePath: source } });
          if (offer.kind !== 'electron-runtime' || offer.response.type !== 'recovery-offered') throw new Error(`Expected preserved native recovery in ${label}: ${JSON.stringify(offer)}`);
          const resumed = await requestControl(paths.socketPath, { kind: runtimeKind, appInstanceId, helperId,
            message: { ...envelope, type: 'recover', requestId: `request_rollback_resume_${index}`,
              decision: 'resume', offer: offer.response.offer, idempotencyKey: randomUUID() } });
          expect(resumed).toMatchObject({ kind: runtimeKind, response: { type: 'admitted', projection: {
            sessionId: sessionId!, generation: 1, revision: acknowledged.state.revision,
            state: { items: acknowledged.state.items, pendingDrafts: acknowledged.state.pendingDrafts },
          } } });
          const released = await requestControl(paths.socketPath, { kind: runtimeKind, appInstanceId, helperId,
            message: { ...envelope, type: 'release', requestId: `request_rollback_release_${index}` } });
          expect(released).toMatchObject({ kind: runtimeKind, response: { type: 'released' } });
        } finally {
          const detached = await requestControl(paths.socketPath, { kind: appControlKind,
            message: { protocolVersion: 1, type: 'detach', appInstanceId, reason: 'controlled-exit' } });
          expect(detached).toMatchObject({ kind: appControlKind, response: { type: 'ack' } });
        }
        const idleStatus = await requestControl(paths.socketPath, { kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'status' });
        evidence.push({ event: 'native-reader-detached', label, status: idleStatus });
        expect(idleStatus).toMatchObject({ kind: 'management', operation: 'status', status: { activity: { reviewPresence: 0, codexTasks: 0, transientWork: 0 } } });
        const current = await readProtectedDraft(sessionDirectory);
        expect(current.state.revision).toBe(acknowledged.state.revision);
        expect(current.state.workflow.documentGeneration).toBe(acknowledged.state.workflow.documentGeneration);
        expect(current.state.items).toEqual(acknowledged.state.items);
        expect(current.state.pendingDrafts).toEqual(acknowledged.state.pendingDrafts);
        expect(Date.parse(current.acknowledgedAt)).toBeGreaterThanOrEqual(Date.parse(acknowledged.acknowledgedAt));
        expect(await readFile(source)).toEqual(originalPdf);
        evidence.push({ event: 'resumed', label, revision: current.state.revision, acceptedItems: current.state.items.length, protectedDrafts: current.state.pendingDrafts.length });
      });
    }
  } catch (error) {
    primaryFailure = error;
    evidence.push({ event: 'qualification-failed', message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    try {
      if (started) {
        // Only this test's explicit endpoint is eligible for retirement. A
        // refused shutdown is retained as a failure, never replaced by kill.
        let shutdown;
        try {
          shutdown = await requestControl(paths.socketPath, { kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'shutdown-if-idle' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (shutdown !== undefined) {
          evidence.push({ event: 'cleanup-shutdown', response: shutdown });
          expect(shutdown).toMatchObject({ kind: 'management', operation: 'shutdown-if-idle', result: { status: 'accepted' } });
          await expect.poll(() => lstat(paths.socketPath).then(() => false, (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return true;
            throw error;
          }), { timeout: 5_000 }).toBe(true);
        }
      }
    } catch (cleanupError) {
      evidence.push({ event: 'cleanup-failed', message: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) });
      if (primaryFailure === undefined) throw cleanupError;
    } finally {
      const evidencePath = join(root, 'rollback-evidence.json');
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      await testInfo.attach('service-rollback-evidence', { path: evidencePath, contentType: 'application/json' });
      await testInfo.attach('protected-recovery-after', { path: join(sessionDirectory, 'draft.json'), contentType: 'application/json' });
    }
  }
});


// This exercises the actual installed Electron entrypoint. Removing its real
// HTML asset lets the exact service start while renderer startup must fail.
test('installed candidate service success with renderer failure retires candidate before restoring the retained app', async ({}, testInfo) => {
  test.skip(!electronResources || !previousDesktopResources, 'Provide both explicit newly built packaged resource roots.');
  test.setTimeout(120_000);
  const selected = await realpath(resolve(electronResources!));
  const retained = await realpath(resolve(previousDesktopResources!));
  const previousIdentity = (await readManifest(retained)).installArtifactIdentity;
  const appRoot = (resources: string) => resolve(resources, process.platform === 'darwin' ? '../../..' : '../..');
  const root = await mkdtemp(process.platform === 'darwin' ? '/tmp/pk-shell-' : join(tmpdir(), 'pk-shell-'));
  const candidate = join(root, 'candidate'), installed = join(root, 'installed');
  await cp(appRoot(selected), candidate, { recursive:true, verbatimSymlinks:true });
  await cp(appRoot(retained), installed, { recursive:true, verbatimSymlinks:true });
  const brokenHtml = join(runtimeRoot(candidate), 'electron-web/electron.html');
  await rename(brokenHtml, `${brokenHtml}.unavailable`);
  const state = join(root, 'state'); await mkdir(join(state,'recovery'), { recursive:true });
  const sentinel = join(state, 'recovery', 'newer-user-work.txt'); await writeFile(sentinel, 'canonical protected work');
  const paths: DaemonPaths = { appSupportRoot:state, recoveryRoot:join(state,'recovery'), socketPath:join(state,'control.sock'), lifecycleLockPath:join(state,'lifecycle.lock'), isolatedTestRoot:state, webAssetsRoot:join(runtimeRoot(candidate),'web'), httpPort:await freePort() };
  const backup = join(state, 'verified-backup');
  const launcher = process.platform === 'darwin' ? join(installed,'Contents/MacOS/placekeeper') : join(runtimeRoot(installed),'bin',`placekeeper${process.platform === 'win32' ? '.exe' : ''}`);
  try {
  const startupError = await switchDesktopService({ resources:runtimeRoot(candidate), backup, receipt:join(state,'coordinator-ready.json'), paths,
    replaceAndReady: token => installBuiltApp(candidate, installed, launcher, String(paths.httpPort), undefined, state, { lockPath:paths.lifecycleLockPath!, lockToken:token, backupRoot:backup }).then(()=>undefined),
  }).then(() => undefined, (error: Error & {stderr?:string;stdout?:string}) => error);
  const failureLog = startupError ? `${startupError.stack}\n${startupError.stderr ?? ''}\n${startupError.stdout ?? ''}` : 'No startup failure was observed';
  await testInfo.attach('installed-shell-failure-command',{body:failureLog,contentType:'text/plain'});
  expect(startupError, failureLog).toBeDefined();
  expect(startupError!.message, failureLog).toMatch(/PlacekeeperDesktop/u);
  expect((await readManifest(runtimeRoot(installed))).installArtifactIdentity).toBe(previousIdentity);
  expect(await readFile(sentinel,'utf8')).toBe('canonical protected work');
  expect(await readFile(join(backup,'newer-user-work.txt'),'utf8')).toBe('canonical protected work');
  expect(await lstat(paths.socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;})).toBe(false);
  const journalParent = join(root,'.placekeeper-install-transactions');
  const [journalDirectory] = await readdir(journalParent);
  const journalPath = join(journalParent,journalDirectory!,'journal.json');
  const journal = JSON.parse(await readFile(journalPath,'utf8')); expect(journal.phase).toBe('restored');
  const loadFailure = JSON.parse(await readFile(`${journal.shellReceipt}.failure`,'utf8').catch(error => { throw new Error(`The installed renderer did not report its intended load failure. ${failureLog}`, {cause:error}); }));
  expect(loadFailure).toMatchObject({version:1,attempt:journal.attempt,candidateIdentity:journal.candidateIdentity,url:'placekeeper-app://bundle/electron.html'});
  expect(['renderer-load','renderer-ready-timeout']).toContain(loadFailure.stage);
  await testInfo.attach('actual-renderer-load-failure',{path:`${journal.shellReceipt}.failure`,contentType:'application/json'});
  expect((await lstat(journal.failed)).isDirectory()).toBe(true);
  await testInfo.attach('shell-failure-activation-journal',{path:journalPath,contentType:'application/json'});

  await rename(`${brokenHtml}.unavailable`, brokenHtml);
  const successfulBackup = join(state, 'verified-backup-after-retry');
  await switchDesktopService({ resources:runtimeRoot(candidate), backup:successfulBackup, receipt:join(state,'retry-coordinator-ready.json'), paths,
    replaceAndReady: token => installBuiltApp(candidate, installed, launcher, String(paths.httpPort), undefined, state, { lockPath:paths.lifecycleLockPath!, lockToken:token, backupRoot:successfulBackup }).then(()=>undefined),
  });
  const completed = JSON.parse(await readFile(journalPath,'utf8'));
  expect(completed.phase).toBe('complete');
  const shellReceipt = JSON.parse(await readFile(completed.shellReceipt,'utf8'));
  const serviceReceipt = JSON.parse(await readFile(completed.receipt,'utf8'));
  const installedManifest = await readManifest(runtimeRoot(installed));
  expect(shellReceipt).toMatchObject({version:1,attempt:completed.attempt,candidateIdentity:installedManifest.installArtifactIdentity,rendererReady:true});
  expect(serviceReceipt.daemonIdentity).toBe(installedManifest.daemonIdentity);
  expect((await readManifest(runtimeRoot(completed.previous))).installArtifactIdentity).toBe(previousIdentity);
  expect(await readFile(sentinel,'utf8')).toBe('canonical protected work');
  await testInfo.attach('successful-installed-renderer-receipt',{path:completed.shellReceipt,contentType:'application/json'});
  await testInfo.attach('successful-activation-journal',{path:journalPath,contentType:'application/json'});
  } finally {
    // Cleanup uses only this test's explicit isolated management endpoint,
    // including when a receipt or retention assertion fails.
    if (await lstat(paths.socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;})) {
      await expect.poll(async()=>await requestControl(paths.socketPath,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'shutdown-if-idle'}),{timeout:5_000}).toMatchObject({kind:'management',operation:'shutdown-if-idle',result:{status:'accepted'}});
      await expect.poll(()=>lstat(paths.socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;}),{timeout:5_000}).toBe(false);
    }
  }

});


test('installed activation reentry retires the exact interrupted candidate before retrying with protected data intact', async ({}, testInfo) => {
  test.skip(!electronResources || !previousDesktopResources, 'Provide both explicit newly built packaged resource roots.');
  test.setTimeout(120_000);
  const selected = await realpath(resolve(electronResources!));
  const retained = await realpath(resolve(previousDesktopResources!));
  const previousIdentity = (await readManifest(retained)).installArtifactIdentity;
  const candidateIdentity = (await readManifest(selected)).installArtifactIdentity;
  const appRoot = (resources: string) => resolve(resources, process.platform === 'darwin' ? '../../..' : '../..');
  const root = await mkdtemp(process.platform === 'darwin' ? '/tmp/pk-reentry-' : join(tmpdir(), 'pk-reentry-'));
  const candidate = join(root,'candidate'), installed = join(root,'installed'), state = join(root,'state');
  await cp(appRoot(selected),candidate,{recursive:true,verbatimSymlinks:true});
  await cp(appRoot(retained),installed,{recursive:true,verbatimSymlinks:true});
  await mkdir(join(state,'recovery'),{recursive:true});
  const sentinel = join(state,'recovery','user-work.txt');
  await writeFile(sentinel,'protected before interrupted activation');
  const paths: DaemonPaths = { appSupportRoot:state,recoveryRoot:join(state,'recovery'),socketPath:join(state,'control.sock'),lifecycleLockPath:join(state,'lifecycle.lock'),isolatedTestRoot:state,webAssetsRoot:join(runtimeRoot(candidate),'web'),httpPort:await freePort() };
  const launcher = process.platform === 'darwin' ? join(installed,'Contents/MacOS/placekeeper') : join(runtimeRoot(installed),'bin',`placekeeper${process.platform === 'win32' ? '.exe' : ''}`);
  const firstBackup = join(state,'first-verified-backup');
  const journalPath = join(root,'.placekeeper-install-transactions',createHash('sha256').update(installed).digest('hex').slice(0,24),'journal.json');
  const execute = promisify(execFile);
  const interruptedInvoke: InstallationCommand = async (executable,args,options) => {
    const result = await execute(executable,args,options);
    if (options.env.PLACEKEEPER_STARTUP_REQUEST) throw Object.assign(new Error('simulated installer interruption'),{interrupted:true});
    return result;
  };
  let reentryLease: Awaited<ReturnType<typeof acquireLifecycleLock>> | undefined;
  try {
    await expect(switchDesktopService({resources:runtimeRoot(candidate),backup:firstBackup,receipt:join(state,'first-coordinator-receipt.json'),paths,
      replaceAndReady:token => installBuiltApp(candidate,installed,launcher,String(paths.httpPort),interruptedInvoke,state,{lockPath:paths.lifecycleLockPath!,lockToken:token,backupRoot:firstBackup}).then(()=>undefined),
    })).rejects.toThrow('simulated installer interruption');
    const interrupted = JSON.parse(await readFile(journalPath,'utf8'));
    expect(interrupted.phase).toBe('starting');
    const actualShellReceipt = JSON.parse(await readFile(interrupted.shellReceipt,'utf8'));
    const actualServiceReceipt = JSON.parse(await readFile(interrupted.receipt,'utf8'));
    expect(actualShellReceipt).toMatchObject({attempt:interrupted.attempt,candidateIdentity,rendererReady:true});
    const status = await requestControl(paths.socketPath,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'status'});
    expect(status).toMatchObject({kind:'management',operation:'status',status:{readinessToken:actualServiceReceipt.readinessToken,daemonIdentity:actualServiceReceipt.daemonIdentity}});
    await testInfo.attach('interrupted-real-shell-receipt',{path:interrupted.shellReceipt,contentType:'application/json'});
    await testInfo.attach('interrupted-activation-journal',{path:journalPath,contentType:'application/json'});
    // This isolates the second invocation without preemptively shutting down
    // its exact candidate or discarding the original receipt used by recovery.
    reentryLease = await acquireLifecycleLock(paths.lifecycleLockPath!);
    await writeFile(sentinel,'newer protected work after interruption');
    const reentryBackup = join(state,'reentry-verified-backup');
    await backupRecoveryAndVerify(paths.recoveryRoot,reentryBackup);
    const events: string[] = [];
    const reentryInvoke: InstallationCommand = async (executable,args,options) => {
      const result = await execute(executable,args,options);
      if (args[1] === 'stop-ready') {
        expect(args[3]).toBe(interrupted.receipt);
        expect((await readManifest(runtimeRoot(installed))).installArtifactIdentity).toBe(candidateIdentity);
        expect(await lstat(paths.socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;})).toBe(false);
        expect(()=>process.kill(actualServiceReceipt.pid,0)).toThrow();
        events.push('exact interrupted candidate retired');
      } else if (args[1] === 'ensure-ready') {
        expect(events).toEqual(['exact interrupted candidate retired']);
        events.push('replacement service ready');
      } else if (options.env.PLACEKEEPER_STARTUP_REQUEST) events.push('replacement renderer ready');
      return result;
    };
    const completed = await installBuiltApp(candidate,installed,launcher,String(paths.httpPort),reentryInvoke,state,{lockPath:paths.lifecycleLockPath!,lockToken:reentryLease.token,backupRoot:reentryBackup});
    expect(completed.phase).toBe('complete');
    expect(events).toEqual(['exact interrupted candidate retired','replacement service ready','replacement renderer ready']);
    expect((await readManifest(runtimeRoot(completed.previous))).installArtifactIdentity).toBe(previousIdentity);
    expect(await readFile(sentinel,'utf8')).toBe('newer protected work after interruption');
    expect(await readFile(join(firstBackup,'user-work.txt'),'utf8')).toBe('protected before interrupted activation');
    expect(await readFile(join(reentryBackup,'user-work.txt'),'utf8')).toBe('newer protected work after interruption');
    await testInfo.attach('completed-reentry-journal',{path:journalPath,contentType:'application/json'});
  } finally {
    try {
      if (await lstat(paths.socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;})) {
        await expect.poll(()=>requestControl(paths.socketPath,{kind:'management',protocolVersion:MANAGEMENT_PROTOCOL_VERSION,operation:'shutdown-if-idle'}),{timeout:5_000}).toMatchObject({kind:'management',operation:'shutdown-if-idle',result:{status:'accepted'}});
        await expect.poll(()=>lstat(paths.socketPath).then(()=>true,(error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return false;throw error;}),{timeout:5_000}).toBe(false);
      }
    } finally { await reentryLease?.release(); }
  }
});
