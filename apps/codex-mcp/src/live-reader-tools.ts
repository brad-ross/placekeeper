import type { ReviewAgentActions, ReviewAgentBridge, ReviewAgentTarget } from '../../web/src/host/review-agent-bridge.js';
import { liveReaderInputSchema, liveReaderToolDefinitions, type LiveReaderToolName } from './reader-tool-definitions.js';
import { formatDocumentText, parseDocumentTextRange } from './document-text.js';

/** The document-scoped WebMCP surface exercised by the installed host probe. */
export interface DocumentModelContext {
  registerTool(tool: { name: string; description: string; inputSchema: object; annotations: { readOnlyHint: true }; execute(input: unknown): Promise<string> }): void;
  unregisterTool?(name: string): void;
}
const unavailable = () => ({ status: 'unavailable', message: 'Open the Placekeeper reader, wait for the current PDF, then retry. If the document or search changed, inspect it and search again.' });
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const validSource = (value: unknown): value is { fileId: string; digest: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return typeof source.fileId === 'string' && source.fileId.length > 0 && source.fileId.length <= 4096 && typeof source.digest === 'string' && source.digest.length > 0 && source.digest.length <= 512 && Object.keys(source).every(key => key === 'fileId' || key === 'digest');
};
const sameSource = (a: { fileId: string; digest: string }, b: { fileId: string; digest: string }) => a.fileId === b.fileId && a.digest === b.digest;
type ToolName = LiveReaderToolName;
interface ToolSlot { execute?: (input: unknown) => Promise<string> }
interface ToolRegistry { owner?: LiveReaderTools; slots: Map<ToolName, ToolSlot> }
// A register-only host retains names for the document lifetime. Reuse its slots
// on remount, but detach the retired reader before handing them to a new one.
const registries = new WeakMap<DocumentModelContext, ToolRegistry>();
interface RegistrationDiagnostic {
  apiPresent: boolean;
  registerTool: boolean;
  unregisterTool: boolean;
  attemptedName?: ToolName;
  successCount: number;
  failureName?: 'TypeError' | 'Error' | 'DOMException' | 'Other';
}
function registrationFailureName(error: unknown): NonNullable<RegistrationDiagnostic['failureName']> {
  try {
    const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
    return name === 'TypeError' || name === 'Error' || name === 'DOMException' ? name : 'Other';
  } catch { return 'Other'; }
}

export class LiveReaderTools implements ReviewAgentBridge {
  #actions: ReviewAgentActions | undefined;
  #disposed = false;
  readonly #diagnostic: RegistrationDiagnostic;
  readonly #registry: ToolRegistry | undefined;
  readonly #registered: ToolName[] = [];
  constructor(readonly api: DocumentModelContext | undefined, readonly host: { ensureVisible(): Promise<boolean>; available(): boolean; connected?(): boolean }) {
    this.#diagnostic = { apiPresent: !!api, registerTool: typeof api?.registerTool === 'function', unregisterTool: typeof api?.unregisterTool === 'function', successCount: 0 };
    if (!api || typeof api.registerTool !== 'function') return;
    let registry = registries.get(api);
    if (!registry) { registry = { slots: new Map() }; registries.set(api, registry); }
    registry.owner?.dispose();
    this.#registry = registry;
    registry.owner = this;
    const definitions = liveReaderToolDefinitions;
    try {
      for (const [name, description, properties] of definitions) {
        this.#diagnostic.attemptedName = name;
        let slot = registry.slots.get(name);
        if (!slot) {
          const registeredSlot: ToolSlot = {};
          api.registerTool({ name, description, inputSchema: liveReaderInputSchema(properties), annotations: { readOnlyHint: true }, execute: input => registeredSlot.execute?.(input) ?? Promise.resolve(JSON.stringify({ ...unavailable(), reason: 'reader-unavailable' })) });
          slot = registeredSlot;
          registry.slots.set(name, slot);
        }
        slot.execute = input => this.#execute(name, input);
        this.#registered.push(name);
        this.#diagnostic.successCount++;
      }
    } catch (error) { this.#diagnostic.failureName = registrationFailureName(error); this.dispose(); }
  }
  get diagnostic(): Readonly<RegistrationDiagnostic> { return { ...this.#diagnostic }; }
  get supported() { return this.#registered.length === 5 && !this.#disposed; }
  attach(actions: ReviewAgentActions) { if (this.#disposed) return () => {}; this.#actions = actions; return () => { if (this.#actions === actions) this.#actions = undefined; }; }
  dispose() {
    this.#disposed = true;
    this.#actions = undefined;
    const registry = this.#registry;
    if (!registry || registry.owner !== this) return;
    delete registry.owner;
    for (const name of this.#registered.splice(0)) {
      const slot = registry.slots.get(name);
      if (slot) delete slot.execute;
      if (typeof this.api?.unregisterTool === 'function') {
        try { this.api.unregisterTool(name); registry.slots.delete(name); } catch { /* Retain the inactive slot if the host cannot remove it. */ }
      }
    }
  }
  /**
   * Page text for a server-relayed `read_document_text` call. It is never registered
   * on WebMCP and reads the search index, so the reader need not be expanded.
   */
  async readDocumentText(input: unknown): Promise<string> {
    const fail = (reason = 'reader-unavailable') => JSON.stringify({ ...unavailable(), reason });
    try {
      const actions = this.#actions;
      const range = parseDocumentTextRange(input);
      if (range === undefined) return fail('invalid-range');
      const ready = () => !this.#disposed && actions === this.#actions && (this.host.connected?.() ?? this.host.available());
      if (!actions?.pageText || !ready()) return fail();
      const snapshot = actions.snapshot();
      const startPage = range.startPage ?? 1;
      const endPage = Math.min(range.endPage ?? snapshot.pageCount, snapshot.pageCount);
      if (startPage > snapshot.pageCount) return fail('out-of-range-page');
      if (endPage < startPage) return fail('invalid-range');
      const pageText = actions.pageText.bind(actions);
      const text = await formatDocumentText({
        title: snapshot.title, pageCount: snapshot.pageCount, documentGeneration: snapshot.documentGeneration, startPage, endPage,
        read: (first, last) => pageText(first, last),
        current: () => ready() && actions.snapshot().documentGeneration === snapshot.documentGeneration && sameSource(actions.snapshot().source, snapshot.source),
      });
      return text ?? fail('stale-generation');
    } catch { return fail(); }
  }
  async #execute(name: string, input: unknown): Promise<string> {
    const fail = (reason = 'reader-unavailable') => JSON.stringify({ ...unavailable(), reason });
    try {
      const actions = this.#actions;
      if (this.#disposed || !actions || !input || typeof input !== 'object' || Array.isArray(input)) return fail();
      const args = input as Record<string, unknown>;
      if (!await this.host.ensureVisible() || !this.host.available() || actions !== this.#actions) return fail();
      const snapshot = actions.snapshot();
      const current = () => {
        if (actions !== this.#actions || this.#disposed || !this.host.available()) return false;
        const latest = actions.snapshot();
        return latest.documentGeneration === snapshot.documentGeneration && sameSource(latest.source, snapshot.source);
      };
      if (name === 'inspect_review') return JSON.stringify({ status: 'current', ...snapshot, title: snapshot.title.slice(0, 512), selection: snapshot.selection && { ...snapshot.selection, text: snapshot.selection.text.slice(0, 4000) }, annotations: snapshot.annotations.slice(0, 100).map(a => ({ ...a, text: a.text.slice(0, 512) })), truncated: snapshot.title.length > 512 || snapshot.annotations.length > 100 || (snapshot.selection?.text.length ?? 0) > 4000 || snapshot.annotations.some(a => a.text.length > 512) });
      if (!integer(args.documentGeneration)) return fail('invalid-generation');
      if (args.documentGeneration !== snapshot.documentGeneration) return fail('stale-generation');
      if (!validSource(args.source)) return fail('invalid-source');
      if (!sameSource(args.source, snapshot.source)) return fail('stale-source');
      if (name === 'search_document') {
        if (typeof args.query !== 'string' || !args.query.trim() || Array.from(args.query).length > 512) return fail();
        const result = await actions.search(args.query);
        return current() && result.documentGeneration === snapshot.documentGeneration ? JSON.stringify({ ...result, source: snapshot.source }) : fail();
      }
      let target: ReviewAgentTarget;
      if (name === 'navigate_page') {
        if (!integer(args.page) || args.page < 1 || args.page > snapshot.pageCount) return fail('out-of-range-page');
        target = { page: args.page, documentGeneration: args.documentGeneration };
      } else if (name === 'reveal_search_result') {
        if (typeof args.resultId !== 'string' || args.resultId.length > 512) return fail();
        target = { resultId: args.resultId, documentGeneration: args.documentGeneration };
      } else {
        if (typeof args.annotationId !== 'string' || args.annotationId.length > 512) return fail('invalid-annotation');
        if (!snapshot.annotations.some(a => a.id === args.annotationId)) return fail('missing-annotation');
        target = { annotationId: args.annotationId, documentGeneration: args.documentGeneration };
      }
      const moved = await actions.navigate(target);
      return moved && current() ? JSON.stringify({ status: 'navigated', documentGeneration: snapshot.documentGeneration, source: snapshot.source, page: actions.snapshot().page }) : fail(name === 'reveal_search_result' ? 'stale-or-unavailable-result' : 'navigation-unavailable');
    } catch { return fail(); }
  }
}
