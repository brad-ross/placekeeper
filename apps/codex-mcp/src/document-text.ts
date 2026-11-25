import type { DocumentAgentPageText } from '../../web/src/host/document-agent-bridge.js';
import { READ_DOCUMENT_TEXT_TOOL, READER_TOOL_MAX_RESULT_CHARS, UNTRUSTED_DOCUMENT_LINE } from './reader-tool-definitions.js';

export interface DocumentTextRange { readonly startPage?: number; readonly endPage?: number }
const pageNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Accepts only `{ startPage?, endPage? }` with one-based integers. */
export function parseDocumentTextRange(input: unknown): DocumentTextRange | undefined {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  if (!Object.keys(raw).every(key => key === 'startPage' || key === 'endPage')) return undefined;
  if (raw.startPage !== undefined && !pageNumber(raw.startPage)) return undefined;
  if (raw.endPage !== undefined && !pageNumber(raw.endPage)) return undefined;
  return { ...(raw.startPage === undefined ? {} : { startPage: raw.startPage }), ...(raw.endPage === undefined ? {} : { endPage: raw.endPage }) };
}

export interface DocumentTextOptions {
  readonly title: string;
  readonly pageCount: number;
  readonly documentGeneration: number;
  readonly startPage: number;
  readonly endPage: number;
  /** Reads one-based pages first..last; rejects when the document changed. */
  readonly read: (firstPage: number, lastPage: number) => Promise<DocumentAgentPageText>;
  /** False once the document or reader changed; the partial result is discarded. */
  readonly current: () => boolean;
  readonly maxChars?: number;
  readonly chunkPages?: number;
}

/** Reserved for the header and truncation notice; the title is capped at 512 characters. */
const headerReserve = 1200;

/** Page-marked text for a range, read in small chunks so a long document stops reading once the cap is reached. */
export async function formatDocumentText(options: DocumentTextOptions): Promise<string | undefined> {
  const maxChars = options.maxChars ?? READER_TOOL_MAX_RESULT_CHARS;
  const chunkPages = Math.max(1, options.chunkPages ?? 10);
  const budget = Math.max(0, maxChars - headerReserve);
  const parts: string[] = [];
  let used = 0, lastShown = options.startPage - 1, next: number | undefined, cutPage: number | undefined;
  outer: for (let first = options.startPage; first <= options.endPage; first += chunkPages) {
    const last = Math.min(options.endPage, first + chunkPages - 1);
    const chunk = await options.read(first, last);
    if (!options.current() || chunk.documentGeneration !== options.documentGeneration) return undefined;
    for (let page = first; page <= last; page++) {
      const text = chunk.pages.find(entry => entry.page === page)?.text;
      const block = `--- Page ${page} ---\n${text == null ? '[No reliable extracted text on this page.]' : text.trimEnd()}\n`;
      if (used + block.length <= budget) { parts.push(block); used += block.length; lastShown = page; continue; }
      if (parts.length === 0) {
        // A single page larger than the cap is shown in part rather than not at all.
        parts.push(block.slice(0, budget)); used = budget; lastShown = page; cutPage = page;
        next = page < options.endPage ? page + 1 : undefined;
      } else next = page;
      break outer;
    }
  }
  const header = [
    UNTRUSTED_DOCUMENT_LINE,
    `Title: ${options.title.slice(0, 512)}`,
    `Pages: ${options.pageCount}`,
    `Document generation: ${options.documentGeneration}`,
    lastShown >= options.startPage ? `Showing pages ${options.startPage}–${lastShown} of ${options.pageCount}.` : `No pages shown.`,
    '',
  ].join('\n');
  const notice = next !== undefined || cutPage !== undefined
    ? `\n[Truncated at ${maxChars.toLocaleString('en-US')} characters${cutPage === undefined ? '' : `; page ${cutPage} is shown only in part`}.${next === undefined ? '' : ` Continue with ${READ_DOCUMENT_TEXT_TOOL} startPage: ${next}.`}]`
    : '';
  return `${header}\n${parts.join('\n')}${notice}`.slice(0, maxChars);
}
