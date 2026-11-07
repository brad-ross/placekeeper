import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { InstalledCandidate, candidateExecutable } from './electron-installed-harness.js';
import { requestControl, MANAGEMENT_PROTOCOL_VERSION } from '../../apps/service/src/host/launch-control.js';
import type { UpgradeAttemptCredentials, UpgradePreparationRequest, UpgradePreparationStatus } from '../../apps/service/src/host/upgrade-preparation.js';
import type { PackagedRuntimeManifest } from '../../apps/service/src/platform/runtime-layout.js';
import { inspectProtectedDraft } from '../../apps/service/src/recovery/draft-snapshot.js';
import { readWindowState } from '../../apps/electron/src/window-state.js';
import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION } from '../../packages/core/src/review-runtime-protocol.js';

// This begins at the already-consented private controller boundary. It does not
// qualify an installer's consent dialog, platform approval, or mixed-host closure.
test('packaged consented upgrade exits naturally with the final composer input and restoration intact', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const candidate = await InstalledCandidate.create('text-native.pdf');
  const socket = join(candidate.root, 'control.sock');
  let credentials: UpgradeAttemptCredentials | undefined;
  const prepare = async (request: UpgradePreparationRequest): Promise<UpgradePreparationStatus> => {
    const response = await requestControl(socket, { kind: 'upgrade-preparation', request }, { timeoutMs: 5000 });
    if (response.kind !== 'upgrade-preparation' || !('token' in response.result)) {
      const status = credentials ? await requestControl(socket, { kind: 'upgrade-preparation', request: { operation: 'status', credentials } }) : undefined;
      if (request.operation === 'begin' && response.kind === 'error' && response.reason === 'unavailable' && status?.kind === 'upgrade-preparation' && 'token' in status.result
        && status.result.phase === 'canceled' && status.result.reason === 'Review revision changed') return status.result;
      const detail = status?.kind === 'upgrade-preparation' ? { phase: status.result.phase, reason: 'reason' in status.result ? status.result.reason : undefined } : { kind: status?.kind };
      throw new Error(`Preparation ${request.operation} did not return controller credentials: ${JSON.stringify({ kind: response.kind, status: detail })}`);
    }
    return response.result;
  };
  try {
    const executableDirectory = dirname(candidateExecutable());
    const resources = process.platform === 'darwin' ? resolve(executableDirectory, '../Resources/desktop') : join(executableDirectory, 'resources/desktop');
    const manifest = JSON.parse(await readFile(join(resources, 'runtime-manifest.json'), 'utf8')) as PackagedRuntimeManifest;
    const page = await candidate.launch();
    const pid = candidate.appPid;
    if (!pid) throw new Error('Missing owned packaged app PID');
    await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 30_000 });
    const pdfPage = page.locator('.pdf-workspace:not(.pdf-workspace--reference) .pdf-workspace__page[data-page-index="0"]').first();
    await expect(pdfPage.locator('img').first()).toBeVisible({ timeout: 30_000 });
    const sessionId = await page.evaluate(async ({ protocol, version }) => {
      const shell = window.placekeeper;
      const identity = await shell.identity();
      const bootstrap = await shell.request(identity, {
        protocol, version, kind: 'request', runtimeId: identity.windowId,
        requestId: crypto.randomUUID(), method: 'bootstrap', payload: {},
      }) as { sessionId: string };
      return bootstrap.sessionId;
    }, { protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION });
    const management = await requestControl(socket, { kind: 'management', protocolVersion: MANAGEMENT_PROTOCOL_VERSION, operation: 'status' });
    if (management.kind !== 'management' || management.operation !== 'status') throw new Error('Missing installed daemon status');
    expect(management.status.daemonIdentity).toBe(manifest.daemonIdentity);
    const bounds = await pdfPage.boundingBox();
    if (!bounds) throw new Error('Missing rendered PDF bounds');
    await pdfPage.click({ button: 'right', position: { x: bounds.width * 0.7, y: bounds.height * 0.55 } });
    await page.getByRole('menuitem', { name: 'Add Page Note' }).click();
    const editor = page.locator('[data-comment-composer] textarea');
    const text = 'Final real packaged composer input immediately before consented preparation.';
    // No test-issued draft commands or wait for an autosave: this final DOM
    // value must be durable by upgrade completion, including after a new preview.
    await editor.fill(text);
    let begun: UpgradePreparationStatus | undefined;
    // The draft can reach the service between preview and consent. That correctly
    // invalidates the preview; renew it without waiting for an autosave or
    // accepting any other preparation failure.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const preview = await prepare({ operation: 'preview', installedDaemonIdentity: management.status.daemonIdentity,
        candidate: { daemonIdentity: manifest.daemonIdentity, installArtifactIdentity: manifest.installArtifactIdentity } });
      credentials = { attemptId: preview.attemptId, token: preview.token, candidate: preview.candidate };
      expect(preview.participants.some(p => p.id.startsWith('app:'))).toBe(true);
      begun = await prepare({ operation: 'begin', credentials, consent: true });
      if (begun.phase !== 'canceled' || begun.reason !== 'Review revision changed') break;
    }
    if (!credentials) throw new Error('Missing upgrade preview credentials');
    expect(['preparing', 'ready']).toContain(begun?.phase);
    await expect.poll(async () => {
      const { phase, reason } = await prepare({ operation: 'status', credentials: credentials! });
      return { phase, reason };
    }, { timeout: 20_000 }).toMatchObject({ phase: 'ready' });
    const ready = await prepare({ operation: 'status', credentials });
    expect(ready.participants.every(p => p.acknowledged)).toBe(true);
    const snapshot = await inspectProtectedDraft(join(candidate.root, 'recovery', sessionId));
    expect(snapshot?.draft.state.pendingDrafts).toEqual(expect.arrayContaining([expect.objectContaining({ text, status: 'protected' })]));
    const statePath = join(candidate.root, 'electron-user-data', 'windows.json');
    const before = await readWindowState(statePath);
    expect(before).toEqual(expect.arrayContaining([expect.objectContaining({ sourcePath: await realpath(candidate.source) })]));
    const closeSettlements = () => candidate.timings().filter(event => ['renderer-close-request', 'close-request-settle', 'close-settled'].includes(event.stage));
    const ordinaryCloseBefore = closeSettlements();
    expect((await prepare({ operation: 'commit', credentials })).phase).toBe('committed');
    // Observe the exact owned PID before any harness cleanup can signal it.
    await expect.poll(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
    }, { timeout: 20_000 }).toBe(true);
    expect(page.isClosed()).toBe(true);
    expect(closeSettlements()).toEqual(ordinaryCloseBefore);
    expect(await readWindowState(statePath)).toEqual(before);
    expect((await inspectProtectedDraft(join(candidate.root, 'recovery', sessionId)))?.draft.state.pendingDrafts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ text, status: 'protected' })]));
    await testInfo.attach('consented-preparation-closure', { body: JSON.stringify({ pid, sessionId, participants: ready.participants, restoration: before, timings: candidate.timings() }), contentType: 'application/json' });
  } finally {
    // This fixture performs no replacement. Release its consented transaction
    // only after the assertions, so normal scoped daemon cleanup is available.
    try { if (credentials) await prepare({ operation: 'cancel', credentials }); }
    finally { await candidate.dispose(); }
  }
});
