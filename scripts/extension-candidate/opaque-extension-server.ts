import {
  callExtensionTool as productionCallExtensionTool,
  extensionTools as productionExtensionTools,
} from '../../apps/codex-mcp/src/extension-server.js';

// Candidate-only qualification: omit optional local-path metadata at the entry boundary.
// Keep the host's resource URI and all production admission, grants and resource APIs intact.
export const extensionTools = productionExtensionTools.map(tool => tool.name === 'open_pdf'
  ? { ...tool, title: 'Placekeeper Opaque Test' }
  : tool);

export const callExtensionTool: typeof productionCallExtensionTool = (client, name, args, meta) =>
  productionCallExtensionTool(client, name, args, name === 'open_pdf' ? undefined : meta);
