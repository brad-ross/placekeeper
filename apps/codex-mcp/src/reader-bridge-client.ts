import type { DocumentModelContext } from './live-reader-tools.js';
import { READER_BRIDGE_MAX_RESULT_CHARS, type ReaderBridgeRequest, type ReaderBridgeResponse } from './reader-bridge-protocol.js';
import type { ReaderToolName } from './reader-tool-definitions.js';

type Execute = (input: unknown) => Promise<string>;
/** A WebMCP stand-in for hosts without `document.modelContext`: it only keeps the registered handlers. */
export class CapturedModelContext implements DocumentModelContext {
  readonly #tools = new Map<string, Execute>();
  registerTool(tool: Parameters<DocumentModelContext['registerTool']>[0]) { this.#tools.set(tool.name, input => tool.execute(input)); }
  unregisterTool(name: string) { this.#tools.delete(name); }
  execute(name: string, input: unknown): Promise<string> | undefined { return this.#tools.get(name)?.(input); }
}

export type ReaderBridgeClientState = 'active' | 'inactive' | 'unsupported';
export interface ReaderBridgeClientOptions {
  /** Calls the app-only bridge tool. Resolves undefined when the server does not answer with a bridge response. */
  call(request: ReaderBridgeRequest, timeoutMs: number): Promise<ReaderBridgeResponse | undefined>;
  execute(tool: ReaderToolName, input: Record<string, unknown>): Promise<string>;
  onState?(state: ReaderBridgeClientState): void;
  /** Requested server hold per poll; the server caps it at 25 s. */
  readonly pollWaitMs?: number;
  readonly minPollIntervalMs?: number;
  readonly maxBackoffMs?: number;
}
const requestTimeoutMs = 8000;
const unavailableResult = (reason: string) => JSON.stringify({ status: 'unavailable', message: 'Open the Placekeeper reader, wait for the current PDF, then retry. If the document or search changed, inspect it and search again.', reason });

/** One sequential long-poll loop per mounted reader: register, poll, execute, post, repeat. */
export class ReaderBridgeClient {
  readonly #options: ReaderBridgeClientOptions;
  #running = false;
  #stopped = false;
  #viewId: string | undefined;
  #state: ReaderBridgeClientState = 'inactive';
  #wake: (() => void) | undefined;
  constructor(options: ReaderBridgeClientOptions) { this.#options = options; }
  get state() { return this.#state; }
  start() {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    void this.#run();
  }
  stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#wake?.();
    const viewId = this.#viewId;
    this.#viewId = undefined;
    if (viewId) void this.#options.call({ op: 'unregister', viewId }, requestTimeoutMs).catch(() => undefined);
    this.#setState('inactive');
  }
  #setState(state: ReaderBridgeClientState) {
    if (this.#state === state || (this.#stopped && state !== 'inactive')) return;
    this.#state = state;
    this.#options.onState?.(state);
  }
  #sleep(ms: number) {
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.#wake = undefined; resolve(); }, ms);
      this.#wake = () => { clearTimeout(timer); this.#wake = undefined; resolve(); };
    });
  }
  async #run() {
    const pollWaitMs = this.#options.pollWaitMs ?? 20_000, minInterval = this.#options.minPollIntervalMs ?? 1000, maxBackoff = this.#options.maxBackoffMs ?? 30_000;
    let failures = 0;
    while (!this.#stopped) {
      try {
        if (!this.#viewId) {
          const registered = await this.#options.call({ op: 'register' }, requestTimeoutMs);
          if (this.#stopped) { if (registered?.status === 'registered') void this.#options.call({ op: 'unregister', viewId: registered.viewId }, requestTimeoutMs).catch(() => undefined); return; }
          // A server without the relay (Codex) answers with something else: stop for good.
          if (registered === undefined) { this.#setState('unsupported'); return; }
          if (registered.status !== 'registered') throw Error('Bridge registration failed');
          this.#viewId = registered.viewId;
          failures = 0;
          this.#setState('active');
        }
        const viewId = this.#viewId;
        const started = Date.now();
        const polled = await this.#options.call({ op: 'poll', viewId, waitMs: pollWaitMs }, pollWaitMs + 10_000);
        if (this.#stopped) return;
        if (polled === undefined) throw Error('Bridge poll failed');
        if (polled.status !== 'rejected' && polled.status !== 'closed') this.#setState('active');
        if (polled.status === 'command') {
          let text: string;
          try { text = await this.#options.execute(polled.tool, polled.input); }
          catch { text = unavailableResult('reader-unavailable'); }
          if (this.#stopped) return;
          if (text.length > READER_BRIDGE_MAX_RESULT_CHARS) text = unavailableResult('result-too-large');
          await this.#options.call({ op: 'result', viewId, commandId: polled.commandId, text }, requestTimeoutMs);
          failures = 0;
          continue;
        }
        if (polled.status === 'rejected' || polled.status === 'closed') {
          // The server forgot this view (expiry or restart): register again.
          this.#viewId = undefined;
          this.#setState('inactive');
        }
        failures = 0;
        if (Date.now() - started < minInterval) await this.#sleep(minInterval);
      } catch {
        if (this.#stopped) return;
        failures++;
        if (failures >= 3) this.#setState(this.#viewId ? 'inactive' : 'unsupported');
        await this.#sleep(Math.min(maxBackoff, 1000 * 2 ** (failures - 1)) + Math.random() * 250);
      }
    }
  }
}
