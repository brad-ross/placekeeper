import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';

import type {
  PdfSearchAlternative,
  PdfSearchResult,
  PdfSearchState,
} from '../pdf/pdf-search-model.js';
import type { CopyLinkControlProps } from './CopyLinkControl.js';
import { RowActionGroup, type RowAction } from './RowActionGroup.js';
import { ReviewIcon } from './ReviewIcon.js';

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
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return symbols;
  return symbols.filter((symbol) => (
    symbol.query.toLocaleLowerCase().includes(needle)
    || symbol.label.toLocaleLowerCase().includes(needle)
  ));
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
  const showSymbolSuggestions = symbolSuggestionsOpen && symbolSuggestions.length > 0;
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
          className="review-chrome__page-input pdf-search__input"
          type="search"
          role="searchbox"
          aria-label="Search this PDF"
          title="Search this PDF"
          aria-autocomplete="list"
          aria-controls="pdf-search-symbol-suggestions"
          placeholder="Words, phrases, symbols, or formulas"
          value={state.query}
          data-workspace-focus-token="search:query"
          onChange={updateQuery}
          onFocus={() => setSymbolSuggestionsOpen(true)}
          onClick={() => setSymbolSuggestionsOpen(true)}
          onKeyDown={handleQueryKeyDown}
        />
        {hasEffectiveQuery ? (
          <button
            type="button"
            className="pdf-search__clear"
            aria-label="Clear search"
            title="Clear search"
            onPointerDown={(event) => event.preventDefault()}
            onClick={clearQuery}
          >
            <ReviewIcon name="close" size={15} />
          </button>
        ) : null}
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

      {state.message ? (
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

      <div className="pdf-search__results" aria-label="PDF search results">
        {state.groups.map((group) => (
          <section key={group.id} className="pdf-search__group" aria-labelledby={`pdf-search-group-${group.id}`}>
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
                  <button
                    type="button"
                    className="annotation-item__content pdf-search__result"
                    data-workspace-focus-token={`search:${result.id}`}
                    aria-label={resultLabel(result)}
                    title={`Go to result on page ${result.pageIndex + 1}`}
                    onClick={() => onResultActivate(result)}
                  >
                    <span className="annotation-item__excerpt pdf-search__excerpt">
                      <span className="pdf-search__result-page">{result.pageIndex + 1}</span>
                      <span className="pdf-search__result-separator">·</span>
                      <span className="pdf-search__result-context">
                        {excerptParts.before}
                        <strong className="pdf-search__result-match">{excerptParts.match}</strong>
                        {excerptParts.after}
                      </span>
                    </span>
                  </button>
                  <RowActionGroup actions={actions} rowLabel={`Search result on page ${pageNumber}`} />
                </li>;
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
