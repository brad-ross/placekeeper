export interface SourceDocumentLike {
  readonly uri: { toString(): string };
}

export interface VisibleSourceEditorLike<Document extends SourceDocumentLike = SourceDocumentLike> {
  readonly document: Document;
  readonly viewColumn?: number;
}

export function preferredVisibleSourceEditor<T extends VisibleSourceEditorLike>(
  visibleEditors: readonly T[],
  sourceUri: SourceDocumentLike["uri"],
): T | undefined {
  const targetUri = sourceUri.toString();
  return visibleEditors.find((editor) =>
    editor.viewColumn !== undefined && editor.document.uri.toString() === targetUri
  );
}

export interface SourceTabGroupLike {
  readonly viewColumn: number;
  readonly tabs: readonly { readonly input: unknown }[];
}

export interface OpenSourceEditorOptions<
  Document extends SourceDocumentLike,
  Editor extends VisibleSourceEditorLike<Document>,
> {
  readonly sourceUri: SourceDocumentLike["uri"];
  readonly visibleEditors: readonly Editor[];
  readonly tabGroups: readonly SourceTabGroupLike[];
  readonly avoidViewColumn?: number;
  readonly tabResourceUri: (input: unknown) => SourceDocumentLike["uri"] | undefined;
  readonly openTextDocument: () => Promise<Document>;
  readonly showTextDocument: (
    document: Document,
    options: { readonly viewColumn?: number; readonly preview: true; readonly preserveFocus: false },
  ) => Promise<Editor>;
}

export async function openSourceEditor<
  Document extends SourceDocumentLike,
  Editor extends VisibleSourceEditorLike<Document>,
>(options: OpenSourceEditorOptions<Document, Editor>): Promise<Editor> {
  const visibleEditor = preferredVisibleSourceEditor(options.visibleEditors, options.sourceUri);
  const targetUri = options.sourceUri.toString();
  const matchingGroups = options.tabGroups.filter((group) => group.tabs.some((tab) =>
    options.tabResourceUri(tab.input)?.toString() === targetUri
  ));
  const hiddenTabGroup = matchingGroups.find((group) => group.viewColumn !== options.avoidViewColumn) ??
    matchingGroups[0];
  const viewColumn = visibleEditor?.viewColumn ?? hiddenTabGroup?.viewColumn;
  const document = visibleEditor?.document ?? await options.openTextDocument();
  return options.showTextDocument(document, {
    ...(viewColumn === undefined ? {} : { viewColumn }),
    preview: true,
    preserveFocus: false,
  });
}

export interface SourceLineReveal {
  readonly character: number;
  readonly highlightStart: number;
  readonly highlightEnd: number;
}

export function sourceLineNumber(documentLineCount: number, syncTexLine: number): number | undefined {
  return Number.isSafeInteger(syncTexLine) && syncTexLine >= 1 && syncTexLine <= documentLineCount
    ? syncTexLine - 1
    : undefined;
}

export function sourceLineReveal(lineText: string, column?: number): SourceLineReveal | undefined {
  const hasExactColumn = column !== undefined && Number.isSafeInteger(column) && column >= 0;
  if (hasExactColumn && column > lineText.length) return undefined;
  const firstNonWhitespace = lineText.search(/\S/u);
  const character = hasExactColumn
    ? column
    : firstNonWhitespace < 0 ? 0 : firstNonWhitespace;
  return {
    character,
    highlightStart: hasExactColumn ? character : 0,
    highlightEnd: hasExactColumn ? Math.min(character + 1, lineText.length) : lineText.length,
  };
}
