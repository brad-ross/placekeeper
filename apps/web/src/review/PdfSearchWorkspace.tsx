import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

import {
  isSingleUnicodeScalarQuery,
  type PdfSearchAlternative,
  type PdfSearchResult,
  type PdfSearchState,
} from '../pdf/pdf-search-model.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import { RowActionGroup, type RowAction } from './RowActionGroup.js';
import { ReviewIcon } from './ReviewIcon.js';
import { ReviewTooltipButton } from './ReviewTooltipButton.js';

export interface PdfSearchWorkspaceProps {
  readonly state: PdfSearchState;
  readonly onQueryChange: (query: string) => void;
  readonly onResultActivate: (result: PdfSearchResult) => void;
  readonly onResultOpenReference: (result: PdfSearchResult) => void;
  readonly copyLinkForResult?: (
    result: PdfSearchResult,
  ) => Pick<CopyLinkControlProps, 'getLink' | 'writeText' | 'disabled'> | undefined;
  readonly onAlternativeActivate: (alternative: PdfSearchAlternative) => void;
}

function resultLabel(result: PdfSearchResult): string {
  return `${result.excerpt || result.matchedForm}, page ${result.pageIndex + 1}`;
}

function resultExcerptParts(result: PdfSearchResult): {
  readonly before: string;
  readonly match: string;
  readonly after: string;
} {
  const text = result.excerpt || result.matchedForm;
  const range = result.excerpt.length > 0
    ? result.excerptMatch
    : { start: 0, length: result.matchedForm.length };
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(start + range.length, text.length));
  return {
    before: text.slice(0, start),
    match: text.slice(start, end) || result.matchedForm,
    after: text.slice(end),
  };
}

export function filterPdfSearchSymbolSuggestions(
  symbols: readonly PdfSearchAlternative[],
  query: string,
): readonly PdfSearchAlternative[] {
  const needle = query.trim();
  if (needle.length === 0) return symbols;

  // Literal glyph filtering must not normalize: compatibility scalars such as
  // OHM SIGN and GREEK CAPITAL LETTER OMEGA remain distinct suggestions.
  if (isSingleUnicodeScalarQuery(needle)) {
    return symbols.filter((symbol) => (symbol.symbolSearch?.glyph ?? symbol.query) === needle);
  }

  // TeX control sequences are their own case-sensitive namespace.
  if (needle.startsWith('\\')) {
    return symbols.filter((symbol) => (
      symbol.symbolSearch?.commands.some((command) => command.includes(needle))
      ?? symbol.label.includes(needle)
    ));
  }

  // An exact W3C entity ID takes precedence over case-folded natural language,
  // preserving distinctions such as Alpha versus alpha.
  const exactEntityMatches = symbols.filter((symbol) => (
    symbol.symbolSearch?.entities.includes(needle) ?? false
  ));
  if (exactEntityMatches.length > 0) return exactEntityMatches;

  const naturalNeedle = needle.normalize('NFC').toLowerCase();
  return symbols.filter((symbol) => {
    const search = symbol.symbolSearch;
    if (!search) {
      return symbol.query.normalize('NFC').toLowerCase().includes(naturalNeedle)
        || symbol.label.normalize('NFC').toLowerCase().includes(naturalNeedle);
    }
    return search.entities.some((entity) => entity.includes(needle))
      || search.naturalTerms.some((term) => (
        term.normalize('NFC').toLowerCase().includes(naturalNeedle)
      ));
  });
}

export function PdfSearchWorkspace({
  state,
  onQueryChange,
  onResultActivate,
  onResultOpenReference,
  copyLinkForResult,
  onAlternativeActivate,
}: PdfSearchWorkspaceProps) {
  const queryInputRef = useRef<HTMLInputElement>(null);
  const [symbolSuggestionsOpen, setSymbolSuggestionsOpen] = useState(false);
  const resultCount = state.groups.reduce((count, group) => count + group.results.length, 0);
  const indexing = state.status === 'indexing' || state.status === 'searching';
  const hasEffectiveQuery = state.query.trim().length > 0;
  const symbolSuggestions = useMemo(
    () => filterPdfSearchSymbolSuggestions(state.symbolCatalog, state.query),
    [state.query, state.symbolCatalog],
  );
  const redundantSuggestion = symbolSuggestions.length === 1
    && symbolSuggestions[0]?.query === state.query.trim();
  const showSymbolSuggestions = symbolSuggestionsOpen && symbolSuggestions.length > 0 && !redundantSuggestion;
  const statusAnnouncement = indexing
    ? state.message || 'Searching this PDF.'
    : !hasEffectiveQuery
      ? 'PDF search ready.'
      : resultCount === 1 ? '1 PDF search result.' : `${resultCount} PDF search results.`;
  const updateQuery = (event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value);
  const closeSuggestionsOnBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      setSymbolSuggestionsOpen(false);
    }
  };
  const handleQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && symbolSuggestionsOpen) {
      event.preventDefault();
      setSymbolSuggestionsOpen(false);
    }
  };
  const chooseSymbol = (symbol: PdfSearchAlternative) => {
    setSymbolSuggestionsOpen(false);
    onAlternativeActivate(symbol);
  };
  const clearQuery = () => {
    onQueryChange('');
    setSymbolSuggestionsOpen(true);
    queryInputRef.current?.focus();
  };

  return (
    <div className="pdf-search" data-pdf-search-state={state.status}>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusAnnouncement}
      </p>
      <div
        className="pdf-search__query"
        role="combobox"
        aria-expanded={showSymbolSuggestions}
        aria-haspopup="listbox"
        aria-owns="pdf-search-symbol-suggestions"
        data-has-query={hasEffectiveQuery}
        onBlur={closeSuggestionsOnBlur}
      >
        <ReviewIcon name="search" className="review-icon pdf-search__search-icon" />
        <input
          ref={queryInputRef}
          className="pdf-search__input"
          type="search"
          role="searchbox"
          aria-label="Search this PDF"
          title="Search this PDF"
          aria-autocomplete="list"
          aria-controls="pdf-search-symbol-suggestions"
          placeholder="Search this document"
          value={state.query}
          data-workspace-focus-token="search:query"
          onChange={updateQuery}
          onFocus={() => setSymbolSuggestionsOpen(true)}
          onClick={() => setSymbolSuggestionsOpen(true)}
          onKeyDown={handleQueryKeyDown}
        />
        <span className="pdf-search__clear-slot" aria-hidden={!hasEffectiveQuery ? 'true' : undefined}>
          <ReviewTooltipButton
            label="Clear search"
            type="button"
            className="pdf-search__clear"
            aria-label="Clear search"
            title={hasEffectiveQuery ? 'Clear search' : undefined}
            tabIndex={hasEffectiveQuery ? 0 : -1}
            disabled={!hasEffectiveQuery}
            onPointerDown={(event) => event.preventDefault()}
            onClick={clearQuery}
          >
            <ReviewIcon name="close" />
          </ReviewTooltipButton>
        </span>
        {indexing ? <ReviewIcon name="loading" className="review-icon pdf-search__spinner" /> : null}
        {showSymbolSuggestions ? (
          <div
            id="pdf-search-symbol-suggestions"
            className="pdf-search__symbol-suggestions"
            role="listbox"
            aria-label="Suggested symbols"
          >
            {symbolSuggestions.map((symbol) => (
              <button
                key={`${symbol.query}:${symbol.label}`}
                type="button"
                role="option"
                aria-selected="false"
                title={`Search for ${symbol.label}`}
                data-search-symbol={symbol.query}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chooseSymbol(symbol)}
              >
                <span aria-hidden="true">{symbol.query}</span>
                <span>{symbol.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {indexing ? (
        <div className="pdf-search__message pdf-search__indexing" role="status">
          <span>Indexing</span>
          <progress
            aria-label="Indexing"
            max={Math.max(1, state.coverage.totalPages)}
            value={state.coverage.searchedPages + state.coverage.unsearchablePages.length + state.coverage.limitedPages.length}
          />
        </div>
      ) : state.message ? (
        <div className="pdf-search__message" role="status">
          {state.status === 'partial' || state.status === 'unavailable'
            ? <ReviewIcon name="warning" /> : null}
          <span>{state.message}</span>
        </div>
      ) : null}

      {state.alternatives.length > 0 ? (
        <section className="pdf-search__alternatives" aria-labelledby="pdf-search-alternatives-title">
          <strong id="pdf-search-alternatives-title">Try one of these detected symbols</strong>
          <div className="pdf-search__chips">
            {state.alternatives.map((alternative) => (
              <button
                key={`${alternative.query}:${alternative.label}`}
                type="button"
                title={`Search for ${alternative.label}`}
                onClick={() => onAlternativeActivate(alternative)}
              >
                {alternative.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {hasEffectiveQuery && !indexing ? (
        <p className="pdf-search__summary">
          {resultCount === 1 ? '1 result' : `${resultCount} results`}
          {state.coverage.searchedPages < state.coverage.totalPages
            ? ` · ${state.coverage.searchedPages} of ${state.coverage.totalPages} pages searchable`
            : ''}
        </p>
      ) : null}

      <div className="pdf-search__results" data-workspace-scroll-viewport aria-label="PDF search results">
        {state.groups.map((group) => (
          <section key={group.id} className="pdf-search__group" data-search-group={group.id} aria-labelledby={`pdf-search-group-${group.id}`}>
            <header>
              <strong id={`pdf-search-group-${group.id}`}>{group.label}</strong>
              <span>{group.results.length}</span>
            </header>
            <ol>
              {group.results.map((result) => {
                const excerptParts = resultExcerptParts(result);
                const pageNumber = result.pageIndex + 1;
                const copyLink = copyLinkForResult?.(result);
                const actions: readonly RowAction[] = [
                  {
                    kind: 'command',
                    id: 'open-reference',
                    label: `Open result on page ${pageNumber} in References`,
                    title: 'Open in References',
                    icon: 'references',
                    focusToken: `search-reference:${result.id}`,
                    onInvoke: () => onResultOpenReference(result),
                  },
                  ...(copyLink === undefined ? [] : [{
                    kind: 'copy-link' as const,
                    id: 'copy-link',
                    label: `Copy page link for Search result on page ${pageNumber}`,
                    title: `Copy page link for page ${pageNumber}`,
                    focusToken: `search-copy-link:${result.id}`,
                    copyLink,
                  }]),
                ];
                return <li
                  key={result.id}
                  data-search-result={result.id}
                  data-active={state.selectedResultId === result.id ? 'true' : 'false'}
                >
                  <div className="annotation-item__content pdf-search__result">
                    <button
                      type="button"
                      className="annotation-item__navigation"
                      data-workspace-focus-token={`search:${result.id}`}
                      aria-label={resultLabel(result)}
                      title={`Go to result on page ${pageNumber}`}
                      onClick={() => onResultActivate(result)}
                    />
                    <div className="annotation-item__title-row pdf-search__result-heading">
                      <ReviewIcon name="search" className="review-icon pdf-search__result-icon" />
                      <RowActionGroup actions={actions} rowLabel={`Search result on page ${pageNumber}`} />
                      <span className="pdf-search__result-page">{pageNumber}</span>
                    </div>
                    <span className="annotation-item__excerpt pdf-search__excerpt">
                      <span className="pdf-search__result-context">
                        {excerptParts.before}
                        <mark className="pdf-search__result-match">{excerptParts.match}</mark>
                        {excerptParts.after}
                      </span>
                    </span>
                  </div>
                </li>;
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
