import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

/** Only fields explicitly present in the source override reader defaults. */
export interface SourceAnnotationStyle {
  readonly hasExplicitColor?: true;
  readonly opacity?: number;
}
export interface SourceAnnotationStyles {
  readonly byIndex: ReadonlyMap<string, SourceAnnotationStyle>;
  readonly pageAnnotationCounts: readonly number[];
}
const supported = new Set(['Highlight', 'StrikeOut', 'Underline', 'Squiggly', 'Caret', 'Text']);

/** Absence from this map means preserve the original renderer, including on uncertainty. */
export async function readSourceAnnotationStyles(bytes: Uint8Array): Promise<SourceAnnotationStyles> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageAnnotationCounts: number[] = [];
  const styles = new Map<string, SourceAnnotationStyle>();
  pdf.getPages().forEach((page, pageIndex) => {
    const annotations = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    pageAnnotationCounts.push(annotations?.size() ?? 0);
    if (!annotations) return;
    for (let index = 0; index < annotations.size(); index++) {
      const annotation = annotations.lookupMaybe(index, PDFDict);
      if (!annotation) continue;
      const subtype = annotation.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText();
      if (!subtype || !supported.has(subtype)) continue;
      // AP does not say whether its author used a stock tool or drew it manually.
      // Preserve it, and preserve richer border/rotation/icon instructions too.
      if (['AP', 'BS', 'BE', 'Border', 'RD', 'Rotate', 'MK', 'IT', 'AS'].some((key) => annotation.has(PDFName.of(key)))) continue;
      const name = annotation.lookupMaybe(PDFName.of('Name'), PDFName)?.decodeText();
      if (subtype === 'Text' && name !== undefined && !['Note', 'Comment', 'Insert'].includes(name)) continue;
      const color = annotation.lookupMaybe(PDFName.of('C'), PDFArray);
      if (annotation.has(PDFName.of('C')) && (!color || ![1, 3, 4].includes(color.size()) ||
        color.asArray().some((value) => !(value instanceof PDFNumber) || value.asNumber() < 0 || value.asNumber() > 1))) continue;
      const opacity = annotation.lookupMaybe(PDFName.of('CA'), PDFNumber)?.asNumber();
      if (annotation.has(PDFName.of('CA')) && (opacity === undefined || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)) continue;
      styles.set(`${pageIndex}:${index}`, {
        ...(color === undefined ? {} : { hasExplicitColor: true }),
        ...(opacity === undefined ? {} : { opacity }),
      });
    }
  });
  return { byIndex: styles, pageAnnotationCounts };
}

/** The caller validates the source URL using its host's document resource policy. */
export async function fetchSourceAnnotationStyles(options: { url: string; requestOptions?: RequestInit }): Promise<SourceAnnotationStyles> {
  try {
    const response = await fetch(options.url, {
      ...options.requestOptions, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Source style inventory unavailable');
    return await readSourceAnnotationStyles(new Uint8Array(await response.arrayBuffer()));
  } catch {
    // Optional styling must not strand native annotation discovery on a failed request.
    return { byIndex: new Map(), pageAnnotationCounts: [] };
  }
}
