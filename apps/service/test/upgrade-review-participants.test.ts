import { expect, it, vi } from 'vitest';
import { DaemonLifecycleCoordinator } from '../src/host/daemon-lifecycle.js';
import { UpgradePreparationCoordinator } from '../src/host/upgrade-preparation.js';
import { UpgradeReviewParticipants } from '../src/host/upgrade-review-participants.js';

it('protects the final typed revision and leaves prepared peers attached until global commit', async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 2, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const coordinator = new UpgradePreparationCoordinator(lifecycle);
  const participants = new UpgradeReviewParticipants(coordinator);
  let revision = '1'; let durable = ''; let fail = false;
  participants.attach('browser:a', { revision: () => revision, protect: async () => { durable = revision; } });
  participants.attach('electron:b', { revision: () => '2', protect: async () => { if (fail) throw new Error('disk full'); } });
  coordinator.setParticipantCoverage(() => participants.has('browser:a') && participants.has('electron:b'));
  const preview = coordinator.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
  coordinator.begin(preview, true);
  revision = '3'; // Renderer close settlement flushes the final input before this request.
  await participants.settle('browser:a', { attemptId: preview.attemptId });
  expect(durable).toBe('3');
  expect(participants.poll('browser:a').phase).toBe('preparing');
  expect(participants.has('browser:a')).toBe(true);
  fail = true;
  await participants.settle('electron:b', { attemptId: preview.attemptId });
  expect(participants.poll('browser:a').phase).toBe('canceled');
  expect(participants.has('browser:a')).toBe(true);
});

it('ignores stale attempts, does not prepare on decline, and disconnect cancels readiness', async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const coordinator = new UpgradePreparationCoordinator(lifecycle);
  const participants = new UpgradeReviewParticipants(coordinator);
  let writes = 0;
  participants.attach('chrome:a', { revision: () => '1', protect: async () => { writes++; } });
  const candidate = { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) };
  const declined = coordinator.preview('development', candidate);
  coordinator.begin(declined, false);
  expect(participants.poll('chrome:a').phase).toBe('canceled');
  expect(writes).toBe(0);
  const accepted = coordinator.preview('development', candidate); coordinator.begin(accepted, true);
  await expect(participants.settle('chrome:a', { attemptId: declined.attemptId })).rejects.toThrow('Stale');
  expect(writes).toBe(0);
  await participants.settle('chrome:a', { attemptId: accepted.attemptId });
  participants.detach('chrome:a');
  expect(coordinator.status(accepted).phase).toBe('canceled');
});

it('waits for exact routes admitted at freeze while later status traffic remains independent', async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const first = lifecycle.enterActivity()!;
  lifecycle.freezeAdmission();
  let done = false;
  const barrier = lifecycle.settlementBarrier().then(() => { done = true; });
  const poll = lifecycle.enterActivity({ settlement: true })!;
  await Promise.resolve(); expect(done).toBe(false);
  first.complete(); await barrier;
  expect(done).toBe(true);
  expect(lifecycle.status().activity.transientWork).toBe(1);
  poll.complete();
});

it('uses live browser and editor connection ownership, requires idle desktop app settlement, and durably retains the final protected draft', async () => {
  const { mkdtemp, copyFile, rm, readFile, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const WebSocket = createRequire(new URL('../../vscode/package.json', import.meta.url))('ws');
  const { PlacekeeperHost } = await import('../src/host/placekeeper-host.js');
  const root = await mkdtemp(join(tmpdir(), 'pk-upgrade-hosts-'));
  const pdf = join(root, 'paper.pdf'); await copyFile('test/fixtures/pdfs/text-native.pdf', pdf);
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, 'recovery'), port: 0 });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  try {
    const views = [];
    for (const surface of ['browser', 'vscode'] as const) {
      const opened = await host.broker.openReview({ pdfPath: pdf, surface });
      if (opened.kind !== 'opened' && opened.kind !== 'focused') throw new Error('Expected live review');
      const sessionId = opened.launch.sessionId;
      const credential = host.broker.exchangeBootstrap(sessionId, opened.launch.fragment.slice('#cap='.length))!;
      const socket = new WebSocket(`${host.server.origin.replace('http:', 'ws:')}/s/${sessionId}/control`, ['placekeeper', `placekeeper-auth.${credential}`, `placekeeper-view.${randomUUID()}`], surface === 'browser' ? { origin: host.server.origin } : {});
      sockets.push(socket);
      const attachment = await new Promise<import('../src/sessions/review-interactions.js').ReviewInteractionAttachment>((resolve, reject) => {
        socket.once('error', reject); socket.once('message', (data: unknown) => resolve(JSON.parse(String(data)).attachment));
      });
      const post = async (path: string, body: unknown) => fetch(`${host.server.origin}/s/${sessionId}${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${credential}`, origin: host.server.origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      views.push({ sessionId, credential, attachment, socket, post });
    }
    const first = views[0]!; const editor = views[1]!;
    const appInstanceId = 'idle_upgrade_app_1234';
    await host.electronLifecycle.handle({ protocolVersion: 1, type: 'register-app', upgradePreparationVersion: 1, appInstanceId, processId: process.pid, startIdentity: 'start_upgrade_1234', buildIdentity: 'build_upgrade_1234' });
    const { pathToFileURL } = await import('node:url');
    const portId = 'upgrade_chrome_port'; const connectionId = 'upgrade_chrome_connection'; let chromeSequence = 0;
    const chrome = (message: object) => host.chromeRuntime.handle(portId, { protocolVersion: 2, connectionId, requestId: `upgrade_chrome_${++chromeSequence}`, ...message });
    expect(await host.chromeRuntime.handle(portId, { type: 'hello', protocol: 'placekeeper.chrome-runtime', protocolVersion: 2, reviewRuntimeVersion: 4, connectionId })).toMatchObject([{ type: 'hello-ack' }]);
    await chrome({ type: 'begin', lane: 'acquisition', transferId: 'upgrade_chrome_transfer', disposition: 'local', fileUrl: pathToFileURL(pdf).href });
    expect(await chrome({ type: 'finish', lane: 'acquisition', transferId: 'upgrade_chrome_transfer', sequence: 0 })).toMatchObject([{ type: 'projection' }]);
    expect(await chrome({ type: 'activate', lane: 'lifecycle', documentValidated: true })).toMatchObject([{ type: 'active' }]);
    const launch = await host.open({ pdfPath: pdf, surface: 'codex-native' });
    if (!launch.ok || !('handoff' in launch)) throw new Error('Expected Codex launch');
    expect(host.codexRuntime.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: launch.sessionId, documentGeneration: launch.documentGeneration, taskSessionId: 'upgrade_mixed_task' })).toBe(true);
    const display = host.codexRuntime.display(launch.handoff.token)!;
    expect(host.codexRuntime.attestDisplay(display.receipt, 'upgrade_mixed_task')).toBe(true);
    const meta = display.privateMeta;
    const active = await host.codexRuntime.pending({ protocolVersion: 1, runtimeId: meta.runtimeId, attemptId: meta.attemptId, requestId: randomUUID(), generation: meta.generation, capability: meta.pendingCapability, authority: 'pending', method: 'ready', payload: {} });
    if (active.status !== 'active') throw new Error('Expected Codex presentation');
    const codex = (method: 'upgradePoll' | 'upgradeSettle' | 'detach', payload: unknown) => host.codexRuntime.handle({ protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, capability: active.presentationCapability, authority: 'presentation', requestId: randomUUID(), method, payload });
    const candidate = { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) };
    host.upgradeParticipants.refresh();
    const declined = host.upgradePreparation.preview('development', candidate);
    host.upgradePreparation.begin(declined, false);
    expect(host.lifecycle.admissionAllowed()).toBe(true); expect(first.socket.readyState).toBe(WebSocket.OPEN);
    let attempt = host.upgradePreparation.preview('development', candidate);
    expect(attempt.participants.map(p => p.id.split(':')[0])).toEqual(expect.arrayContaining(['control', 'app', 'chrome', 'codex', 'task-authority']));
    host.upgradePreparation.begin(attempt, true); await host.prepareUpgradeTasks();
    let request = { attemptId: attempt.attemptId };
    // Same renderer close settlement path sends the just-typed Protected Draft before its acknowledgement.
    const now = new Date().toISOString();
    const command = { type: 'put-draft', expectedRevision: 0, expectedDraftRevision: -1, draft: {
      id: randomUUID(), ownerViewId: first.attachment.attachmentId, baseGeneration: 1, revision: 0,
      kind: 'highlight', pageIndex: 0, text: 'typed immediately before upgrade acceptance',
      anchor: { kind: 'selection', pageIndex: 0, quote: 'native', prefix: '', suffix: '', rect: { x: 10, y: 10, width: 20, height: 10 }, segmentRects: [{ x: 10, y: 10, width: 20, height: 10 }] },
      disposition: { kind: 'resolved', generation: 1 }, status: 'protected', createdAt: now, updatedAt: now,
    } };
    const mutation = await first.post('/commands', { command, attachment: first.attachment });
    expect(mutation.status).toBe(200);
    expect((await (await first.post('/upgrade/settle', { attachment: first.attachment, request })).json()).phase).toBe('preparing');
    expect(first.socket.readyState).toBe(WebSocket.OPEN); expect(editor.socket.readyState).toBe(WebSocket.OPEN);
    expect((await editor.post('/upgrade/settle', { attachment: first.attachment, request })).status).toBe(403);
    const failedProtection = vi.spyOn(host.broker, 'protectChromeReview').mockRejectedValueOnce(new Error('disk full'));
    expect((await (await editor.post('/upgrade/settle', { attachment: editor.attachment, request })).json()).phase).toBe('canceled');
    failedProtection.mockRestore();
    expect(first.socket.readyState).toBe(WebSocket.OPEN); expect(editor.socket.readyState).toBe(WebSocket.OPEN);
    expect(host.chromeRuntime.activity().connections).toBe(1); expect(host.codexRuntime.activityCount()).toBe(1);
    expect((await (await first.post('/upgrade/poll', { attachment: first.attachment })).json()).phase).toBe('canceled');
    host.upgradeParticipants.refresh();
    attempt = host.upgradePreparation.preview('development', candidate); host.upgradePreparation.begin(attempt, true); await host.prepareUpgradeTasks();
    request = { attemptId: attempt.attemptId };
    await first.post('/upgrade/settle', { attachment: first.attachment, request });
    expect((await (await editor.post('/upgrade/settle', { attachment: editor.attachment, request })).json()).phase).toBe('preparing');
    expect(await chrome({ type: 'invoke', lane: 'runtime', generation: 1, revision: 1, method: 'upgradeSettle', payload: request })).toMatchObject([{ type: 'result', payload: { phase: 'preparing' } }]);
    expect(await codex('upgradeSettle', request)).toMatchObject({ status: 'ok', payload: { phase: 'preparing' } });
    const status = await host.electronLifecycle.handle({ protocolVersion: 1, type: 'upgrade-settle', appInstanceId, request });
    expect(status).toMatchObject({ type: 'ack', upgrade: { phase: 'ready' } });
    const files = await readdir(join(root, 'recovery', first.sessionId));
    const text = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readFile(join(root, 'recovery', first.sessionId, file), 'utf8')));
    expect(text.join('\n')).toContain('typed immediately before upgrade acceptance');
    host.upgradePreparation.commit(attempt);
    await host.closeUpgradeAuthority();
    expect(host.broker.taskBindings.bindingForTask('upgrade_mixed_task')).toBeUndefined();
    expect(await codex('upgradePoll', {})).toMatchObject({ status: 'ok', payload: { phase: 'committed' } });
    expect(await host.codexRuntime.handle({ protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, capability: active.presentationCapability, authority: 'presentation', requestId: randomUUID(), method: 'scope', payload: {} })).toMatchObject({ status: 'denied', reason: 'revoked' });
    expect((await (await first.post('/upgrade/poll', { attachment: first.attachment })).json()).phase).toBe('committed');
    expect(host.codexRuntime.activityCount()).toBe(1); // Only the non-authorizing closure receipt remains.
    for (const socket of sockets) {
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve())); socket.close(); await closed;
    }
    await host.chromeRuntime.detach(portId);
    await host.electronLifecycle.eof(appInstanceId);
    // The ordinary browser disconnect grace remains authoritative during retirement.
    await new Promise(resolve => setTimeout(resolve, 5_050));
    const authorize = () => host.upgradePreparation.status(attempt).phase === 'committed';
    expect(await host.lifecycle.shutdownIfIdle({ authorize })).toMatchObject({ status: 'refused', activity: { reviewPresence: 1 } });
    expect(await codex('detach', {})).toMatchObject({ status: 'ok' });
    expect(host.codexRuntime.activityCount()).toBe(0);
    expect(await host.lifecycle.shutdownIfIdle({ authorize })).toEqual({ status: 'accepted' });

  } finally {
    for (const socket of sockets) socket.terminate();
    await host.close(); await rm(root, { recursive: true, force: true });
  }
}, 15_000);

it('re-proves a peer final revision, blocks later authoring, and invalidates unexpected committed review changes', async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const coordinator = new UpgradePreparationCoordinator(lifecycle);
  const participants = new UpgradeReviewParticipants(coordinator);
  let revision = '1';
  for (const id of ['electron:one', 'chrome:two']) participants.attach(id, { revision: () => revision, protect: async () => {} });
  const attempt = coordinator.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
  coordinator.begin(attempt, true);
  await participants.settle('electron:one', { attemptId: attempt.attemptId });
  expect(() => participants.assertAuthoring('electron:one')).toThrow('frozen');
  revision = '2';
  await participants.settle('chrome:two', { attemptId: attempt.attemptId });
  expect(participants.poll('electron:one').settlementRequired).toBe(true);
  await participants.settle('electron:one', { attemptId: attempt.attemptId });
  expect(coordinator.status(attempt).phase).toBe('ready');
  coordinator.commit(attempt);
  expect(() => participants.assertAuthoring('electron:one')).toThrow('frozen');
  revision = '3'; participants.refresh();
  expect(coordinator.status(attempt).phase).toBe('canceled');
});

it('cancels a document generation change instead of accepting it as a final input flush', async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const coordinator = new UpgradePreparationCoordinator(lifecycle); const participants = new UpgradeReviewParticipants(coordinator);
  let generation = 1;
  participants.attach('electron:one', { revision: () => `${generation}:0`, generation: () => generation, protect: async () => {} });
  const attempt = coordinator.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
  coordinator.begin(attempt, true); generation = 2;
  expect(participants.poll('electron:one').phase).toBe('canceled');
  expect(lifecycle.admissionAllowed()).toBe(true);
});

it('negotiates desktop participation without changing a legacy app acknowledgement', async () => {
  const { NativeAppLifecycleManager } = await import('../src/desktop/app-lifecycle.js');
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const participants = new UpgradeReviewParticipants(new UpgradePreparationCoordinator(lifecycle));
  const apps = new NativeAppLifecycleManager({ detach: async () => {} }); apps.upgradeParticipants = participants;
  const legacy = { protocolVersion: 1, type: 'register-app', appInstanceId: 'legacy_upgrade_app', processId: process.pid, startIdentity: 'legacy_start_identity', buildIdentity: 'legacy_build_identity' };
  expect(await apps.handle(legacy)).toEqual({ protocolVersion: 1, type: 'ack', appInstanceId: legacy.appInstanceId });
  expect(participants.has(`app:${legacy.appInstanceId}`)).toBe(false);
  expect(apps.upgradeCovered()).toBe(false);
  await apps.eof(legacy.appInstanceId);
  expect(await apps.handle({ ...legacy, appInstanceId: 'current_upgrade_app', upgradePreparationVersion: 1 })).toMatchObject({ type: 'ack', upgrade: { phase: 'none' } });
  expect(participants.has('app:current_upgrade_app')).toBe(true);
  await apps.close();
});

it('ignores an obsolete app settlement without killing the persistent app channel or acknowledging its successor', async () => {
  const { NativeAppLifecycleManager } = await import('../src/desktop/app-lifecycle.js');
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const coordinator = new UpgradePreparationCoordinator(lifecycle); const participants = new UpgradeReviewParticipants(coordinator);
  const apps = new NativeAppLifecycleManager({ detach: async () => {} }); apps.upgradeParticipants = participants;
  const appInstanceId = 'upgrade_stale_app';
  await apps.handle({ protocolVersion: 1, type: 'register-app', appInstanceId, processId: process.pid, startIdentity: 'upgrade_stale_start', buildIdentity: 'upgrade_stale_build', upgradePreparationVersion: 1 });
  const candidate = { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) };
  const old = coordinator.preview('development', candidate); coordinator.begin(old, true); coordinator.cancel(old);
  const settle = { protocolVersion: 1, type: 'upgrade-settle', appInstanceId, request: { attemptId: old.attemptId } };
  expect(await apps.handle(settle)).toMatchObject({ type: 'ack', upgrade: { phase: 'canceled' } });
  const next = coordinator.preview('development', candidate); coordinator.begin(next, true);
  expect(await apps.handle(settle)).toMatchObject({ type: 'ack', upgrade: { attemptId: next.attemptId, phase: 'preparing' } });
  expect(coordinator.status(next).participants.every(view => !view.acknowledged)).toBe(true);
  await apps.close();
});

it('returns control preparation status while an exact admitted operation drains in the background', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { PlacekeeperHost } = await import('../src/host/placekeeper-host.js');
  const { requestControl, startLaunchControlServer } = await import('../src/host/launch-control.js');
  const root = await mkdtemp(join(tmpdir(), 'pk-upgrade-drain-'));
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, 'recovery'), port: 0 });
  const identity = 'a'.repeat(64); const socket = join(root, 'control.sock');
  const control = await startLaunchControlServer(host, socket, { daemonIdentity: identity });
  const original = host.lifecycle.enterActivity()!;
  try {
    const attempt = host.upgradePreparation.preview(identity, { daemonIdentity: 'b'.repeat(64), installArtifactIdentity: 'c'.repeat(64) });
    expect(await requestControl(socket, { kind: 'upgrade-preparation', request: { operation: 'begin', credentials: attempt, consent: true } }, { timeoutMs: 1_000 })).toMatchObject({ result: { phase: 'preparing' } });
    expect(await requestControl(socket, { kind: 'upgrade-preparation', request: { operation: 'status', credentials: attempt } }, { timeoutMs: 1_000 })).toMatchObject({ result: { phase: 'preparing' } });
    original.complete(); await host.prepareUpgradeTasks();
    expect(host.upgradePreparation.status(attempt).phase).toBe('ready');
  } finally { original.complete(); await control.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('requires authenticated widget detach or an explicit trusted task end to release unknown Codex closure presence', async () => {
  const { mkdtemp, rm, copyFile } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os'); const { randomUUID } = await import('node:crypto');
  const { PlacekeeperHost } = await import('../src/host/placekeeper-host.js');
  const root = await mkdtemp(join(tmpdir(), 'pk-upgrade-task-end-')); const pdf = join(root, 'paper.pdf'); await copyFile('test/fixtures/pdfs/text-native.pdf', pdf);
  const host = await PlacekeeperHost.start({ recoveryRoot: join(root, 'recovery'), port: 0 });
  try {
    const launch = await host.open({ pdfPath: pdf, surface: 'codex-native' });
    if (!launch.ok || !('handoff' in launch)) throw new Error('Expected Codex launch');
    expect(host.codexRuntime.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: launch.sessionId, documentGeneration: launch.documentGeneration, taskSessionId: 'upgrade_ended_task' })).toBe(true);
    const display = host.codexRuntime.display(launch.handoff.token)!; expect(host.codexRuntime.attestDisplay(display.receipt, 'upgrade_ended_task')).toBe(true);
    const meta = display.privateMeta;
    const active = await host.codexRuntime.pending({ protocolVersion: 1, runtimeId: meta.runtimeId, attemptId: meta.attemptId, requestId: randomUUID(), generation: meta.generation, capability: meta.pendingCapability, authority: 'pending', method: 'ready', payload: {} });
    if (active.status !== 'active') throw new Error('Expected Codex presentation');
    host.upgradeParticipants.refresh();
    const attempt = host.upgradePreparation.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
    host.upgradePreparation.begin(attempt, true); await host.prepareUpgradeTasks();
    await host.codexRuntime.handle({ protocolVersion: 1, runtimeId: active.runtimeId, attemptId: active.attemptId, generation: active.generation, capability: active.presentationCapability, authority: 'presentation', requestId: randomUUID(), method: 'upgradeSettle', payload: { attemptId: attempt.attemptId } });
    host.upgradePreparation.commit(attempt); await host.closeUpgradeAuthority();
    expect(host.codexRuntime.activityCount()).toBe(1);
    expect(await host.lifecycle.shutdownIfIdle({ authorize: () => host.upgradePreparation.status(attempt).phase === 'committed' })).toMatchObject({ status: 'refused' });
    await host.codexRuntime.revokeTask('a_different_task'); expect(host.codexRuntime.activityCount()).toBe(1);
    await host.codexRuntime.revokeTask('upgrade_ended_task'); expect(host.codexRuntime.activityCount()).toBe(0);
    expect(await host.lifecycle.shutdownIfIdle({ authorize: () => host.upgradePreparation.status(attempt).phase === 'committed' })).toEqual({ status: 'accepted' });
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('accepts overlapping reproofs after a peer has made the same durable revision ready', async () => {
  const lifecycle = new DaemonLifecycleCoordinator({ activity: () => ({ reviewPresence: 0, codexTasks: 0, transientWork: 0 }), drain: async () => {} });
  const coordinator = new UpgradePreparationCoordinator(lifecycle);
  const participants = new UpgradeReviewParticipants(coordinator);
  const delayed = Promise.withResolvers<void>();
  let calls = 0;
  participants.attach('browser:only', { revision: () => '1:7', generation: () => 1,
    protect: async () => { if (++calls === 1) await delayed.promise; } });
  const attempt = coordinator.preview('development', { daemonIdentity: 'a'.repeat(64), installArtifactIdentity: 'b'.repeat(64) });
  coordinator.begin(attempt, true);
  const pending = participants.settle('browser:only', { attemptId: attempt.attemptId });
  expect(await participants.settle('browser:only', { attemptId: attempt.attemptId })).toMatchObject({ phase: 'ready' });
  delayed.resolve();
  expect(await pending).toMatchObject({ phase: 'ready' });
  expect(coordinator.status(attempt).phase).toBe('ready');
});
