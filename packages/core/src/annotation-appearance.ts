import type { ReviewAnnotation } from './pdf-writer.js';

export const READER_APPEARANCE_KEY = 'PlacekeeperStyleVersion';

/** Resting PDF marks only. Hover, selection, and reader chrome are UI state. */
export const ANNOTATION_PALETTE = {
  noteFill: '#f5c423', noteInk: '#b1840d', noteOpacity: .36, commentOpacity: .25,
  editFill: '#6994a9', editInk: '#5e7588', editOpacity: .23,
  correctionFill: '#da4e4e', correctionInk: '#c34f54', correctionOpacity: .2,
  lineWidth: 1.5, underlineWidth: 1, radius: 3,
} as const;

const p = ANNOTATION_PALETTE;
const rgba = (hex: string, alpha: number) => `rgb(${[1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)).join(' ')} / ${alpha * 100}%)`;

export const ANNOTATION_CSS_VARIABLES = {
  '--pdf-note-fill': rgba(p.noteFill, p.noteOpacity),
  '--pdf-comment-fill': rgba(p.noteFill, p.commentOpacity),
  '--pdf-note-ink': p.noteInk,
  '--pdf-edit-fill': rgba(p.editFill, p.editOpacity),
  '--pdf-edit-ink': p.editInk,
  '--pdf-correction-fill': rgba(p.correctionFill, p.correctionOpacity),
  '--pdf-correction-ink': p.correctionInk,
  '--pdf-mark-base-line-width': `${p.lineWidth}px`,
  '--pdf-mark-base-underline-width': `${p.underlineWidth}px`,
  '--pdf-mark-radius': `${p.radius}px`,
} as const;

export function annotationAppearance(annotation: Pick<ReviewAnnotation, 'kind' | 'contents'>) {
  const attached = annotation.contents.trim().length > 0;
  switch (annotation.kind) {
    case 'highlight': return { ink: p.noteInk, fill: p.noteFill, opacity: attached ? p.commentOpacity : p.noteOpacity, underline: attached };
    case 'pageNote': return { ink: p.noteInk, fill: p.noteFill, opacity: p.noteOpacity, underline: false };
    case 'replace': return { ink: p.correctionInk, fill: p.correctionFill, opacity: p.correctionOpacity, underline: attached };
    case 'delete': return { ink: p.correctionInk, fill: p.correctionFill, opacity: 0, underline: false };
    case 'insert': return { ink: p.editInk, fill: p.editFill, opacity: 0, underline: false };
    case 'pdfAnnotation': throw new Error('Imported PDF appearances belong to their original reader.');
  }
}
