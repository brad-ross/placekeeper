import { followNavigationIsCurrent } from "../../../packages/core/src/source-navigation-intent.js";
export interface SourceCursorLocation {
  readonly sourcePath: string;
  readonly line: number;
  readonly column?: number;
}

export type NavigationRevealOutcome = "revealed" | "retry" | "terminal";
export type RebuildNavigationOutcome = "idle" | NavigationRevealOutcome;

interface SavedEditorLike {
  readonly document: { readonly uri: { toString(): string } };
}

export function preferredSavedEditor<Editor extends SavedEditorLike>(
  activeEditor: Editor | undefined,
  visibleEditors: readonly Editor[],
  documentKey: string,
): Editor | undefined {
  if (activeEditor?.document.uri.toString() === documentKey) return activeEditor;
  return visibleEditors.find((editor) => editor.document.uri.toString() === documentKey);
}

export type RebuildNavigationAction = "ignore" | "navigate";

export function rebuildNavigationAction(
  status: unknown,
  reason: "watcher" | "reveal" | "activation" | "interval",
  canRetryCurrent: boolean,
): RebuildNavigationAction {
  if (status === "committed") return "navigate";
  if (status !== "same-digest") return "ignore";
  return reason === "watcher" || canRetryCurrent ? "navigate" : "ignore";
}

interface NavigationIntent {
  readonly id: number;
  readonly location: SourceCursorLocation;
  readonly association: number;
}

/** Keeps a saved source cursor stable until its rebuilt PDF can be revealed. */
export class RebuildNavigationCoordinator {
  #nextId = 0;
  #association = 0;
  #explicitPending = false;
  #acknowledgement: { association: number; generation: number; timer: ReturnType<typeof setTimeout> } | undefined;
  constructor(readonly options: { followEnabled?: () => boolean } = {}) {}

  beginExplicit(): number {
    this.#clearAcknowledgement();
    this.#association++;
    this.cancelFollowing();
    this.#explicitPending = true;
    return this.#association;
  }
  isExplicitCurrent(association: number): boolean { return association === this.#association; }
  finishExplicit(association: number): void {
    if (this.isExplicitCurrent(association)) {
      this.#clearAcknowledgement();
      this.#explicitPending = false;
    }
  }
  awaitExplicitAcknowledgement(association: number, generation: number, onTimeout: () => void): void {
    if (!this.isExplicitCurrent(association) || !this.#explicitPending) return;
    this.#clearAcknowledgement();
    const timer = setTimeout(() => {
      if (this.#acknowledgement?.association !== association) return;
      this.finishExplicit(association);
      onTimeout();
    }, 60_000);
    timer.unref?.();
    this.#acknowledgement = { association, generation, timer };
  }
  acknowledgeExplicit(association: number, generation: number): void {
    if (this.#acknowledgement?.association === association && this.#acknowledgement.generation === generation) {
      this.finishExplicit(association);
    }
  }
  dispose(): void {
    this.#clearAcknowledgement();
    this.#association++;
    this.#explicitPending = false;
    this.cancelFollowing();
  }
  #clearAcknowledgement(): void {
    if (this.#acknowledgement !== undefined) clearTimeout(this.#acknowledgement.timer);
    this.#acknowledgement = undefined;
  }
  cancelFollowing(): void {
    this.#pending = undefined;
    this.#active = undefined;
    this.#retryIntentId = undefined;
    this.#ready = false;
  }

  #pending: NavigationIntent | undefined;
  #active: NavigationIntent | undefined;
  #retryIntentId: number | undefined;
  #ready = false;
  #draining: Promise<RebuildNavigationOutcome> | undefined;

  get hasPending(): boolean { return this.#pending !== undefined; }
  get canRetryCurrent(): boolean {
    return this.#pending !== undefined && this.#retryIntentId === this.#pending.id;
  }

  noteSourceSaved(location: SourceCursorLocation): void {
    if (this.options.followEnabled?.() !== true || this.#explicitPending) return;
    this.#nextId += 1;
    this.#pending = { id: this.#nextId, location, association: this.#association };
    this.#retryIntentId = undefined;
  }

  forwardSourceLocation(
    fallback?: () => SourceCursorLocation | undefined,
  ): SourceCursorLocation | undefined {
    return this.#active?.location ?? fallback?.();
  }

  revealAfterRebuild(
    reveal: (isCurrent: () => boolean) => Promise<NavigationRevealOutcome>,
  ): Promise<RebuildNavigationOutcome> {
    if (this.options.followEnabled?.() !== true) this.cancelFollowing();
    if (this.#pending === undefined) return Promise.resolve("idle");
    this.#ready = true;
    if (this.#draining !== undefined) return this.#draining;
    this.#draining = this.#drain(reveal).finally(() => { this.#draining = undefined; });
    return this.#draining;
  }

  async #drain(reveal: (isCurrent: () => boolean) => Promise<NavigationRevealOutcome>): Promise<RebuildNavigationOutcome> {
    let result: RebuildNavigationOutcome = "idle";
    while (this.#ready && this.#pending !== undefined) {
      this.#ready = false;
      const intent = this.#pending;
      this.#active = intent;
      try {
        result = await reveal(() => this.options.followEnabled?.() === true && this.#pending?.id === intent.id &&
          followNavigationIsCurrent({ captured: intent.association, current: this.#association, explicitPending: this.#explicitPending }));
        if (this.#pending?.id !== intent.id) continue;
        if (result === "retry") this.#retryIntentId = intent.id;
        else {
          this.#pending = undefined;
          this.#retryIntentId = undefined;
        }
      } finally {
        this.#active = undefined;
      }
    }
    return result;
  }
}
