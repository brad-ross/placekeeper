import type { App } from '@modelcontextprotocol/ext-apps';
import { ExtensionShell } from '../../../apps/codex-mcp/src/extension-shell.js';
import '../../../apps/codex-mcp/src/extension-presentation.css';

// Uses the production UI with synthetic transport; never opens or mutates a real review.
const samples = [
  { id: 'a'.repeat(32), title: 'The Effects of Monetary Policy.pdf', updatedAt: '2026-11-06T17:00:00Z', page: 12 },
  { id: 'b'.repeat(32), title: 'Research notes — revised draft.pdf', updatedAt: '2026-11-05T15:30:00Z', page: 3 },
  { id: 'c'.repeat(32), title: 'Appendix and supplementary results.pdf', updatedAt: '2026-11-03T12:00:00Z', page: 24 },
];
const app = {
  getHostContext: () => ({ displayMode: 'fullscreen', theme: 'light' }),
  callServerTool: async ({ arguments: { request } }: { arguments: { request: { action: string } } }) => {
    let result: unknown = { status: 'cancelled' };
    if (request.action === 'recent-list') result = { status: 'recent-reviews', items: new URLSearchParams(location.search).has('empty') ? [] : samples };
    if (request.action === 'recent-open') result = { status: 'busy', recoveryToken: 'r'.repeat(43), canResume: true };
    if (request.action === 'choose') result = { status: 'cancelled' };
    if (request.action === 'open') (document.getElementById('preview-file') as HTMLInputElement).click();
    return { _meta: { 'placekeeper/extension': result } };
  },
};
const shell = new ExtensionShell(app as unknown as App, document.getElementById('root')!, document.getElementById('status')!, document.getElementById('controls')!);
shell.hostContextChanged(app.getHostContext() as Parameters<ExtensionShell['hostContextChanged']>[0]);
await shell.receive({ status: 'chooser' });

if (import.meta.hot) import.meta.hot.accept(() => location.reload());
