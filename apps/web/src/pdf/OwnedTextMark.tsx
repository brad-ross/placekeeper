import { useEffect, useState, type ComponentProps } from 'react';
import type { PdfDocumentObject, PdfEngine, PdfGlyphObject, PdfPageObject } from '@embedpdf/models';
import { textCenterFraction, textMarkGeometry } from './text-mark-geometry.js';
import type { PdfRect } from '../../../../packages/core/src/pdf-writer.js';

const glyphCache = new WeakMap<PdfDocumentObject, Map<number, Promise<PdfGlyphObject[]>>>();


export function OwnedTextMark({ engine, document, page, rect, textAnchored, style, ...props }:
  ComponentProps<'span'> & { engine: PdfEngine; document: PdfDocumentObject; page: PdfPageObject; rect: PdfRect; textAnchored: boolean }) {
  const [measurement, setMeasurement] = useState<{ document: PdfDocumentObject; pageIndex: number; glyphs: PdfGlyphObject[] }>();
  useEffect(() => {
    if (!textAnchored) return;
    let current = true;
    let pages = glyphCache.get(document);
    if (!pages) { pages = new Map(); glyphCache.set(document, pages); }
    let read = pages.get(page.index);
    if (!read) {
      read = engine.getPageGlyphs(document, page).toPromise();
      pages.set(page.index, read);
      void read.catch(() => pages!.delete(page.index));
    }
    void read.then((glyphs) => { if (current) setMeasurement({ document, pageIndex: page.index, glyphs }); }, () => {});
    return () => { current = false; };
  }, [engine, document, page.index, textAnchored]);
  const fraction = measurement?.document === document && measurement.pageIndex === page.index
    ? textCenterFraction(rect, measurement.glyphs) : undefined;
  if (!textAnchored) return <span {...props} style={style} />;
  const geometry = textMarkGeometry(rect, Number(style?.height ?? rect.height), fraction);
  return <span {...props} style={{ ...style,
    height: geometry.height,
    transform: `${style?.transform ?? ''} translateY(${geometry.offset}px)`,
    ...{ '--pdf-strike-position': geometry.strikePosition },
  }} />;
}
