import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type { CallToolResult, GetPromptResult, Prompt, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CODEX_MAX_ENCODED_RESPONSE_BYTES, CODEX_DOCUMENT_UI_RESOURCE } from '../../../packages/core/src/codex-mcp-protocol.js';
import { EXTENSION_META_KEY, EXTENSION_TOOL } from '../../../packages/core/src/extension-protocol.js';
import { callExtensionTool, extensionTools } from './extension-server.js';
import type { NativeServiceClient } from './service-client.js';

/** Hosts without file entrypoints (Claude Desktop) open a PDF only through a model tool call. */
export const MCP_HOST_ENV = 'PLACEKEEPER_MCP_HOST';
export type McpHost = 'codex' | 'claude-desktop';
export function mcpHostFromEnv(env: NodeJS.ProcessEnv = process.env): McpHost {
  return env[MCP_HOST_ENV] === 'claude-desktop' ? 'claude-desktop' : 'codex';
}

export const OPEN_PDF_FILE_TOOL = 'open_pdf_file';
export const OPEN_PDF_PROMPT = 'open_pdf';
const appTool = extensionTools.find(tool => tool.name === EXTENSION_TOOL)!;

export const claudeDesktopTools: Tool[] = [
  {
    name: OPEN_PDF_FILE_TOOL,
    title: 'Placekeeper',
    description: 'Open a PDF on this computer in the Placekeeper reader inside the chat. Use when the user asks to open, read, review or annotate a local PDF. Pass its absolute path.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', description: 'Absolute path to a local .pdf file.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: CODEX_DOCUMENT_UI_RESOURCE } },
  },
  {
    name: 'open_placekeeper',
    title: 'Placekeeper',
    description: 'Open the Placekeeper reader inside the chat and let the user choose a PDF with the system file picker or from recent documents. Use when the user wants Placekeeper but has not given a path.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: CODEX_DOCUMENT_UI_RESOURCE } },
  },
  appTool,
];

export const claudeDesktopPrompts: Prompt[] = [{
  name: OPEN_PDF_PROMPT,
  title: 'Open a PDF in Placekeeper',
  description: 'Open a local PDF in the Placekeeper reader. Leave the path empty to choose a file.',
  arguments: [{ name: 'path', description: 'Absolute path to a local PDF (optional).', required: false }],
}];

export function getClaudeDesktopPrompt(name: string, args: Record<string, string> | undefined): GetPromptResult {
  if (name !== OPEN_PDF_PROMPT) throw new Error('Unknown prompt');
  const path = args?.path?.trim();
  const text = path
    ? `Open the PDF at ${JSON.stringify(path)} in Placekeeper with the ${OPEN_PDF_FILE_TOOL} tool. Don't read or summarize it unless I ask.`
    : 'Open Placekeeper with the open_placekeeper tool so I can choose a PDF.';
  return { description: 'Open a PDF in Placekeeper', messages: [{ role: 'user', content: { type: 'text', text } }] };
}

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
/** Text-only hosts (for example Claude Code) can call the tools but cannot draw the reader. */
export const claudeDesktopUnsupported = (): CallToolResult => failure('This app cannot show the Placekeeper reader because it does not support MCP Apps views. Open the PDF in the Placekeeper desktop app instead.');

/** Resolve a model-supplied path to an existing regular .pdf file. The host's tool approval is the user's consent. */
export async function admitLocalPdf(raw: unknown): Promise<string | undefined> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length >= 32768 || raw.includes('\0') || !isAbsolute(raw)) return undefined;
  try {
    const resolved = await realpath(raw);
    if (!/\.pdf$/iu.test(resolved) || !(await stat(resolved)).isFile()) return undefined;
    return resolved;
  } catch { return undefined; }
}

export async function callClaudeDesktopTool(client: NativeServiceClient, name: string, args: unknown, meta: unknown): Promise<CallToolResult> {
  if (name === OPEN_PDF_FILE_TOOL) {
    if (typeof args !== 'object' || args === null || Object.keys(args).length !== 1 || !('path' in args)) return failure('Pass the absolute path of one local PDF.');
    const path = await admitLocalPdf(args.path);
    if (path === undefined) return failure('Placekeeper can open only an existing local .pdf file given by its absolute path.');
    if (!client.extension) return failure('Placekeeper is unavailable. Check that Placekeeper is running, then try again.');
    let result: CallToolResult;
    try { result = { content: [], _meta: { [EXTENSION_META_KEY]: await client.extension({ action: 'open', pdfPath: path }) } }; }
    catch { return failure('Placekeeper could not open this PDF. Check that Placekeeper is running, then try again.'); }
    if (Buffer.byteLength(JSON.stringify(result)) > CODEX_MAX_ENCODED_RESPONSE_BYTES) return failure('Placekeeper could not open this PDF.');
    // Grants stay in private _meta for the app; the model sees only the file name.
    return { ...result, content: [{ type: 'text', text: `Opened ${basename(path)} in Placekeeper. The reader is shown to the user in the chat.` }] };
  }
  if (name === 'open_placekeeper') {
    const result = await callExtensionTool(client, name, args ?? {}, meta);
    return result.isError ? result : { ...result, content: [{ type: 'text', text: 'Opened Placekeeper. The user can choose a PDF in the reader shown in the chat.' }] };
  }
  if (name === EXTENSION_TOOL) return callExtensionTool(client, name, args, meta);
  return failure('Unknown Placekeeper tool.');
}
