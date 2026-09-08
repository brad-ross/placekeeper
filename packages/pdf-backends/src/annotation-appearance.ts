import { pdfAnnotationIdentity } from './embedpdf-annotation.js';
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import { ANNOTATION_PALETTE as palette, annotationAppearance, READER_APPEARANCE_KEY } from '../../core/src/annotation-appearance.js';
import { PdfWriterError, type ReviewAnnotation } from '../../core/src/pdf-writer.js';
import { textCenterFraction, textMarkGeometry, type MarkGlyph } from '../../core/src/text-mark-geometry.js';

const number = (value: number) => Number(value.toFixed(5)).toString();
const rgb = (hex: string) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
const color = (hex: string) => rgb(hex).map(number).join(' ');

function roundedRect(x: number, y: number, w: number, h: number): string {
  const r = Math.min(palette.radius, w / 2, h / 2), k = r * .55228475;
  return [
    `${x + r} ${y} m`, `${x + w - r} ${y} l`, `${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r} c`,
    `${x + w} ${y + h - r} l`, `${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h} c`,
    `${x + r} ${y + h} l`, `${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r} c`,
    `${x} ${y + r} l`, `${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y} c`, 'h',
  ].join('\n');
}

function appearanceContent(annotation: ReviewAnnotation, glyphs: readonly MarkGlyph[]): string {
  const style = annotationAppearance(annotation);
  const { width, height } = annotation.rect;
  const commands = ['q', '/PKInk gs', `${color(style.ink)} rg`, `${color(style.ink)} RG`, `${palette.lineWidth} w`, '1 J', '1 j'];
  if (annotation.kind === 'insert') {
    // A steady caret, contained in the semantic anchor so hit-testing stays intact.
    const half = Math.min(4.25, Math.max(0, (width - palette.lineWidth) / 2));
    const bottom = palette.lineWidth / 2;
    commands.push(`${width / 2 - half} ${bottom} m ${width / 2} ${bottom + half} l ${width / 2 + half} ${bottom} l S`);
  } else if (annotation.kind === 'pageNote') {
    commands.push('q', '/PKFill gs', `${color(style.fill)} rg`, roundedRect(0, 0, width, height), 'f', 'Q');
    const size = Math.min(width * .7, height * .7, 18);
    commands.push('q', `${size / 24} 0 0 ${size / 24} ${(width - size) / 2} ${(height - size) / 2} cm`);
    // Folded note outline, matching the reader's note symbol (24-unit icon box).
    commands.push('3 5 m 3 19 l 3 20.1046 3.8954 21 5 21 c 15 21 l 21 15 l 21 5 l 21 3.8954 20.1046 3 19 3 c 5 3 l 3.8954 3 3 3.8954 3 5 c h S');
    commands.push('15 21 m 15 16 l 15 15.4477 15.4477 15 16 15 c 21 15 l S', 'Q');
  } else {
    for (const rect of annotation.quadPoints ?? [annotation.rect]) {
      const centerFraction = textCenterFraction(rect, glyphs) ?? .5;
      const geometry = textMarkGeometry(rect, rect.height, centerFraction);
      const x = rect.x - annotation.rect.x;
      const top = rect.y - annotation.rect.y + (rect.height - geometry.height) / 2 + geometry.offset;
      const bottom = height - top - geometry.height;
      if (style.opacity > 0) commands.push('q', '/PKFill gs', `${color(style.fill)} rg`, roundedRect(x, bottom, rect.width, geometry.height), 'f', 'Q');
      if (annotation.kind === 'replace' || annotation.kind === 'delete') {
        const y = height - (rect.y - annotation.rect.y + rect.height * centerFraction);
        commands.push(`${x} ${y} m ${x + rect.width} ${y} l S`);
      }
      if (style.underline) {
        // Keep the underline visible when the optical padding crosses /Rect.
        const y = Math.max(palette.underlineWidth / 2, bottom + palette.underlineWidth / 2);
        commands.push('q', `${palette.underlineWidth} w`, `${x} ${y} m ${x + rect.width} ${y} l S`, 'Q');
      }
    }
  }
  return [...commands, 'Q'].join('\n');
}

/** Only newly created marks get a new /AP. Preserved and imported marks keep theirs. */
export async function saveWithReaderAppearances(
  engine: Pick<PdfEngine, 'getPageGlyphs' | 'saveAsCopy'>,
  document: PdfDocumentObject,
  created: readonly ReviewAnnotation[],
): Promise<Uint8Array> {
  const glyphsByPage = new Map<number, readonly MarkGlyph[]>();
  const textPages = [...new Set(created.filter(({ kind }) => ['highlight', 'delete', 'replace'].includes(kind)).map(({ pageIndex }) => pageIndex))];
  for (let start = 0; start < textPages.length; start += 8) {
    await Promise.all(textPages.slice(start, start + 8).map(async (pageIndex) => {
      // The reader uses the same midpoint fallback when glyph measurements fail.
      const glyphs = await engine.getPageGlyphs(document, document.pages[pageIndex]!).toPromise().catch(() => []);
      glyphsByPage.set(pageIndex, glyphs);
    }));
  }
  const bytes = new Uint8Array(await engine.saveAsCopy(document).toPromise());
  if (created.length === 0) return bytes;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const requested = new Map(created.map((annotation) => [pdfAnnotationIdentity(annotation.pageIndex, annotation.id), annotation]));
  for (const pageIndex of new Set(created.map(({ pageIndex }) => pageIndex))) {
    const page = pdf.getPage(pageIndex);
    const dictionaries = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!dictionaries) continue;
    for (let index = 0; index < dictionaries.size(); index++) {
      const dictionary = dictionaries.lookupMaybe(index, PDFDict);
      const name = dictionary?.lookup(PDFName.of('NM'));
      if (!dictionary || !(name instanceof PDFString || name instanceof PDFHexString)) continue;
      const key = pdfAnnotationIdentity(pageIndex, name.decodeText());
      const annotation = requested.get(key);
      if (!annotation) continue;
      const rect = dictionary.lookup(PDFName.of('Rect'), PDFArray);
      const values = Array.from({ length: 4 }, (_, i) => rect.lookup(i, PDFNumber).asNumber());
      const width = values[2]! - values[0]!, height = values[3]! - values[1]!;
      if (!(width > 0 && height > 0 && annotation.rect.width > 0 && annotation.rect.height > 0)) {
        throw new PdfWriterError('invalid-annotation-geometry', 'An exported appearance has empty bounds.');
      }
      // Text icons are resized by PDFium. Paint at the persisted size so a
      // 2pt insertion anchor cannot magnify a 1.5pt stroke into a solid block.
      const paintAnnotation = annotation.kind === 'insert' || annotation.kind === 'pageNote'
        ? { ...annotation, rect: { ...annotation.rect, width, height } } : annotation;
      const style = annotationAppearance(annotation);
      const stream = pdf.context.flateStream(appearanceContent(paintAnnotation, glyphsByPage.get(pageIndex) ?? []), {
        Type: 'XObject', Subtype: 'Form', FormType: 1,
        [READER_APPEARANCE_KEY]: 1,
        BBox: [0, 0, paintAnnotation.rect.width, paintAnnotation.rect.height],
        Matrix: [1, 0, 0, 1, 0, 0],
        Resources: { ExtGState: {
          PKInk: { Type: 'ExtGState', CA: 1, ca: 1, BM: 'Multiply' },
          PKFill: { Type: 'ExtGState', CA: style.opacity, ca: style.opacity, BM: 'Multiply' },
        } },
      });
      const ap = dictionary.lookupMaybe(PDFName.of('AP'), PDFDict) ?? pdf.context.obj({});
      ap.set(PDFName.of('N'), pdf.context.register(stream));
      dictionary.set(PDFName.of('AP'), ap);
      // Keep standard highlight opacity for readers that regenerate markup.
      // The normal appearance separately encodes opaque ink over its wash.
      dictionary.set(PDFName.of('CA'), PDFNumber.of(annotation.kind === 'highlight' ? style.opacity : 1));
      dictionary.set(PDFName.of('C'), pdf.context.obj(rgb(annotation.kind === 'highlight' ? style.fill : style.ink)));
      requested.delete(key);
    }
  }
  if (requested.size > 0) throw new PdfWriterError('backend-error', 'An exported annotation is missing its appearance target.');
  return pdf.save({ useObjectStreams: false, addDefaultPage: false });
}
