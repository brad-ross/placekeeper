export const MAX_PDF_NAVIGATION_LABEL_LENGTH = 160;

const AUTHOR_CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const MARKUP_DELIMITER = /[<>]/gu;
const DISRUPTIVE_WHITESPACE = /\s+/gu;

export type PdfNavigationMetadataSource =
  | 'contents'
  | 'subject'
  | 'source-text'
  | 'page-context';

export interface PdfNavigationMetadataInput {
  readonly contents?: unknown;
  readonly subject?: unknown;
  readonly sourceText?: unknown;
  readonly pageIndex: number;
  readonly maxLabelLength?: number;
}

export interface PdfNavigationMetadata {
  /** Plain display text only. Consumers must not interpret it as markup. */
  readonly label: string;
  /** Sanitized author-provided text, kept separate from trusted page context. */
  readonly authorLabel: string | null;
  readonly pageContext: string;
  readonly source: PdfNavigationMetadataSource;
}

function normalizeAuthorText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(AUTHOR_CONTROL_OR_BIDI, ' ')
    .replace(MARKUP_DELIMITER, '')
    .replace(DISRUPTIVE_WHITESPACE, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function boundDisplayText(value: string, maxLength: number): string {
  const codePoints = [...value];
  if (codePoints.length <= maxLength) return value;
  if (maxLength === 1) return '…';
  return `${codePoints.slice(0, maxLength - 1).join('')}…`;
}

/** Creates inert, bounded labels while preserving trusted page context separately. */
export function createPdfNavigationMetadata(
  input: PdfNavigationMetadataInput,
): PdfNavigationMetadata {
  if (
    !Number.isSafeInteger(input.pageIndex) ||
    input.pageIndex < 0 ||
    input.pageIndex >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error('PDF navigation page index must be a non-negative safe integer.');
  }
  const maxLength = input.maxLabelLength ?? MAX_PDF_NAVIGATION_LABEL_LENGTH;
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error('PDF navigation label length must be a positive safe integer.');
  }

  const pageContext = `Page ${input.pageIndex + 1}`;
  const candidates = [
    ['contents', input.contents],
    ['subject', input.subject],
    ['source-text', input.sourceText],
  ] as const;
  for (const [source, value] of candidates) {
    const authorLabel = normalizeAuthorText(value);
    if (authorLabel !== null) {
      const label = boundDisplayText(authorLabel, maxLength);
      return {
        label,
        authorLabel: label,
        pageContext,
        source,
      };
    }
  }
  return { label: pageContext, authorLabel: null, pageContext, source: 'page-context' };
}
