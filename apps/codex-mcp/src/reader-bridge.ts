import { randomBytes } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { OPEN_PDF_FILE_TOOL } from './claude-desktop-server.js';
import { liveReaderInputSchema, liveReaderToolDefinitions, readDocumentTextDefinition, READ_DOCUMENT_TEXT_TOOL, isReaderToolName, type ReaderToolName } from './reader-tool-definitions.js';
import { parseReaderBridgeRequest, READER_BRIDGE_MAX_POLL_MS, READER_BRIDGE_MAX_RESULT_CHARS, READER_BRIDGE_TOOL, type ReaderBridgeResponse } from './reader-bridge-protocol.js';

export type ReaderBridgeFailure = 'no-view' | 'busy' | 'timeout' | 'view-gone' | 'oversized';
export type ReaderBridgeOutcome = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: ReaderBridgeFailure };
export interface ReaderBridgeOptions {
  /** How long a model tool call waits for the view. */
  readonly commandTimeoutMs?: number;
  /** A view that has neither polled nor held a command for this long is dropped. */
  readonly viewExpiryMs?: number;
  readonly maxPollMs?: number;
  readonly maxViews?: number;
  readonly maxQueue?: number;
  readonly maxResultChars?: number;
  readonly now?: () => number;
}
interface Command {
  readonly id: string;
  readonly tool: ReaderToolName;
  readonly input: Record<string, unknown>;
  readonly settle: (outcome: ReaderBridgeOutcome) => void;
}
interface Poll { readonly resolve: (response: ReaderBridgeResponse) => void; readonly timer: ReturnType<typeof setTimeout> }
interface View {
  readonly id: string;
  readonly sequence: number;
  lastSeen: number;
  readonly queue: Command[];
  inFlight?: Command | undefined;
  poll?: Poll | undefined;
}
const token = () => randomBytes(32).toString('base64url');

/** In-memory, per-process relay. Commands go to the most recently registered live view. */
export class ReaderBridge {
  readonly #views = new Map<string, View>();
  readonly #commandTimeoutMs: number;
  readonly #viewExpiryMs: number;
  readonly #maxPollMs: number;
  readonly #maxViews: number;
  readonly #maxQueue: number;
  readonly #maxResultChars: number;
  readonly #now: () => number;
  #sequence = 0;
  constructor(options: ReaderBridgeOptions = {}) {
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 20_000;
    this.#viewExpiryMs = options.viewExpiryMs ?? 45_000;
    this.#maxPollMs = Math.min(options.maxPollMs ?? READER_BRIDGE_MAX_POLL_MS, READER_BRIDGE_MAX_POLL_MS);
    this.#maxViews = options.maxViews ?? 8;
    this.#maxQueue = options.maxQueue ?? 4;
    this.#maxResultChars = options.maxResultChars ?? READER_BRIDGE_MAX_RESULT_CHARS;
    this.#now = options.now ?? Date.now;
  }
  get viewCount() { this.#prune(); return this.#views.size; }
  register(): Extract<ReaderBridgeResponse, { status: 'registered' }> {
    this.#prune();
    while (this.#views.size >= this.#maxViews) {
      const oldest = [...this.#views.values()].sort((a, b) => a.sequence - b.sequence)[0]!;
      this.#drop(oldest);
    }
    const view: View = { id: token(), sequence: ++this.#sequence, lastSeen: this.#now(), queue: [] };
    this.#views.set(view.id, view);
    return { status: 'registered', viewId: view.id, pollMs: this.#maxPollMs };
  }
  unregister(viewId: string): ReaderBridgeResponse {
    const view = this.#views.get(viewId);
    if (view) this.#drop(view);
    return { status: 'closed' };
  }
  poll(viewId: string, waitMs = this.#maxPollMs): Promise<ReaderBridgeResponse> {
    const view = this.#live(viewId);
    if (!view) return Promise.resolve({ status: 'rejected', reason: 'unknown-view' });
    view.lastSeen = this.#now();
    // One poll per view. A newer poll supersedes an older one.
    if (view.poll) { clearTimeout(view.poll.timer); view.poll.resolve({ status: 'idle' }); view.poll = undefined; }
    // The view polls only after posting its previous result, so an unanswered command was abandoned.
    if (view.inFlight) { const abandoned = view.inFlight; view.inFlight = undefined; abandoned.settle({ ok: false, reason: 'view-gone' }); }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (view.poll?.timer !== timer) return;
        view.poll = undefined;
        view.lastSeen = this.#now();
        resolve({ status: 'idle' });
      }, Math.max(0, Math.min(waitMs, this.#maxPollMs)));
      view.poll = { resolve, timer };
      this.#dispatch(view);
    });
  }
  result(viewId: string, commandId: string, text: string): ReaderBridgeResponse {
    const view = this.#live(viewId);
    if (!view) return { status: 'rejected', reason: 'unknown-view' };
    const command = view.inFlight;
    if (!command || command.id !== commandId) return { status: 'rejected', reason: 'unknown-command' };
    view.inFlight = undefined;
    view.lastSeen = this.#now();
    if (text.length > this.#maxResultChars) { command.settle({ ok: false, reason: 'oversized' }); return { status: 'rejected', reason: 'oversized' }; }
    command.settle({ ok: true, text });
    return { status: 'accepted' };
  }
  /** Enqueue a reader tool command for the current view and wait for its result. */
  call(tool: ReaderToolName, input: Record<string, unknown>, timeoutMs = this.#commandTimeoutMs): Promise<ReaderBridgeOutcome> {
    const view = this.#target();
    if (!view) return Promise.resolve({ ok: false, reason: 'no-view' });
    if (view.queue.length >= this.#maxQueue) return Promise.resolve({ ok: false, reason: 'busy' });
    return new Promise<ReaderBridgeOutcome>(resolve => {
      let settled = false;
      const command: Command = { id: token(), tool, input, settle: outcome => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const queued = view.queue.indexOf(command);
        if (queued >= 0) view.queue.splice(queued, 1);
        if (view.inFlight === command) view.inFlight = undefined;
        resolve(outcome);
      } };
      const timer = setTimeout(() => command.settle({ ok: false, reason: 'timeout' }), timeoutMs);
      view.queue.push(command);
      this.#dispatch(view);
    });
  }
  dispose() { for (const view of [...this.#views.values()]) this.#drop(view); }
  #dispatch(view: View) {
    if (!view.poll || view.inFlight || view.queue.length === 0) return;
    const command = view.queue.shift()!;
    const poll = view.poll;
    view.poll = undefined;
    clearTimeout(poll.timer);
    view.inFlight = command;
    view.lastSeen = this.#now();
    poll.resolve({ status: 'command', commandId: command.id, tool: command.tool, input: command.input });
  }
  #alive(view: View) { return view.poll !== undefined || view.inFlight !== undefined || this.#now() - view.lastSeen <= this.#viewExpiryMs; }
  #live(viewId: string) {
    const view = this.#views.get(viewId);
    if (view && !this.#alive(view)) { this.#drop(view); return undefined; }
    return view;
  }
  #prune() { for (const view of [...this.#views.values()]) if (!this.#alive(view)) this.#drop(view); }
  #target() {
    this.#prune();
    let latest: View | undefined;
    for (const view of this.#views.values()) if (!latest || view.sequence > latest.sequence) latest = view;
    return latest;
  }
  #drop(view: View) {
    this.#views.delete(view.id);
    if (view.poll) { clearTimeout(view.poll.timer); view.poll.resolve({ status: 'closed' }); view.poll = undefined; }
    for (const command of [...view.queue, ...(view.inFlight ? [view.inFlight] : [])]) command.settle({ ok: false, reason: 'view-gone' });
  }
}

const annotations = { readOnlyHint: true, openWorldHint: false } as const;
/** Model-visible Claude Desktop tools answered by the open reader through the bridge. */
export const readerServerTools: Tool[] = [
  ...liveReaderToolDefinitions.map(([name, description, properties]): Tool => ({ name, description, inputSchema: liveReaderInputSchema(properties), annotations })),
  { ...readDocumentTextDefinition, inputSchema: { ...readDocumentTextDefinition.inputSchema }, annotations },
];
export const readerBridgeTool: Tool = {
  name: READER_BRIDGE_TOOL,
  description: 'Private Placekeeper reader relay. Used only by the Placekeeper view.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['request'], properties: { request: { type: 'object' } } },
  _meta: { ui: { visibility: ['app'] } },
};

const failure = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });
const failureText: Record<ReaderBridgeFailure, string> = {
  'no-view': `No Placekeeper reader is open. Open the PDF with ${OPEN_PDF_FILE_TOOL} (or open_placekeeper) first, then retry.`,
  busy: 'The Placekeeper reader is busy with other requests. Retry shortly.',
  timeout: 'The Placekeeper reader did not respond in time. Make sure the reader is still open, then retry.',
  'view-gone': 'The Placekeeper reader closed before it answered. Reopen the PDF, then retry.',
  oversized: 'The Placekeeper reader result was too large. Request a smaller page range.',
};
const maxInputBytes = 16 * 1024;
/** Tools that may wait for the reader's text index get a longer, still bounded, wait. */
const slowTools: readonly ReaderToolName[] = ['search_document', READ_DOCUMENT_TEXT_TOOL];

export async function callReaderServerTool(bridge: ReaderBridge, name: string, args: unknown, slowTimeoutMs = 60_000): Promise<CallToolResult> {
  if (!isReaderToolName(name)) return failure('Unknown Placekeeper tool.');
  const input = args ?? {};
  if (typeof input !== 'object' || Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > maxInputBytes) return failure('Invalid Placekeeper reader tool input.');
  const outcome = await bridge.call(name, input as Record<string, unknown>, slowTools.includes(name) ? slowTimeoutMs : undefined);
  return outcome.ok ? { content: [{ type: 'text', text: outcome.text }] } : failure(failureText[outcome.reason]);
}

/** The app-only relay endpoint. Responses stay out of model-visible content. */
export async function callReaderBridgeTool(bridge: ReaderBridge, args: unknown): Promise<CallToolResult> {
  const raw = typeof args === 'object' && args !== null && !Array.isArray(args) && Object.keys(args).length === 1 ? (args as { request?: unknown }).request : undefined;
  const request = parseReaderBridgeRequest(raw);
  let response: ReaderBridgeResponse;
  if (!request) response = { status: 'rejected', reason: 'invalid' };
  else if (request.op === 'register') response = bridge.register();
  else if (request.op === 'poll') response = await bridge.poll(request.viewId, request.waitMs);
  else if (request.op === 'result') response = bridge.result(request.viewId, request.commandId, request.text);
  else response = bridge.unregister(request.viewId);
  return { content: [], structuredContent: { ...response } };
}
