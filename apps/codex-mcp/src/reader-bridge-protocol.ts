import { isReaderToolName, READER_TOOL_MAX_RESULT_CHARS, type ReaderToolName } from './reader-tool-definitions.js';

/**
 * App-only relay between a Claude Desktop view and server-listed reader tools.
 * The view registers, long-polls for one command at a time, and posts each result.
 */
export const READER_BRIDGE_TOOL = 'reader_bridge';
/** The server never holds a poll longer than this, far below the host's 240 s tool timeout. */
export const READER_BRIDGE_MAX_POLL_MS = 25_000;
export const READER_BRIDGE_MAX_RESULT_CHARS = READER_TOOL_MAX_RESULT_CHARS;
const idPattern = /^[A-Za-z0-9_-]{43}$/u;

export type ReaderBridgeRequest =
  | { readonly op: 'register' }
  | { readonly op: 'poll'; readonly viewId: string; readonly waitMs?: number }
  | { readonly op: 'result'; readonly viewId: string; readonly commandId: string; readonly text: string }
  | { readonly op: 'unregister'; readonly viewId: string };

export type ReaderBridgeResponse =
  | { readonly status: 'registered'; readonly viewId: string; readonly pollMs: number }
  | { readonly status: 'command'; readonly commandId: string; readonly tool: ReaderToolName; readonly input: Record<string, unknown> }
  | { readonly status: 'idle' }
  | { readonly status: 'accepted' }
  | { readonly status: 'closed' }
  | { readonly status: 'rejected'; readonly reason: 'unknown-view' | 'unknown-command' | 'oversized' | 'invalid' };

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && idPattern.test(value);

export function parseReaderBridgeRequest(raw: unknown): ReaderBridgeRequest | undefined {
  if (!record(raw)) return undefined;
  switch (raw.op) {
    case 'register': return exactKeys(raw, ['op']) ? { op: 'register' } : undefined;
    case 'poll':
      if (!exactKeys(raw, ['op', 'viewId'], ['waitMs']) || !id(raw.viewId)) return undefined;
      if (raw.waitMs !== undefined && (typeof raw.waitMs !== 'number' || !Number.isSafeInteger(raw.waitMs) || raw.waitMs < 0)) return undefined;
      return { op: 'poll', viewId: raw.viewId, ...(raw.waitMs === undefined ? {} : { waitMs: raw.waitMs }) };
    case 'result':
      // Oversized text is still parsed so the relay can fail the waiting call promptly.
      if (!exactKeys(raw, ['op', 'viewId', 'commandId', 'text']) || !id(raw.viewId) || !id(raw.commandId) || typeof raw.text !== 'string') return undefined;
      return { op: 'result', viewId: raw.viewId, commandId: raw.commandId, text: raw.text };
    case 'unregister': return exactKeys(raw, ['op', 'viewId']) && id(raw.viewId) ? { op: 'unregister', viewId: raw.viewId } : undefined;
    default: return undefined;
  }
}

export function parseReaderBridgeResponse(raw: unknown): ReaderBridgeResponse | undefined {
  if (!record(raw)) return undefined;
  switch (raw.status) {
    case 'registered': return id(raw.viewId) && typeof raw.pollMs === 'number' && Number.isSafeInteger(raw.pollMs) && raw.pollMs > 0 ? { status: 'registered', viewId: raw.viewId, pollMs: Math.min(raw.pollMs, READER_BRIDGE_MAX_POLL_MS) } : undefined;
    case 'command': return id(raw.commandId) && isReaderToolName(raw.tool) && record(raw.input) ? { status: 'command', commandId: raw.commandId, tool: raw.tool, input: raw.input } : undefined;
    case 'idle': case 'accepted': case 'closed': return { status: raw.status };
    case 'rejected': return raw.reason === 'unknown-view' || raw.reason === 'unknown-command' || raw.reason === 'oversized' || raw.reason === 'invalid' ? { status: 'rejected', reason: raw.reason } : undefined;
    default: return undefined;
  }
}
