import { startRuntime } from '../../apps/web/src/production-entry.js';
import { createBrowserHostRuntime } from '../../apps/web/src/host/browser-runtime.js';
import type { ProductionSession } from '../../apps/web/src/host/session-contracts.js';

/** Real authenticated transport, with Electron's renderer lifetime policy. Native
 * app quit is intentionally delayed so the renderer observes commit first. */
export async function start(session: ProductionSession): Promise<void> {
  const transport = createBrowserHostRuntime(session);
  const lifecycle = { disposed: 0, closeRequested: 0 };
  Object.assign(window, { __upgradeLifecycle: lifecycle });
  await startRuntime({ ...transport, host: 'electron',
    closeForUpgrade: async () => { lifecycle.closeRequested++; },
    dispose: () => { lifecycle.disposed++; transport.dispose(); },
  });
}

export { showTerminalRecovery } from '../../apps/web/src/production-entry.js';
import { resumeProductionSession } from '../../apps/web/src/app/session-api.js';
export async function resume(viewId: string, pathname: string): Promise<void> {
  await start(await resumeProductionSession(viewId, pathname));
}
