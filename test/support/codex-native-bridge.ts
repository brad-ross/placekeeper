import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { SessionBroker } from '../../apps/service/src/sessions/session-broker.js';
import { CodexRuntimeManager } from '../../apps/service/src/codex/codex-runtime.js';
import { CodexServiceRuntimeBackend } from '../../apps/service/src/codex/codex-runtime-backend.js';
import { PdfSaveCoordinator } from '../../apps/service/src/saving/pdf-save-coordinator.js';
import { LiveContextService } from '../../apps/service/src/context/live-context-service.js';
import { ExportCoordinator } from '../../apps/service/src/export/export-coordinator.js';
import { createEmbedPdfWriter } from '../../packages/pdf-backends/src/embedpdf-adapter.js';
import { NativeOperationError, type CodexAppRequest, type CodexAppResponse } from '../../packages/core/src/codex-mcp-protocol.js';

/** Test MCP bridge: genuine service authority and production UI, simulated trusted host events.
 * It cannot qualify installed Codex hooks, CSP, clipboard, focus or host lifecycle. */
export async function nativeBridge(fixture: string, options: { workflowMode?: "generated-output" } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-acceptance-'));
  const pdfPath = join(root, 'source.pdf');
  await copyFile(resolve('test/fixtures/pdfs', fixture), pdfPath);
  const broker = new SessionBroker({ recoveryRoot: join(root, 'recovery') });
  const nativeWriter = await createEmbedPdfWriter();
  let beforeWrite: (() => Promise<void>) | undefined;
  const writer = { ...nativeWriter, write: async (input: Parameters<typeof nativeWriter.write>[0]) => {
    await beforeWrite?.(); return nativeWriter.write(input);
  } };
  const picker = { chooseFolder: async () => root, locatePdf: async () => undefined };
  const saving = new PdfSaveCoordinator({ broker, writer, picker });
  const exporting = new ExportCoordinator({ writer, capabilities: broker.capabilities, controls: broker.controls });
  const backend = new CodexServiceRuntimeBackend({ broker, saving, exporting, assetRoot: resolve('dist/web') });
  const manager = new CodexRuntimeManager(broker, { backend });
  const opened = await broker.openReview({ pdfPath, surface: 'codex-native', ...options });
  if (opened.kind === 'recovery-offered') throw new Error('Fresh fixture offered recovery');
  const sessionId = opened.launch.sessionId;
  const task = `acceptance-${randomUUID()}`;
  const liveContext = new LiveContextService({ broker });
  const panels: { active: Extract<CodexAppResponse, { status: 'active' }>; page: Page | undefined }[] = [];
  async function panel(page?: Page, target = { sessionId, task }) {
    const sessionId = target.sessionId, task = target.task;
    const generation = broker.state(sessionId)!.workflow.documentGeneration;
    const launch = manager.stageLaunch({ sessionId, kind: 'opened' })!;
    expect(manager.claimLaunch({ bindProof: launch.bindProof, reviewSessionId: sessionId, documentGeneration: generation, taskSessionId: task })).toBe(true);
    const display = manager.display(launch.handoff.token)!;
    expect(manager.attestDisplay(display.receipt, task)).toBe(true);
    const ready = await manager.pending({ protocolVersion: 1, runtimeId: display.privateMeta.runtimeId,
      attemptId: display.privateMeta.attemptId, generation, capability: display.privateMeta.pendingCapability,
      requestId: randomUUID(), authority: 'pending', method: 'ready', payload: {} });
    if (ready.status !== 'active') throw new Error('Bridge admission failed');
    const state = { active: ready, page }; panels.push(state);
    const raw = (method: CodexAppRequest['method'], payload: unknown = {}) => manager.handle({
      protocolVersion: 1, runtimeId: state.active.runtimeId, attemptId: state.active.attemptId,
      generation: state.active.generation, capability: state.active.presentationCapability,
      authority: 'presentation', requestId: randomUUID(), method, payload,
    });
    const call = async (method: CodexAppRequest['method'], payload: unknown = {}) => {
      const response = await raw(method, payload);
      if (response.status === 'operation-error') throw new NativeOperationError();
      if (response.status !== 'ok') throw new Error(`Bridge ${method}: ${response.status}${response.status === 'denied' ? ` (${response.reason})` : ''}`);
      const value = response.payload as Record<string, unknown>;
      if (method === 'watermark' && value.presentation !== undefined) state.active = value.presentation as typeof ready;
      return value;
    };
    if (page) {
      await page.exposeFunction('nativeAcceptanceCall', async (method: CodexAppRequest['method'], payload?: unknown) => {
        try { return await call(method, payload); }
        catch (error) { if (error instanceof NativeOperationError) return { status: 'operation-error', reason: 'export-conflict' }; throw error; }
      });
      await page.route('**/native-acceptance-bridge', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>' }));
      await page.goto('/native-acceptance-bridge');
      await page.evaluate(async runtimeId => {
        const { NativeOperationError, parseCodexAppResponse } = await import(/* @vite-ignore */ ('/packages/core/src/codex-mcp-protocol.ts' as string));
        const { createCodexHostRuntime } = await import(/* @vite-ignore */ ('/apps/web/src/host/codex-runtime.ts' as string));
        const { mountCodexProductionReview } = await import(/* @vite-ignore */ ('/apps/web/src/codex-entry.tsx' as string));
        const bridge = window as unknown as { nativeAcceptanceCall: (method: string, payload?: unknown) => Promise<any>; nativeAcceptanceDispose: () => void; nativeAcceptanceErrors: string[] };
        document.body.innerHTML = '<div id="root"></div>';
        const listeners = new Set<(event: any) => void>();
        let watermark: number | undefined, generation: number | undefined, stopped = false;
        bridge.nativeAcceptanceErrors = [];
        const runtime = createCodexHostRuntime({ runtimeId, call: async (method: string, payload: unknown) => {
            const result = await bridge.nativeAcceptanceCall(method, payload);
            if (parseCodexAppResponse(result)?.status === 'operation-error') throw new NativeOperationError();
            return result;
          },
          subscribeInvalidations(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); } });
        const unmount = mountCodexProductionReview(document.getElementById('root')!, runtime,
          (error: Error) => bridge.nativeAcceptanceErrors.push(error.message), () => {});
        const poll = async () => {
          try {
            const next = await bridge.nativeAcceptanceCall('watermark');
            if (!stopped && watermark !== undefined && next.watermark !== watermark) {
              for (const listener of listeners) listener({ sessionId: next.sessionId, generation: next.documentGeneration,
                revision: next.reviewRevision, reason: next.documentGeneration === generation ? 'freshness' : 'generation' });
            }
            watermark = next.watermark; generation = next.documentGeneration;
            if (!stopped) await bridge.nativeAcceptanceCall('renew');
          } catch (error) { if (!stopped) bridge.nativeAcceptanceErrors.push(String(error)); }
          if (!stopped) timer = setTimeout(() => void poll(), 100);
        };
        let timer: ReturnType<typeof setTimeout>;
        bridge.nativeAcceptanceDispose = () => { stopped = true; clearTimeout(timer); unmount(); };
        void poll();
      }, ready.runtimeId);
      await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 20_000 });
      await expect(page.locator('[data-page-index="0"] > img').first()).toBeVisible();
      await page.locator('[data-page-index="0"] > img').first().evaluate((image: HTMLImageElement) => image.decode());
    }
    return { state, call, raw, async disconnect() {
      if (page && !page.isClosed()) await page.evaluate(() => (window as any).nativeAcceptanceDispose());
      await manager.detach(state.active.runtimeId);
    } };
  }
  return { root, pdfPath, broker, manager, backend, saving, sessionId, task, liveContext, panel,
    setBeforeWrite(value?: () => Promise<void>) { beforeWrite = value; },
    async dispose() {
      beforeWrite = undefined;
      for (const panel of panels) if (panel.page && !panel.page.isClosed()) await panel.page.evaluate(() => (window as any).nativeAcceptanceDispose?.()).catch(() => {});
      liveContext.discardAll(); await manager.close(); await saving.drain(); await broker.quiesceForShutdown();
      await rm(root, { recursive: true, force: true });
    },
    async sourceBytes() { return readFile(pdfPath); },
  };
}
