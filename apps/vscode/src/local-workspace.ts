export interface LaunchErrorPresentation {
  readonly kind: "input-unavailable" | "unsupported-context" | "upgrade-required";
  readonly message: string;
  readonly recoveryAction: string;
}

export const INPUT_UNAVAILABLE: LaunchErrorPresentation = Object.freeze({
  kind: "input-unavailable",
  message: "Choose one readable local PDF.",
  recoveryAction: "Choose PDF",
});

export const UNSUPPORTED_CONTEXT: LaunchErrorPresentation = Object.freeze({
  kind: "unsupported-context",
  message: "PDF Proofreader works only in a local VS Code desktop window.",
  recoveryAction: "Open Local Window",
});

export interface WorkspaceContext {
  readonly remoteName?: string;
  readonly uiKind: "desktop" | "web";
  readonly workspaceSchemes: readonly string[];
}

export interface UriLike {
  readonly scheme: string;
  readonly fsPath: string;
}

export function classifyWorkspace(
  context: WorkspaceContext,
): LaunchErrorPresentation | undefined {
  if (
    context.remoteName !== undefined ||
    context.uiKind !== "desktop" ||
    context.workspaceSchemes.some((scheme) => scheme !== "file")
  ) {
    return UNSUPPORTED_CONTEXT;
  }
  return undefined;
}

function isLocalPdf(uri: UriLike | undefined): uri is UriLike {
  return uri?.scheme === "file" && uri.fsPath.toLowerCase().endsWith(".pdf");
}

export function choosePdfInput(input: {
  readonly active?: UriLike;
  readonly selected: readonly UriLike[];
}): string | LaunchErrorPresentation {
  const uri = choosePdfUriInput(input);
  return "scheme" in uri ? uri.fsPath : uri;
}

export function choosePdfUriInput(input: {
  readonly active?: UriLike;
  readonly selected: readonly UriLike[];
}): UriLike | LaunchErrorPresentation {
  if (input.selected.length === 1 && isLocalPdf(input.selected[0])) {
    return input.selected[0];
  }
  if (input.selected.length === 0 && isLocalPdf(input.active)) {
    return input.active;
  }
  return INPUT_UNAVAILABLE;
}

export function localSourceRoot(
  pdf: UriLike,
  workspaceFolder: UriLike | undefined,
): string | undefined {
  return workspaceFolder?.scheme === "file" && pdf.scheme === "file"
    ? workspaceFolder.fsPath
    : undefined;
}
