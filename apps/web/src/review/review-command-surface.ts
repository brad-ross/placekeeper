export const REVIEW_COMMAND_IDS = [
  "undo",
  "redo",
  "navigate-back",
  "navigate-forward",
  "find",
  "open-annotations",
  "open-outline",
  "open-references",
  "toggle-horizontal-scroll-lock",
  "save-options",
  "fit-width",
  "zoom-in",
  "zoom-out",
] as const;

export type ReviewSemanticCommand = typeof REVIEW_COMMAND_IDS[number];
export type ReviewCommandFocusContext = "review" | "editable" | "dialog";

export interface ReviewCommandPresentation {
  readonly id: ReviewSemanticCommand;
  readonly label: string;
  readonly enabled: boolean;
  readonly shortcut?: string;
}

export interface ReviewCommandSurfaceSnapshot {
  readonly focusContext: ReviewCommandFocusContext;
  readonly commands: readonly ReviewCommandPresentation[];
}

export interface ReviewCommandInvocation {
  readonly id: ReviewSemanticCommand;
  readonly token: number;
}

export type ReviewCommandHandlers = Readonly<Partial<Record<ReviewSemanticCommand, () => void>>>;

export function createReviewCommandSurface(input: {
  readonly focusContext: ReviewCommandFocusContext;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canNavigateBack: boolean;
  readonly canNavigateForward: boolean;
  readonly canFind: boolean;
  readonly canOpenAnnotations: boolean;
  readonly canOpenOutline?: boolean;
  readonly canOpenReferences?: boolean;
  readonly canToggleHorizontalScrollLock?: boolean;
  readonly horizontalScrollLocked?: boolean;
  readonly canOpenSaveOptions: boolean;
  readonly canFitWidth: boolean;
  readonly canZoom: boolean;
  readonly handlers: ReviewCommandHandlers;
}): {
  readonly snapshot: ReviewCommandSurfaceSnapshot;
  invoke(command: ReviewSemanticCommand): boolean;
} {
  const blockedByText = input.focusContext === "editable";
  const commands: readonly ReviewCommandPresentation[] = [
    { id: "undo", label: "Undo Review Change", enabled: input.canUndo && !blockedByText, shortcut: "Meta+Z" },
    { id: "redo", label: "Redo Review Change", enabled: input.canRedo && !blockedByText, shortcut: "Meta+Shift+Z" },
    { id: "navigate-back", label: "Back", enabled: input.canNavigateBack, shortcut: "Meta+[" },
    { id: "navigate-forward", label: "Forward", enabled: input.canNavigateForward, shortcut: "Meta+]" },
    { id: "find", label: "Find in PDF", enabled: input.canFind && input.focusContext !== "dialog", shortcut: "Meta+F" },
    { id: "open-annotations", label: "Show Review Items", enabled: input.canOpenAnnotations && input.focusContext !== "dialog", shortcut: "Control+Meta+A" },
    { id: "open-outline", label: "Show Outline", enabled: input.canOpenOutline === true && input.focusContext === "review", shortcut: "Control+Meta+O" },
    { id: "open-references", label: "Show References", enabled: input.canOpenReferences === true && input.focusContext === "review", shortcut: "Control+Meta+R" },
    { id: "toggle-horizontal-scroll-lock", label: input.horizontalScrollLocked ? "Unlock Horizontal Scrolling" : "Lock Horizontal Scrolling", enabled: input.canToggleHorizontalScrollLock === true && input.focusContext === "review", shortcut: "Control+Meta+L" },
    { id: "save-options", label: "Save Options", enabled: input.canOpenSaveOptions && input.focusContext !== "dialog" },
    { id: "zoom-in", label: "Zoom In PDF", enabled: input.canZoom && input.focusContext !== "dialog", shortcut: "Meta+=" },
    { id: "zoom-out", label: "Zoom Out PDF", enabled: input.canZoom && input.focusContext !== "dialog", shortcut: "Meta+-" },
    { id: "fit-width", label: "Fit Width", enabled: input.canFitWidth && input.focusContext !== "dialog", shortcut: "Control+Meta+0" },
  ];
  const snapshot = { focusContext: input.focusContext, commands } as const;
  return {
    snapshot,
    invoke(command) {
      const presentation = commands.find(({ id }) => id === command);
      const handler = input.handlers[command];
      if (presentation?.enabled !== true || handler === undefined) return false;
      handler();
      return true;
    },
  };
}

/** Host-reserved keys can only route here when the host delivers the event. */
export function reviewCommandForShortcut(event: {
  readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean;
  readonly altKey: boolean; readonly shiftKey: boolean; readonly isComposing: boolean;
}): ReviewSemanticCommand | undefined {
  if (event.isComposing || event.shiftKey || !event.ctrlKey || event.metaKey === event.altKey) return undefined;
  const key = event.key.toLowerCase();
  switch (key) {
    case "0": return "fit-width";
    case "l": return "toggle-horizontal-scroll-lock";
    case "o": return "open-outline";
    case "a": return "open-annotations";
    case "r": return "open-references";
    default: return undefined;
  }
}
