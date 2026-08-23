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
  PDF_SEARCH_MAX_CONCURRENT_PAGE_READS,
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
  isKnownSymbolGlyph,
  isSymbolAliasQuery,
  resolveDetectedSymbolQueries,
} from './pdf-symbol-catalog.js';

export interface PdfSearchPageSnapshot {
  readonly text: string;
  readonly glyphs: readonly PdfGlyphObject[];
  readonly textRects: readonly TextRect[];
  readonly geometry: PdfSearchPageGeometry;
}

export interface PdfSearchPageGeometry {
  readonly width: number;
  readonly height: number;
  readonly cropLeft: number;
  readonly cropTop: number;
  readonly cropBottom: number;
}

export interface PdfSearchPageReader {
  readonly pageCount: number;
  read(pageIndex: number, signal: AbortSignal): Promise<PdfSearchPageSnapshot>;
  dispose?(): void;
}

interface CanonicalPageText {
  readonly text: string;
  readonly sourceIndexes: readonly number[];
}

interface IndexedPage {
  readonly pageIndex: number;
  readonly text: string;
  readonly glyphs: readonly PdfGlyphObject[];
  readonly geometry: PdfSearchPageGeometry;
  readonly prose: CanonicalPageText;
  readonly formula: CanonicalPageText;
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
  readonly maxConcurrentPageReads?: number;
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
        const tasks = [
          abortableTask(engine.extractText(document, [pageIndex]), controller.signal),
          abortableTask(engine.getPageGlyphs(document, page), controller.signal),
          abortableTask(engine.getPageTextRects(document, page), controller.signal),
        ] as const;
        let text: string;
        let glyphs: readonly PdfGlyphObject[];
        let textRects: readonly { readonly content: string; readonly rect: Rect }[];
        try {
          [text, glyphs, textRects] = await Promise.all(tasks);
        } catch (error) {
          controller.abort();
          await Promise.allSettled(tasks);
          throw error;
        }
        return {
          text,
          glyphs,
          textRects: textRects.map(({ content, rect }) => ({ content, rect })),
          geometry: {
            width: page.size.width,
            height: page.size.height,
            cropLeft: page.boxes?.crop.left ?? 0,
            cropTop: page.boxes?.crop.top ?? 0,
            cropBottom: page.boxes?.crop.bottom ?? 0,
          },
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
  // The reliability rectangles are transient. Retained text includes the source,
  // two canonical strings, and their source-index maps.
  return page.text.length * 18 + page.glyphs.length * 48;
}

function documentWords(pages: readonly IndexedPage[]): string[] {
  return pages.flatMap(({ text }) => text.match(/\p{L}[\p{L}\p{M}'’-]*/gu) ?? []);
}

function addDetectedGlyphs(text: string, result: Set<string>): void {
  for (const character of text) {
    if (isKnownSymbolGlyph(character)
      || /[^\p{L}\p{N}\p{M}\p{P}\p{Z}\p{C}]/u.test(character)
      || /[\u0370-\u03ff\u2190-\u22ff\u27c0-\u27ef\u2980-\u2aff]/u.test(character)) {
      result.add(character);
    }
  }
}

function canonicalTextWithMap(
  text: string,
  kind: 'prose' | 'formula',
): { readonly text: string; readonly sourceIndexes: readonly number[] } {
  const canonical: string[] = [];
  const sourceIndexes: number[] = [];
  let previousWhitespace = false;
  let sourceIndex = 0;
  for (const character of text.normalize('NFC')) {
    if (/\s/u.test(character)) {
      if (kind !== 'formula' && !previousWhitespace) {
        canonical.push(' ');
        sourceIndexes.push(sourceIndex);
        previousWhitespace = true;
      }
      sourceIndex += 1;
      continue;
    }
    previousWhitespace = false;
    const normalized = kind === 'prose' ? character.toLocaleLowerCase() : character;
    for (const output of normalized) {
      canonical.push(output);
      for (let unitIndex = 0; unitIndex < output.length; unitIndex += 1) {
        sourceIndexes.push(sourceIndex);
      }
    }
    sourceIndex += 1;
  }
  return { text: canonical.join(''), sourceIndexes };
}

function glyphRects(
  glyphs: readonly PdfGlyphObject[],
  start: number,
  end: number,
  geometry: PdfSearchPageGeometry,
): Rect[] {
  const rects = glyphs.slice(start, end).flatMap((glyph) => {
    if (
      glyph.isEmpty
      || glyph.isSpace
      || !Number.isFinite(glyph.origin.x)
      || !Number.isFinite(glyph.origin.y)
      || !Number.isFinite(glyph.size.width)
      || !Number.isFinite(glyph.size.height)
      || glyph.size.width <= 0
      || glyph.size.height <= 0
    ) return [];
    return [{
      origin: {
        x: glyph.origin.x + geometry.cropLeft,
        y: glyph.origin.y + geometry.cropTop,
      },
      size: { ...glyph.size },
    }];
  });
  return rects.reduce<Rect[]>((lines, rect) => {
    const previous = lines.at(-1);
    if (!previous) return [rect];
    const previousCenter = previous.origin.y + previous.size.height / 2;
    const rectCenter = rect.origin.y + rect.size.height / 2;
    const sameLine = Math.abs(previousCenter - rectCenter)
      <= Math.max(previous.size.height, rect.size.height);
    const horizontalGap = Math.max(
      0,
      Math.max(previous.origin.x, rect.origin.x)
        - Math.min(
          previous.origin.x + previous.size.width,
          rect.origin.x + rect.size.width,
        ),
    );
    if (!sameLine || horizontalGap > Math.max(previous.size.height, rect.size.height) * 1.5) {
      lines.push(rect);
      return lines;
    }
    const left = Math.min(previous.origin.x, rect.origin.x);
    const top = Math.min(previous.origin.y, rect.origin.y);
    const right = Math.max(
      previous.origin.x + previous.size.width,
      rect.origin.x + rect.size.width,
    );
    const bottom = Math.max(
      previous.origin.y + previous.size.height,
      rect.origin.y + rect.size.height,
    );
    lines[lines.length - 1] = {
      origin: { x: left, y: top },
      size: { width: right - left, height: bottom - top },
    };
    return lines;
  }, []);
}

function hasReliableGlyphGeometry(glyphs: readonly PdfGlyphObject[]): boolean {
  return glyphs.every((glyph) => (
    glyph.isEmpty
    || glyph.isSpace
    || (
      Number.isFinite(glyph.origin.x)
      && Number.isFinite(glyph.origin.y)
      && Number.isFinite(glyph.size.width)
      && Number.isFinite(glyph.size.height)
      && glyph.size.width > 0
      && glyph.size.height > 0
    )
  ));
}

function excerpt(characters: readonly string[], start: number, count: number): {
  readonly text: string;
  readonly match: { readonly start: number; readonly length: number };
} {
  const from = Math.max(0, start - 48);
  const to = Math.min(characters.length, start + count + 48);
  const source = characters.slice(from, to);
  const boundaries = [0];
  let normalized = '';
  let previousWasWhitespace = false;
  for (const character of source) {
    if (/\s/u.test(character)) {
      if (normalized.length > 0 && !previousWasWhitespace) normalized += ' ';
      previousWasWhitespace = true;
    } else {
      normalized += character;
      previousWasWhitespace = false;
    }
    boundaries.push(normalized.length);
  }
  const excerptText = normalized.trimEnd();
  const localMatchStart = start - from;
  const localMatchEnd = localMatchStart + count;
  const matchStart = Math.min(boundaries[localMatchStart] ?? 0, excerptText.length);
  const matchEnd = Math.min(boundaries[localMatchEnd] ?? matchStart, excerptText.length);
  return {
    text: excerptText,
    match: { start: matchStart, length: Math.max(0, matchEnd - matchStart) },
  };
}

function findPageMatches(input: {
  readonly page: IndexedPage;
  readonly documentGeneration: number;
  readonly query: string;
  readonly kind: PdfSearchMatchKind;
  readonly formula: boolean;
  readonly wholeWords?: boolean;
}): PdfSearchResult[] {
  const indexed = input.formula ? input.page.formula : input.page.prose;
  const query = input.formula
    ? canonicalizeFormula(input.query)
    : canonicalizeProse(input.query).trim();
  if (query.length === 0) return [];
  const results: PdfSearchResult[] = [];
  const sourceCharacters = Array.from(input.page.text);
  let from = 0;
  while (from <= indexed.text.length - query.length) {
    const matchIndex = indexed.text.indexOf(query, from);
    if (matchIndex < 0) break;
    if (input.wholeWords) {
      const before = indexed.text[matchIndex - 1] ?? '';
      const after = indexed.text[matchIndex + query.length] ?? '';
      if (/\p{L}|\p{M}/u.test(before) || /\p{L}|\p{M}/u.test(after)) {
        from = matchIndex + Math.max(query.length, 1);
        continue;
      }
    }
    const sourceStart = indexed.sourceIndexes[matchIndex];
    const sourceEnd = indexed.sourceIndexes[matchIndex + query.length - 1];
    if (sourceStart !== undefined && sourceEnd !== undefined) {
      const charCount = sourceEnd - sourceStart + 1;
      const rects = glyphRects(
        input.page.glyphs,
        sourceStart,
        sourceEnd + 1,
        input.page.geometry,
      );
      const firstOrigin = rects[0]?.origin;
      if (rects.length > 0 && firstOrigin) {
        const firstGlyph = input.page.glyphs[sourceStart];
        if (!firstGlyph) {
          from = matchIndex + Math.max(query.length, 1);
          continue;
        }
        const excerptValue = excerpt(sourceCharacters, sourceStart, charCount);
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
          navigationPoint: {
            x: firstGlyph.origin.x + input.page.geometry.cropLeft,
            y: input.page.geometry.cropBottom
              + input.page.geometry.height
              - firstGlyph.origin.y,
          },
          rects,
          excerpt: excerptValue.text,
          excerptMatch: excerptValue.match,
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
      query.includes(symbol.glyph)
      || normalized === symbol.glyph
      || normalized.startsWith('\\')
      || symbol.name.includes(normalized)
      || symbol.latex.includes(normalized)
      || normalized.length === 0
    ))
    .slice(0, 8)
    .map((symbol) => ({
      label: `${symbol.glyph} ${symbol.name} (${symbol.latex})`,
      query: symbol.glyph,
    }));
}

function catalogFor(glyphs: ReadonlySet<string>): PdfSearchAlternative[] {
  return detectedSymbolSuggestions(glyphs).map((symbol) => ({
    label: `${symbol.glyph} ${symbol.name} (${symbol.latex})`,
    query: symbol.glyph,
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
  const maxConcurrentPageReads = Math.max(
    1,
    options.maxConcurrentPageReads ?? PDF_SEARCH_MAX_CONCURRENT_PAGE_READS,
  );
  const maxIndexBytes = options.maxIndexBytes ?? PDF_SEARCH_MAX_INDEX_BYTES;
  const glyphInventory = new Set<string>();
  let state = initialPdfSearchState(options.reader.pageCount);
  let indexPromise: Promise<void> | null = null;
  let indexComplete = false;
  let symbolCatalog: readonly PdfSearchAlternative[] = [];
  let indexedBytes = 0;
  let queryToken = 0;
  let activeSearch: { readonly token: number; readonly query: string } | null = null;
  let progressiveExact: {
    readonly token: number;
    readonly effectiveQueries: readonly string[];
    readonly matchKind: PdfSearchMatchKind;
    readonly formula: boolean;
    readonly pageIndexes: Set<number>;
    readonly results: PdfSearchResult[];
  } | null = null;
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
            if (
              !reliable.reliable
              || page.glyphs.length === 0
              || !hasReliableGlyphGeometry(page.glyphs)
            ) {
              unsearchablePages.push(pageIndex);
            } else {
              const pageBytes = estimatedPageBytes(page);
              if (indexedBytes + pageBytes > maxIndexBytes) limitedPages.push(pageIndex);
              else {
                indexedBytes += pageBytes;
                pages.push({
                  pageIndex,
                  text: page.text,
                  glyphs: page.glyphs,
                  geometry: page.geometry,
                  prose: canonicalTextWithMap(page.text, 'prose'),
                  formula: canonicalTextWithMap(page.text, 'formula'),
                });
                addDetectedGlyphs(page.text, glyphInventory);
                symbolCatalog = catalogFor(glyphInventory);
              }
            }
          } catch {
            if (!abort.signal.aborted) unsearchablePages.push(pageIndex);
          }
          if (!disposed) {
            if (activeSearch) publishQueryResults(activeSearch.token, activeSearch.query, false);
            else publish({ ...state, coverage: coverage() });
          }
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(maxConcurrentPageReads, options.reader.pageCount) },
        () => worker(),
      ));
      pages.sort((left, right) => left.pageIndex - right.pageIndex);
      indexComplete = true;
    })();
    return indexPromise;
  };

  function publishQueryResults(token: number, query: string, complete: boolean): void {
    if (disposed || token !== queryToken || activeSearch?.token !== token) return;
    const queryKind = classifyPdfSearchQuery(query);
    const symbolAlias = isSymbolAliasQuery(query);
    const symbols = resolveDetectedSymbolQueries(query, glyphInventory);
    const effectiveQueries = symbols.length > 0 ? symbols.map(({ glyph }) => glyph) : [query];
    const matchKind: PdfSearchMatchKind = symbols.length > 0
      ? 'symbol'
      : queryKind === 'formula' ? 'formula' : 'exact';
    const formula = symbols.length > 0 || queryKind === 'formula';
    if (
      progressiveExact?.token !== token
      || progressiveExact.effectiveQueries.length !== effectiveQueries.length
      || progressiveExact.effectiveQueries.some((value, index) => value !== effectiveQueries[index])
      || progressiveExact.matchKind !== matchKind
      || progressiveExact.formula !== formula
    ) {
      progressiveExact = {
        token,
        effectiveQueries,
        matchKind,
        formula,
        pageIndexes: new Set(),
        results: [],
      };
    }
    for (const page of pages) {
      if (progressiveExact.pageIndexes.has(page.pageIndex)) continue;
      progressiveExact.pageIndexes.add(page.pageIndex);
      for (const effectiveQuery of effectiveQueries) {
        progressiveExact.results.push(...findPageMatches({
          page,
          documentGeneration: options.documentGeneration,
          query: effectiveQuery,
          kind: matchKind,
          formula,
        }));
      }
    }
    const exact = ordered([...new Map(
      progressiveExact.results.map((result) => [result.id, result]),
    ).values()]);

    const relatedQueries = complete && queryKind === 'prose' && !symbolAlias
      ? relatedPhraseQueries(query, documentWords(pages))
      : [];
    const exactIds = new Set(exact.map(({ id }) => id));
    const relatedById = new Map<string, PdfSearchResult>();
    for (const result of relatedQueries.flatMap((variant) => pages.flatMap((page) => (
      findPageMatches({
        page,
        documentGeneration: options.documentGeneration,
        query: variant,
        kind: 'variant',
        formula: false,
        wholeWords: true,
      }).filter(({ id }) => !exactIds.has(id))
    )))) {
      const overlapsExact = exact.some((exactResult) => (
        exactResult.pageIndex === result.pageIndex
        && exactResult.charIndex < result.charIndex + result.charCount
        && result.charIndex < exactResult.charIndex + exactResult.charCount
      ));
      if (!overlapsExact) relatedById.set(result.id, result);
    }
    const related = ordered([...relatedById.values()]);
    const hasCoverageGap = unsearchablePages.length > 0 || limitedPages.length > 0;
    const hasResults = exact.length > 0 || related.length > 0;
    const groups = [
      ...(exact.length > 0 ? [{ id: 'exact' as const, label: 'Exact matches', results: exact }] : []),
      ...(related.length > 0 ? [{ id: 'related' as const, label: 'Related matches', results: related }] : []),
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
          : hasCoverageGap || hasResults ? '' : 'No matches found.',
    });
  }

  const search = async (rawQuery: string): Promise<PdfSearchState> => {
    const token = ++queryToken;
    const query = rawQuery.trim();
    const oversized = Array.from(query).length > PDF_SEARCH_MAX_QUERY_CODE_POINTS;
    activeSearch = query.length === 0 || oversized ? null : { token, query };
    progressiveExact = null;
    publish({
      ...state,
      status: oversized ? 'unavailable' : query.length === 0 ? 'idle' : 'indexing',
      query: rawQuery,
      groups: [],
      selectedResultId: null,
      alternatives: [],
      message: oversized ? 'Search queries are limited to 512 characters.' : '',
    });
    if (query.length === 0 || oversized) return state;

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
      if (indexComplete && state.status !== 'indexing') return state;
      if (state.status === 'idle') publish({ ...state, status: 'indexing' });
      await ensureIndex();
      if (disposed) return state;
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
      progressiveExact = null;
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
