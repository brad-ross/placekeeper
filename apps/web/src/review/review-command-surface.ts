export const REVIEW_COMMAND_IDS = [
  "undo",
  "redo",
  "navigate-back",
  "navigate-forward",
  "find",
  "open-annotations",
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
    { id: "open-annotations", label: "Show Review Items", enabled: input.canOpenAnnotations && input.focusContext !== "dialog" },
    { id: "save-options", label: "Save Options", enabled: input.canOpenSaveOptions && input.focusContext !== "dialog" },
    { id: "zoom-in", label: "Zoom In PDF", enabled: input.canZoom && input.focusContext !== "dialog", shortcut: "Meta+=" },
    { id: "zoom-out", label: "Zoom Out PDF", enabled: input.canZoom && input.focusContext !== "dialog", shortcut: "Meta+-" },
    { id: "fit-width", label: "Fit Width", enabled: input.canFitWidth && input.focusContext !== "dialog" },
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
