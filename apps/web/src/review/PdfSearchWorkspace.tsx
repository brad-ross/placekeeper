import type { ChangeEvent } from 'react';

import type {
  PdfSearchAlternative,
  PdfSearchResult,
  PdfSearchState,
} from '../pdf/pdf-search-model.js';
import { ReviewIcon } from './ReviewIcon.js';

export interface PdfSearchWorkspaceProps {
  readonly state: PdfSearchState;
  readonly onQueryChange: (query: string) => void;
  readonly onResultActivate: (result: PdfSearchResult) => void;
  readonly onResultOpenReference: (result: PdfSearchResult) => void;
  readonly onAlternativeActivate: (alternative: PdfSearchAlternative) => void;
}

function resultLabel(result: PdfSearchResult): string {
  return `${result.excerpt || result.matchedForm}, page ${result.pageIndex + 1}`;
}

function matchKindLabel(result: PdfSearchResult): string {
  switch (result.kind) {
    case 'variant': return `Related form “${result.matchedForm}”`;
    case 'symbol': return 'Exact symbol';
    case 'formula': return 'Exact formula';
    case 'exact': return 'Exact text';
  }
}

export function PdfSearchWorkspace({
  state,
  onQueryChange,
  onResultActivate,
  onResultOpenReference,
  onAlternativeActivate,
}: PdfSearchWorkspaceProps) {
  const resultCount = state.groups.reduce((count, group) => count + group.results.length, 0);
  const indexing = state.status === 'indexing' || state.status === 'searching';
  const hasEffectiveQuery = state.query.trim().length > 0;
  const statusAnnouncement = indexing
    ? state.message || 'Searching this PDF.'
    : !hasEffectiveQuery
      ? 'PDF search ready.'
      : resultCount === 1 ? '1 PDF search result.' : `${resultCount} PDF search results.`;
  const updateQuery = (event: ChangeEvent<HTMLInputElement>) => onQueryChange(event.target.value);

  return (
    <div className="pdf-search" data-pdf-search-state={state.status}>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {statusAnnouncement}
      </p>
      <div className="pdf-search__query">
        <ReviewIcon name="search" />
        <input
          type="search"
          role="searchbox"
          aria-label="Search this PDF"
          placeholder="Words, phrases, symbols, or formulas"
          value={state.query}
          data-workspace-focus-token="search:query"
          onChange={updateQuery}
        />
        {indexing ? <ReviewIcon name="loading" className="review-icon pdf-search__spinner" /> : null}
      </div>

      <p className="pdf-search__hint">
        Try a symbol name or LaTeX command, such as <code>lambda</code> or <code>\lambda</code>.
      </p>

      {state.symbolCatalog.length > 0 ? (
        <section className="pdf-search__symbols" aria-labelledby="pdf-search-symbols-title">
          <header>
            <strong id="pdf-search-symbols-title">Symbols in this PDF</strong>
            <span>{state.symbolCatalog.length}</span>
          </header>
          <div className="pdf-search__chips">
            {state.symbolCatalog.map((symbol) => (
              <button
                key={`${symbol.query}:${symbol.label}`}
                type="button"
                data-search-symbol={symbol.query}
                title={`Search for ${symbol.label}`}
                onClick={() => onAlternativeActivate(symbol)}
              >
                <span aria-hidden="true">{symbol.query}</span>
                <span className="sr-only">Search for {symbol.label}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

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
              {group.results.map((result, resultIndex) => (
                <li key={result.id} data-search-result={result.id} data-selected={state.selectedResultId === result.id ? 'true' : 'false'}>
                  <button
                    type="button"
                    className="pdf-search__result"
                    data-workspace-focus-token={`search:${result.id}`}
                    aria-label={resultLabel(result)}
                    onClick={() => onResultActivate(result)}
                  >
                    <span className="pdf-search__excerpt">{result.excerpt || result.matchedForm}</span>
                    <span className="pdf-search__page">
                      {resultIndex === 0 && group.id === 'exact' ? 'First occurrence · ' : ''}
                      {matchKindLabel(result)} · Page {result.pageIndex + 1}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="pdf-search__reference"
                    aria-label={`Open result on page ${result.pageIndex + 1} in References`}
                    title="Open in References"
                    onClick={() => onResultOpenReference(result)}
                  >
                    <ReviewIcon name="references" />
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
