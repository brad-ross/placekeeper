import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { nativeBridge } from './codex-native-bridge.js';

/** Real extension shell, reader and service; host entry/settings/context/message APIs are simulated.
 * This does not qualify native entrypoints, host focus, conditional resource writes or lifecycle. */
export async function extensionReader(page: Page, fixture = 'text-native-with-annotations.pdf') {
  const bridge = await nativeBridge(fixture);
  const panel = await bridge.panel();
  const requests: string[] = [];
  await page.exposeFunction('extensionAcceptanceRequest', async (request: any) => {
    requests.push(request.action);
    if (request.action === 'app') {
      // The shared reader bridge omits the daemon's installer coordinator.
      // Model its idle response so an unrelated optional poll cannot retire this panel.
      if (request.request.method === 'upgradePoll') return { status: 'ok', payload: { phase: 'none' } };
      const response = await panel.raw(request.request.method, request.request.payload);
      if (response.status === 'denied') console.log('Extension test transport denial', request.request.method, response.reason);
      return response;
    }
    if (request.action === 'activate') return { status: 'active', grant: 'a'.repeat(43), presentation: panel.state.active, contextPublished: false };
    if (request.action === 'reading-position') return { status: 'position-saved' };
    if (request.action === 'context-published') return { status: 'context-ready' };
    if (request.action === 'revoke') return { status: 'closed' };
    throw Error(`Unexpected host request: ${request.action}`);
  });
  // Keep the production shell's frame rules (including its positioned reader root).
  // Only substitute the transport bootstrap below; missing these rules creates false overlap.
  const production = await readFile('dist/codex-mcp/review-v1.html', 'utf8');
  const frame = production.replace(/<script>[\s\S]*?<\/script>/gu, '').replace('<div id="root">', '<div id="controls"></div><div id="root">');
  await page.route('**/extension-reader-acceptance', route => route.fulfill({ contentType: 'text/html', body: frame }));
  await page.goto('/extension-reader-acceptance');
  await page.evaluate(async () => {
    const { ExtensionShell } = await import(/* @vite-ignore */ ('/apps/codex-mcp/src/extension-shell.ts' as string));
    await import(/* @vite-ignore */ ('/apps/codex-mcp/src/extension-presentation.css' as string));
    // Vite injects imported reader CSS after the inline production frame style.
    // Restore the production bundle's cascade order after those imports settle.
    for (const style of [...document.querySelectorAll('head > style:not([data-vite-dev-id])')]) document.head.append(style);
    const w = window as any;
    const tools = new Map();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: { registerTool: (tool: any) => tools.set(tool.name, tool), unregisterTool: (name: string) => tools.delete(name) } });
    let releaseSettings!: () => void;
    const settingsGate = new Promise<void>(resolve => { releaseSettings = resolve; });
    const state = w.extensionAcceptance = {
      shell: undefined as any, tools, context: null as any, publications: [] as any[], messages: [] as any[], promptText: 'Keep my typed question',
      settings: { backgroundContext: true, selectionSharing: true, mentions: false }, revision: 0,
      settingsLoaded: false, releaseSettings, expansionRequests: 0, included: false,
      publicationGate: undefined as Promise<void> | undefined, releasePublication: undefined as (() => void) | undefined,
      receiving: undefined as Promise<boolean> | undefined,
    };
    // The protocol metadata key is imported so the harness uses the production envelope.
    const { EXTENSION_META_KEY } = await import(/* @vite-ignore */ ('/packages/core/src/extension-protocol.ts' as string));
    const envelope = (value: unknown) => ({ _meta: { [EXTENSION_META_KEY]: value } });
    const app = {
      sendMessage: async (params: any) => { state.messages.push(params); state.promptText = JSON.stringify(params); return {}; },
      getHostContext: () => ({ displayMode: 'fullscreen', theme: 'light' }),
      requestDisplayMode: async () => { state.expansionRequests++; return { mode: 'fullscreen' }; },
      callServerTool: async ({ arguments: { request } }: any) => {
        if (request.action === 'settings-read') { await settingsGate; state.settingsLoaded = true; return envelope({ status: 'settings', values: state.settings, revision: state.revision }); }
        if (request.action === 'settings-update') { Object.assign(state.settings, request.set); state.revision++; return envelope({ status: 'settings', values: state.settings, revision: state.revision }); }
        if (request.action === 'catalogue') { if (request.operation === 'capture') state.included = true; if (request.operation === 'remove') state.included = false; return envelope({ status: 'catalogue', included: state.included }); }
        if (request.action === 'context-published' && state.publicationGate) await state.publicationGate;
        return envelope(await w.extensionAcceptanceRequest(request));
      },
    };
    state.shell = new ExtensionShell(app, document.getElementById('root')!, document.getElementById('status')!, document.getElementById('controls')!, () => undefined,
      () => ({ getCurrent: () => state.context, update: async (params: any) => { const updateId = `host-${state.publications.length}`; state.publications.push({ ...params, settingsLoaded: state.settingsLoaded }); state.context = { ...params, updateId }; return { updateId }; } }));
    state.receiving = state.shell.receive({ status: 'provisional', grant: 'a'.repeat(43) });
  });
  return { bridge, panel, requests,
    async ready() {
      await page.evaluate(() => (window as any).extensionAcceptance.releaseSettings());
      await expect(page.locator('[data-production-review]')).toHaveAttribute('data-initial-view-ready', 'true', { timeout: 20_000 });
      await page.locator('[data-page-index="0"] > img').first().evaluate((image: HTMLImageElement) => image.decode());
    },
    async tool(name: string, input: unknown) { return page.evaluate(async ({ name, input }) => {
      const tool = (window as any).extensionAcceptance.tools.get(name);
      if (!tool) throw Error(`Live tool ${name} is not registered`);
      return JSON.parse(await tool.execute(input));
    }, { name, input }); },
    async dispose() { await page.evaluate(() => (window as any).extensionAcceptance?.shell.teardown()).catch(() => {}); await bridge.dispose(); },
  };
}
