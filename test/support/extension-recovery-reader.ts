import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { SessionBroker } from '../../apps/service/src/sessions/session-broker.js';
import { ExtensionRuntimeManager } from '../../apps/service/src/codex/extension-runtime.js';
import { CodexServiceRuntimeBackend } from '../../apps/service/src/codex/codex-runtime-backend.js';
import { PdfSaveCoordinator } from '../../apps/service/src/saving/pdf-save-coordinator.js';
import { ExportCoordinator } from '../../apps/service/src/export/export-coordinator.js';
import { createEmbedPdfWriter } from '../../packages/pdf-backends/src/embedpdf-adapter.js';

/** Production extension service and reader; only the host bridge/lifecycle is simulated. */
export async function extensionRecoveryReader(page: Page) {
  const root = await mkdtemp(join(tmpdir(), 'extension-recovery-browser-'));
  const path = join(root, 'Recent paper.pdf');
  await copyFile(resolve('test/fixtures/pdfs/multi-page-text.pdf'), path);
  const broker = new SessionBroker({ recoveryRoot: join(root, 'recovery') });
  const writer = await createEmbedPdfWriter();
  const saving = new PdfSaveCoordinator({ broker, writer });
  const exporting = new ExportCoordinator({ writer, capabilities: broker.capabilities });
  const backend = new CodexServiceRuntimeBackend({ broker, saving, exporting, assetRoot: resolve('dist/web') });
  let clock = Date.now();
  const manager = new ExtensionRuntimeManager(broker, { backend, now: () => clock, pickPdf: async () => path });
  const requests: any[] = [];
  let suppressRelease = false;
  let bootstrapGate: Promise<void> | undefined;
  await page.exposeFunction('recoveryAcceptanceRequest', async (request: any) => {
    requests.push(request);
    if (request.action === 'app' && request.request.method === 'bootstrap') await bootstrapGate;
    if (request.action === 'revoke' && suppressRelease) return { status: 'unavailable' };
    if (request.action === 'app' && request.request.method === 'upgradePoll') return { status: 'ok', payload: { phase: 'none' } };
    return manager.dispatch(request);
  });
  const html = (await readFile('dist/codex-mcp/review-v1.html', 'utf8')).replace(/<script>[\s\S]*?<\/script>/gu, '').replace('<div id="root">', '<div id="controls"></div><div id="root">');
  await page.route('**/extension-recovery-acceptance', route => route.fulfill({ contentType: 'text/html', body: html }));
  async function mount(chooser: boolean) {
    await page.goto('/extension-recovery-acceptance');
    await page.evaluate(async chooser => {
      const { ExtensionShell } = await import(/* @vite-ignore */ ('/apps/codex-mcp/src/extension-shell.ts' as string));
      await import(/* @vite-ignore */ ('/apps/codex-mcp/src/extension-presentation.css' as string));
      for (const style of [...document.querySelectorAll('head > style:not([data-vite-dev-id])')]) document.head.append(style);
      const state = (window as any).recoveryAcceptance = { context: null, publications: [] as any[], tools: new Map(), messages: [] as any[], shell: undefined as any };
      Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: (tool: any) => state.tools.set(tool.name, tool), unregisterTool: (name: string) => state.tools.delete(name) } });
      const app = {
        getHostContext: () => ({ displayMode: 'fullscreen', theme: 'light' }),
        requestDisplayMode: async () => ({ mode: 'fullscreen' }),
        requestTeardown: async () => {},
        callServerTool: async ({ arguments: { request } }: any) => ({ _meta: { 'placekeeper/extension': await (window as any).recoveryAcceptanceRequest(request) } }),
      };
      state.shell = new ExtensionShell(app, document.getElementById('root')!, document.getElementById('status')!, document.getElementById('controls')!, () => undefined,
        () => ({ getCurrent: () => state.context, update: async (params: any) => { const updateId = `context-${state.publications.length}`; state.publications.push(params); state.context = { ...params, updateId }; return { updateId }; } }));
      await state.shell.receive(chooser ? { status: 'chooser' } : await (window as any).recoveryAcceptanceRequest({ action: 'open' }));
    }, chooser);
  }
  return { broker, manager, requests, mount,
    holdBootstrap() {
      const gate = Promise.withResolvers<void>();
      bootstrapGate = gate.promise;
      return () => { bootstrapGate = undefined; gate.resolve(); };
    },
    suppressRelease(value: boolean) { suppressRelease = value; },
    advance(ms: number) { clock += ms; },
    async ready() { await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 20000 }); },
    async tool(name: string, input: unknown) { return page.evaluate(async ({ name, input }) => JSON.parse(await (window as any).recoveryAcceptance.tools.get(name).execute(input)), { name, input }); },
    async dispose() {
      await page.evaluate(() => (window as any).recoveryAcceptance?.shell.teardown()).catch(() => {});
      await manager.close(); await saving.drain(); await broker.quiesceForShutdown(); await rm(root, { recursive: true, force: true });
    },
  };
}
