import { randomUUID } from "node:crypto";
import { NATIVE_SYNCTEX_FAILURES, type NativeForwardState, type NativeSyncTexFailure } from "../../../../packages/core/src/native-synctex-protocol.js";
import type { SessionBroker } from "../sessions/session-broker.js";
import { dispatchEditorLocation } from "./editor-dispatch.js";
import type { EditorNavigation, NativeEditorIntent } from "./editor-navigation.js";

interface Presentation {
  readonly intent: NativeEditorIntent;
  readonly sessionId: string;
  readonly attachment: Promise<string>;
  readonly expiresAt: number;
  state: NativeForwardState;
  operationEpoch: number;
  querying?: Promise<NativeForwardState>;
}
function editorFailure(reason: string): NativeSyncTexFailure {
  if (["neovim-session-unavailable", "neovim-session-closed", "editor-executable-unavailable", "editor-launch-failed"].includes(reason)) return "editor-unavailable";
  if (reason === "neovim-refused-navigation") return "editor-refused";
  if (reason === "editor-timeout") return "editor-timeout";
  if (reason === "unsupported-editor-location-path") return "editor-location-unsupported";
  return "editor-failed";
}
const failure = (status: string): NativeSyncTexFailure =>
  NATIVE_SYNCTEX_FAILURES.includes(status as NativeSyncTexFailure) ? status as NativeSyncTexFailure : "failed";

export class NativeSyncTex {
  readonly #presentations = new Map<string, Presentation>();
  readonly #dispatch: typeof dispatchEditorLocation;
  readonly #now: () => number;
  constructor(readonly broker: SessionBroker, readonly navigation: EditorNavigation,
    options: { dispatch?: typeof dispatchEditorLocation; now?: () => number } = {}) {
    this.#dispatch = options.dispatch ?? dispatchEditorLocation;
    this.#now = options.now ?? Date.now;
  }
  detach(helperId: string): void {
    const previous = this.#presentations.get(helperId);
    this.#presentations.delete(helperId);
    if (previous !== undefined) void previous.attachment.then(id => this.broker.revokeNavigationAttachment(id)).catch(() => {});
  }
  #current(helperId: string, presentation: Presentation): boolean {
    return this.#presentations.get(helperId) === presentation && this.navigation.isCurrent(presentation.intent) &&
      this.navigation.intentForHelper(helperId) === presentation.intent;
  }
  #presentation(helperId: string, sessionId: string): Presentation | undefined {
    const intent = this.navigation.intentForHelper(helperId);
    const previous = this.#presentations.get(helperId);
    if (intent === undefined) { this.detach(helperId); return undefined; }
    if (previous?.intent === intent && previous.sessionId === sessionId) return previous;
    this.detach(helperId);
    const value: Presentation = { intent, sessionId, operationEpoch: 0, expiresAt: this.#now() + 60_000,
      attachment: this.broker.createNavigationAttachment(sessionId, intent.registration.sourceRoot, intent.request.operation === "forward" ? intent.request.synctexDirectory : undefined),
      state: intent.request.operation === "associate" ? { status: "idle" } : { status: "pending", sequence: intent.sequence } };
    this.#presentations.set(helperId, value);
    return value;
  }
  async invoke(helperId: string, sessionId: string, expectedGeneration: number, method: "forwardSyncTex" | "reverseSyncTex", payload: unknown): Promise<unknown> {
    const p = this.#presentation(helperId, sessionId);
    if (p === undefined) return { status: method === "forwardSyncTex" ? "idle" : "setup-required" };
    const input = payload as Record<string, unknown>;
    if (method === "reverseSyncTex") {
      p.operationEpoch++;
      p.state = { status: "idle" };
      this.navigation.interruptFollowing(p.intent);
    }
    const epoch = p.operationEpoch;
    const operationIsCurrent = () => this.#current(helperId, p) && p.operationEpoch === epoch;
    const attachment = await p.attachment;
    if (!operationIsCurrent()) return { status: method === "forwardSyncTex" ? "idle" : "stale" };
    if (method === "reverseSyncTex") {
      const generation = expectedGeneration;
      if (this.broker.state(sessionId)?.workflow.documentGeneration !== generation) return { status: "stale" };
      const result = await this.broker.reverseSyncTex({ sessionId, navigationAttachmentId: attachment, operationToken: randomUUID(),
        pageIndex: input.pageIndex as number, point: input.point as { x: number; y: number } });
      const isCurrent = () => operationIsCurrent() && this.broker.state(sessionId)?.workflow.documentGeneration === generation;
      if (!isCurrent() || result.documentGeneration !== generation) return { status: "stale" };
      if (result.status !== "ok" || !("target" in result) || result.target === undefined) return { status: "failed", reason: failure(result.status) };
      const dispatched = await this.#dispatch(p.intent.registration, { ...result.target, column: (result.target.column ?? 0) + 1 }, { isCurrent });
      return dispatched.status === "opened" ? { status: "opened" } : { status: dispatched.status, reason: dispatched.status === "stale" ? "stale" : editorFailure(dispatched.reason) };
    }
    if (input.action === "ack") {
      if (p.state.status === "ready" && input.sequence === p.intent.sequence && input.generation === p.state.generation) {
        if (this.broker.state(sessionId)?.workflow.documentGeneration !== p.state.generation || input.outcome === "superseded") {
          p.state = { status: "pending", sequence: p.intent.sequence };
        } else {
          p.state = { status: input.outcome === "applied" ? "applied" : "failed", sequence: p.intent.sequence };
          this.navigation.complete(p.intent);
        }
      }
      return p.state;
    }
    if (p.state.status === "ready" && p.state.generation !== this.broker.state(sessionId)?.workflow.documentGeneration) {
      p.state = { status: "pending", sequence: p.intent.sequence };
    }
    if (p.state.status !== "pending" && p.state.status !== "ready") return p.state;
    if (this.#now() >= p.expiresAt) {
      p.state = { status: "failed", sequence: p.intent.sequence, reason: "timeout" };
      this.navigation.complete(p.intent);
      return p.state;
    }
    if (p.state.status === "ready") return p.state;
    if (p.querying !== undefined) return p.querying;
    const request = p.intent.request;
    if (request.operation !== "forward") return { status: "idle" };
    p.querying = (async (): Promise<NativeForwardState> => {
      const result = await this.broker.forwardSyncTex({ sessionId, navigationAttachmentId: attachment, operationToken: randomUUID(),
        sourcePath: request.sourcePath, line: request.line,
        ...(request.column === undefined ? {} : { column: request.column }) });
      if (!operationIsCurrent()) return { status: "idle" };
      if (result.status === "ok" && "target" in result && result.target !== undefined) {
        p.state = { status: "ready", sequence: p.intent.sequence, generation: result.documentGeneration,
          pageIndex: result.target.pageIndex, point: { x: result.target.x, y: result.target.y } };
      } else if (!["pending", "missing", "stale"].includes(result.status)) {
        p.state = { status: "failed", sequence: p.intent.sequence, reason: failure(result.status) };
        this.navigation.complete(p.intent);
      }
      return p.state;
    })().catch((): NativeForwardState => {
      if (!operationIsCurrent()) return { status: "idle" };
      p.state = { status: "failed", sequence: p.intent.sequence, reason: "failed" };
      this.navigation.complete(p.intent);
      return p.state;
    }).finally(() => { delete p.querying; });
    return p.querying;
  }
}
