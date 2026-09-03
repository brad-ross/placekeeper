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
}

/** Keeps a saved source cursor stable until its rebuilt PDF can be revealed. */
export class RebuildNavigationCoordinator {
  #nextId = 0;
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
    this.#nextId += 1;
    this.#pending = { id: this.#nextId, location };
    this.#retryIntentId = undefined;
  }

  forwardSourceLocation(
    fallback?: () => SourceCursorLocation | undefined,
  ): SourceCursorLocation | undefined {
    return this.#active?.location ?? fallback?.();
  }

  revealAfterRebuild(
    reveal: () => Promise<NavigationRevealOutcome>,
  ): Promise<RebuildNavigationOutcome> {
    if (this.#pending === undefined) return Promise.resolve("idle");
    this.#ready = true;
    if (this.#draining !== undefined) return this.#draining;
    this.#draining = this.#drain(reveal).finally(() => { this.#draining = undefined; });
    return this.#draining;
  }

  async #drain(reveal: () => Promise<NavigationRevealOutcome>): Promise<RebuildNavigationOutcome> {
    let result: RebuildNavigationOutcome = "idle";
    while (this.#ready && this.#pending !== undefined) {
      this.#ready = false;
      const intent = this.#pending;
      this.#active = intent;
      try {
        result = await reveal();
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
