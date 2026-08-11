import {
  PdfErrorCode,
  type PdfDocumentObject,
  type PdfEngine,
  type PdfGlyphObject,
  type PdfTask,
  type Rect,
} from '@embedpdf/models';

import { assessPageTextReliability, type TextRect } from './text-reliability.js';
import {
  PDF_SEARCH_MAX_INDEX_BYTES,
  PDF_SEARCH_MAX_PAGE_READS,
  PDF_SEARCH_MAX_QUERY_CODE_POINTS,
  buildSearchResultId,
  canonicalizeFormula,
  canonicalizeProse,
  classifyPdfSearchQuery,
  initialPdfSearchState,
  type PdfSearchAlternative,
  type PdfSearchMatchKind,
  type PdfSearchResult,
  type PdfSearchState,
} from './pdf-search-model.js';
import { relatedPhraseQueries } from './pdf-search-morphology.js';
import {
  detectedSymbolSuggestions,
  isSymbolAliasQuery,
  resolveDetectedSymbolQuery,
} from './pdf-symbol-catalog.js';

export interface PdfSearchPageSnapshot {
  readonly text: string;
  readonly glyphs: readonly PdfGlyphObject[];
  readonly textRects: readonly TextRect[];
}

export interface PdfSearchPageReader {
  readonly pageCount: number;
  read(pageIndex: number, signal: AbortSignal): Promise<PdfSearchPageSnapshot>;
  dispose?(): void;
}

interface IndexedPage extends PdfSearchPageSnapshot {
  readonly pageIndex: number;
}

export interface PdfSearchController {
  getState(): PdfSearchState;
  subscribe(listener: (state: PdfSearchState) => void): () => void;
  prepare(): Promise<PdfSearchState>;
  search(query: string): Promise<PdfSearchState>;
  selectResult(resultId: string | null): void;
  clear(): void;
  dispose(): void;
}

export interface CreatePdfSearchControllerOptions {
  readonly documentGeneration: number;
  readonly reader: PdfSearchPageReader;
  readonly maxIndexBytes?: number;
  readonly maxPageReads?: number;
}

function abortableTask<T>(task: PdfTask<T, unknown> | PdfTask<T>, signal: AbortSignal): Promise<T> {
  const abort = () => {
    try {
      task.abort({ code: PdfErrorCode.Cancelled, message: 'PDF search cancelled' });
    } catch { /* task already settled */ }
  };
  signal.addEventListener('abort', abort, { once: true });
  return task.toPromise().finally(() => signal.removeEventListener('abort', abort));
}

export function createEnginePdfSearchPageReader(
  engine: PdfEngine,
  document: PdfDocumentObject,
): PdfSearchPageReader {
  const active = new Set<AbortController>();
  return {
    pageCount: document.pages.length,
    async read(pageIndex, parentSignal) {
      const page = document.pages[pageIndex];
      if (!page) throw new Error(`PDF page ${pageIndex} is unavailable.`);
      const controller = new AbortController();
      active.add(controller);
      const abort = () => controller.abort();
      parentSignal.addEventListener('abort', abort, { once: true });
      try {
        const [text, glyphs, textRects] = await Promise.all([
          abortableTask(engine.extractText(document, [pageIndex]), controller.signal),
          abortableTask(engine.getPageGlyphs(document, page), controller.signal),
          abortableTask(engine.getPageTextRects(document, page), controller.signal),
        ]);
        return {
          text,
          glyphs,
          textRects: textRects.map(({ content, rect }) => ({ content, rect })),
        };
      } finally {
        parentSignal.removeEventListener('abort', abort);
        active.delete(controller);
      }
    },
    dispose() {
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}

function estimatedPageBytes(page: PdfSearchPageSnapshot): number {
  return page.text.length * 2 + page.glyphs.length * 48 + page.textRects.length * 64;
}

function documentWords(pages: readonly IndexedPage[]): string[] {
  return pages.flatMap(({ text }) => text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []);
}

function detectedGlyphs(pages: readonly IndexedPage[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const { text } of pages) {
    for (const character of Array.from(text)) {
      if (/[^\p{L}\p{N}\p{M}\p{P}\p{Z}\p{C}]/u.test(character)
        || /[\u0370-\u03ff\u2190-\u22ff\u27c0-\u27ef\u2980-\u2aff]/u.test(character)) {
        result.add(character);
      }
    }
  }
  return result;
}

function canonicalTextWithMap(
  text: string,
  kind: 'prose' | 'formula',
): { readonly text: string; readonly sourceIndexes: readonly number[] } {
  const canonical: string[] = [];
  const sourceIndexes: number[] = [];
  const source = Array.from(text.normalize('NFC'));
  let previousWhitespace = false;
  source.forEach((character, sourceIndex) => {
    if (/\s/u.test(character)) {
      if (kind === 'formula') return;
      if (previousWhitespace) return;
      canonical.push(' ');
      sourceIndexes.push(sourceIndex);
      previousWhitespace = true;
      return;
    }
    previousWhitespace = false;
    const normalized = kind === 'prose' ? character.toLocaleLowerCase() : character;
    for (const output of Array.from(normalized)) {
      canonical.push(output);
      sourceIndexes.push(sourceIndex);
    }
  });
  return { text: canonical.join(''), sourceIndexes };
}

function glyphRects(
  glyphs: readonly PdfGlyphObject[],
  start: number,
  end: number,
): Rect[] {
  return glyphs.slice(start, end).flatMap((glyph) => {
    if (glyph.isEmpty || glyph.isSpace || glyph.size.width <= 0 || glyph.size.height <= 0) return [];
    return [{ origin: { ...glyph.origin }, size: { ...glyph.size } }];
  });
}

function excerpt(text: string, start: number, count: number): string {
  const characters = Array.from(text);
  const from = Math.max(0, start - 48);
  const to = Math.min(characters.length, start + count + 48);
  return characters.slice(from, to).join('').replace(/\s+/gu, ' ').trim();
}

function findPageMatches(input: {
  readonly page: IndexedPage;
  readonly documentGeneration: number;
  readonly query: string;
  readonly kind: PdfSearchMatchKind;
  readonly formula: boolean;
}): PdfSearchResult[] {
  const indexed = canonicalTextWithMap(input.page.text, input.formula ? 'formula' : 'prose');
  const query = input.formula
    ? canonicalizeFormula(input.query)
    : canonicalizeProse(input.query).trim();
  if (query.length === 0) return [];
  const results: PdfSearchResult[] = [];
  let from = 0;
  while (from <= indexed.text.length - query.length) {
    const matchIndex = indexed.text.indexOf(query, from);
    if (matchIndex < 0) break;
    const sourceStart = indexed.sourceIndexes[matchIndex];
    const sourceEnd = indexed.sourceIndexes[matchIndex + query.length - 1];
    if (sourceStart !== undefined && sourceEnd !== undefined) {
      const charCount = sourceEnd - sourceStart + 1;
      const rects = glyphRects(input.page.glyphs, sourceStart, sourceEnd + 1);
      const firstOrigin = rects[0]?.origin;
      if (rects.length > 0 && firstOrigin) {
        results.push({
          id: buildSearchResultId(
            input.documentGeneration,
            input.page.pageIndex,
            sourceStart,
            charCount,
            firstOrigin,
          ),
          pageIndex: input.page.pageIndex,
          charIndex: sourceStart,
          charCount,
          rects,
          excerpt: excerpt(input.page.text, sourceStart, charCount),
          kind: input.kind,
          matchedForm: input.query,
        });
      }
    }
    from = matchIndex + Math.max(query.length, 1);
  }
  return results;
}

function ordered(results: readonly PdfSearchResult[]): PdfSearchResult[] {
  return [...results].sort((left, right) => (
    left.pageIndex - right.pageIndex
    || left.charIndex - right.charIndex
    || left.matchedForm.localeCompare(right.matchedForm)
  ));
}

function alternativesFor(
  query: string,
  glyphs: ReadonlySet<string>,
): PdfSearchAlternative[] {
  const normalized = query.trim().toLocaleLowerCase();
  return detectedSymbolSuggestions(glyphs)
    .filter((symbol) => (
      normalized.startsWith('\\')
      || symbol.name.includes(normalized)
      || symbol.latex.includes(normalized)
      || normalized.length === 0
    ))
    .slice(0, 8)
    .map((symbol) => ({ label: `${symbol.glyph} ${symbol.name}`, query: symbol.glyph, kind: 'symbol' }));
}

function catalogFor(glyphs: ReadonlySet<string>): PdfSearchAlternative[] {
  return detectedSymbolSuggestions(glyphs).map((symbol) => ({
    label: `${symbol.glyph} ${symbol.name}`,
    query: symbol.glyph,
    kind: 'symbol',
  }));
}

export function createPdfSearchController(
  options: CreatePdfSearchControllerOptions,
): PdfSearchController {
  const listeners = new Set<(state: PdfSearchState) => void>();
  const abort = new AbortController();
  const pages: IndexedPage[] = [];
  const unsearchablePages: number[] = [];
  const limitedPages: number[] = [];
  const maxPageReads = Math.max(1, options.maxPageReads ?? PDF_SEARCH_MAX_PAGE_READS);
  const maxIndexBytes = options.maxIndexBytes ?? PDF_SEARCH_MAX_INDEX_BYTES;
  let state = initialPdfSearchState(options.reader.pageCount);
  let indexPromise: Promise<void> | null = null;
  let indexedBytes = 0;
  let queryToken = 0;
  let activeSearch: { readonly token: number; readonly query: string } | null = null;
  let disposed = false;

  const publish = (next: PdfSearchState) => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const coverage = () => ({
    totalPages: options.reader.pageCount,
    searchedPages: pages.length,
    unsearchablePages: orderedNumbers(unsearchablePages),
    limitedPages: orderedNumbers(limitedPages),
  });

  const ensureIndex = () => {
    if (indexPromise) return indexPromise;
    indexPromise = (async () => {
      let nextPage = 0;
      const worker = async () => {
        while (!disposed) {
          const pageIndex = nextPage;
          nextPage += 1;
          if (pageIndex >= options.reader.pageCount) return;
          if (indexedBytes >= maxIndexBytes) {
            limitedPages.push(pageIndex);
            continue;
          }
          try {
            const page = await options.reader.read(pageIndex, abort.signal);
            const reliable = assessPageTextReliability({
              extractedText: page.text,
              textRects: page.textRects,
            });
            if (!reliable.reliable || page.glyphs.length === 0) {
              unsearchablePages.push(pageIndex);
            } else {
              const pageBytes = estimatedPageBytes(page);
              if (indexedBytes + pageBytes > maxIndexBytes) limitedPages.push(pageIndex);
              else {
                indexedBytes += pageBytes;
                pages.push({ ...page, pageIndex });
              }
            }
          } catch {
            if (!abort.signal.aborted) unsearchablePages.push(pageIndex);
          }
          if (!disposed) {
            if (activeSearch) publishQueryResults(activeSearch.token, activeSearch.query, false);
            else publish({ ...state, status: 'indexing', coverage: coverage() });
          }
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(maxPageReads, options.reader.pageCount) },
        () => worker(),
      ));
      pages.sort((left, right) => left.pageIndex - right.pageIndex);
    })();
    return indexPromise;
  };

  function publishQueryResults(token: number, query: string, complete: boolean): void {
    if (disposed || token !== queryToken || activeSearch?.token !== token) return;
    const glyphInventory = detectedGlyphs(pages);
    const symbolCatalog = catalogFor(glyphInventory);
    const queryKind = classifyPdfSearchQuery(query);
    const symbolAlias = isSymbolAliasQuery(query);
    const symbol = resolveDetectedSymbolQuery(query, glyphInventory);
    const effectiveQuery = symbol?.glyph ?? query;
    const matchKind: PdfSearchMatchKind = symbol
      ? 'symbol'
      : queryKind === 'formula' ? 'formula' : 'exact';
    const exact = ordered(pages.flatMap((page) => findPageMatches({
      page,
      documentGeneration: options.documentGeneration,
      query: effectiveQuery,
      kind: matchKind,
      formula: Boolean(symbol) || queryKind === 'formula',
    })));

    const relatedQueries = queryKind === 'prose' && !symbolAlias
      ? relatedPhraseQueries(query, documentWords(pages))
      : [];
    const exactIds = new Set(exact.map(({ id }) => id));
    const related = ordered(relatedQueries.flatMap((variant) => pages.flatMap((page) => (
      findPageMatches({
        page,
        documentGeneration: options.documentGeneration,
        query: variant,
        kind: 'variant',
        formula: false,
      }).filter(({ id }) => !exactIds.has(id))
    ))));
    const hasCoverageGap = unsearchablePages.length > 0 || limitedPages.length > 0;
    const hasResults = exact.length > 0 || related.length > 0;
    const groups = [
      ...(exact.length > 0 ? [{ id: 'exact' as const, label: 'Exact matches', results: exact }] : []),
      ...(related.length > 0 ? [{ id: 'related' as const, label: 'Related word forms', results: related }] : []),
    ];
    const mathUncertain = complete && !hasResults && (queryKind !== 'prose' || symbolAlias);
    const processedPages = pages.length + unsearchablePages.length + limitedPages.length;
    publish({
      ...state,
      status: !complete
        ? 'searching'
        : pages.length === 0
          ? 'unavailable'
          : hasCoverageGap ? 'partial'
            : hasResults ? 'results' : 'no-results',
      groups,
      coverage: coverage(),
      alternatives: mathUncertain ? alternativesFor(query, glyphInventory) : [],
      symbolCatalog,
      message: !complete
        ? `Searching remaining pages… ${processedPages} of ${options.reader.pageCount} checked.`
        : mathUncertain
          ? 'This mathematical query could not be matched confidently. Try a detected symbol or a shorter exact fragment.'
          : hasCoverageGap
            ? `Searched ${pages.length} of ${options.reader.pageCount} pages with reliable text.`
            : hasResults ? '' : 'No matches found.',
    });
  }

  const search = async (rawQuery: string): Promise<PdfSearchState> => {
    const token = ++queryToken;
    const query = rawQuery.trim();
    activeSearch = query.length === 0 ? null : { token, query };
    publish({
      ...state,
      status: query.length === 0 ? 'idle' : 'indexing',
      query,
      groups: [],
      selectedResultId: null,
      alternatives: [],
      message: '',
    });
    if (query.length === 0) return state;
    if (Array.from(query).length > PDF_SEARCH_MAX_QUERY_CODE_POINTS) {
      publish({ ...state, status: 'unavailable', message: 'Search queries are limited to 512 characters.' });
      return state;
    }

    await ensureIndex();
    if (disposed || token !== queryToken) return state;
    publishQueryResults(token, query, true);
    return state;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prepare() {
      if (state.status === 'idle') publish({ ...state, status: 'indexing' });
      await ensureIndex();
      if (disposed) return state;
      const symbolCatalog = catalogFor(detectedGlyphs(pages));
      publish({
        ...state,
        status: state.query.length === 0
          ? (pages.length === 0 ? 'unavailable' : 'idle')
          : state.status,
        coverage: coverage(),
        symbolCatalog,
        message: pages.length === 0
          ? 'No reliable extracted text is available to search in this PDF.'
          : state.message,
      });
      return state;
    },
    search,
    selectResult(resultId) {
      const exists = state.groups.some((group) => group.results.some(({ id }) => id === resultId));
      publish({ ...state, selectedResultId: resultId === null || exists ? resultId : state.selectedResultId });
    },
    clear() {
      queryToken += 1;
      activeSearch = null;
      publish({ ...initialPdfSearchState(options.reader.pageCount), coverage: coverage() });
    },
    dispose() {
      disposed = true;
      queryToken += 1;
      abort.abort();
      options.reader.dispose?.();
      listeners.clear();
    },
  };
}

function orderedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
