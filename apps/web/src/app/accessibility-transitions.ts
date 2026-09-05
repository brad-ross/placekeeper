export type AccessibilityTransitionKind =
  | "document-ready"
  | "recoverable-failure"
  | "retrying"
  | "replacement-ready"
  | "protected-recovery"
  | "terminal-recovery";

export type AccessibilityTransitionFocus =
  | "document-workspace-if-loading"
  | "first-recovery-action-if-needed"
  | "retry-status"
  | "restore-semantic-target";

export interface AccessibilityTransitionEffect {
  readonly token: number;
  readonly attemptId: string;
  readonly kind: AccessibilityTransitionKind;
  readonly announcement: string;
  readonly focus: AccessibilityTransitionFocus;
}

const PRESENTATION = {
  "document-ready": {
    announcement: "The document is ready.",
    focus: "document-workspace-if-loading",
  },
  "recoverable-failure": {
    announcement: "This review could not be prepared. Recovery actions are available.",
    focus: "first-recovery-action-if-needed",
  },
  retrying: {
    announcement: "Placekeeper is retrying.",
    focus: "retry-status",
  },
  "replacement-ready": {
    announcement: "The review was restored.",
    focus: "restore-semantic-target",
  },
  "protected-recovery": {
    announcement: "Protected review recovery is available.",
    focus: "first-recovery-action-if-needed",
  },
  "terminal-recovery": {
    announcement: "This review needs to be reopened. Recovery actions are available.",
    focus: "first-recovery-action-if-needed",
  },
} as const satisfies Record<AccessibilityTransitionKind, {
  readonly announcement: string;
  readonly focus: AccessibilityTransitionFocus;
}>;

/** Owns one-shot accessibility effects for exactly one current window attempt. */
export class AccessibilityTransitionCoordinator {
  private currentAttemptId: string | null = null;
  private readonly emitted = new Set<string>();
  private token = 0;

  activateAttempt(attemptId: string): void {
    if (attemptId === this.currentAttemptId) return;
    this.currentAttemptId = attemptId;
    this.emitted.clear();
  }

  transition(input: {
    readonly attemptId: string;
    readonly visible: boolean;
    readonly kind: AccessibilityTransitionKind;
    readonly generation?: number;
  }): AccessibilityTransitionEffect | undefined {
    if (!input.visible || input.attemptId !== this.currentAttemptId) return undefined;
    const key = `${input.kind}:${input.generation ?? "attempt"}`;
    if (this.emitted.has(key)) return undefined;
    this.emitted.add(key);
    const presentation = PRESENTATION[input.kind];
    return {
      token: ++this.token,
      attemptId: input.attemptId,
      kind: input.kind,
      announcement: presentation.announcement,
      focus: presentation.focus,
    };
  }
}
