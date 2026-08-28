import { basename, dirname, extname, join } from "node:path";

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
  message: "Placekeeper works only in a local VS Code desktop window.",
  recoveryAction: "Open Local Window",
});

export function resolveLauncherPath(
  configured: string | undefined,
  homeDirectory: string,
): string {
  return configured && configured.length > 0
    ? configured
    : join(
        homeDirectory,
        "Applications/Placekeeper.app/Contents/MacOS/placekeeper",
      );
}

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

export type SourceOutputBinding =
  | { readonly kind: "bound"; readonly uri: UriLike }
  | { readonly kind: "choose"; readonly candidates: readonly UriLike[] }
  | { readonly kind: "unavailable" };

/** Deliberately avoids reproducing LaTeX Workshop project/recipe discovery. */
export function resolveSourceOutputBinding(input: {
  readonly explicitPdf?: UriLike;
  readonly activeSource?: UriLike;
  readonly candidates: readonly UriLike[];
}): SourceOutputBinding {
  if (isLocalPdf(input.explicitPdf)) return { kind: "bound", uri: input.explicitPdf };
  const localCandidates = input.candidates.filter(isLocalPdf);
  if (localCandidates.length === 0) return { kind: "unavailable" };
  if (localCandidates.length === 1) return { kind: "bound", uri: localCandidates[0]! };
  if (input.activeSource?.scheme === "file") {
    const sourceExtension = extname(input.activeSource.fsPath);
    const sourceStem = basename(input.activeSource.fsPath, sourceExtension).toLowerCase();
    const besideSource = localCandidates.filter((candidate) =>
      dirname(candidate.fsPath) === dirname(input.activeSource!.fsPath) &&
      basename(candidate.fsPath, extname(candidate.fsPath)).toLowerCase() === sourceStem
    );
    if (besideSource.length === 1) return { kind: "bound", uri: besideSource[0]! };
  }
  return { kind: "choose", candidates: localCandidates };
}
