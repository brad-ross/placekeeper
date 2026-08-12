import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { initialPdfSearchState, type PdfSearchResult } from '../src/pdf/pdf-search-model.js';
import {
  filterPdfSearchSymbolSuggestions,
  PdfSearchWorkspace,
} from '../src/review/PdfSearchWorkspace.js';

const result: PdfSearchResult = {
  id: 'result-1',
  pageIndex: 3,
  charIndex: 10,
  charCount: 6,
  navigationPoint: { x: 1, y: 6 },
  rects: [{ origin: { x: 1, y: 2 }, size: { width: 3, height: 4 } }],
  excerpt: 'Let λ denote the arrival rate.',
  kind: 'symbol',
  matchedForm: 'λ',
};

describe('PDF search workspace', () => {
  it('renders a familiar searchbox with distinct main and reference actions', () => {
    const html = renderToStaticMarkup(<PdfSearchWorkspace
      state={{
        ...initialPdfSearchState(8),
        status: 'results',
        query: 'lambda',
        groups: [{ id: 'exact', label: 'Exact matches', results: [result] }],
      }}
      onQueryChange={vi.fn()}
      onResultActivate={vi.fn()}
      onResultOpenReference={vi.fn()}
      onAlternativeActivate={vi.fn()}
    />);

    expect(html).toContain('role="searchbox"');
    expect(html).toContain('aria-label="Search this PDF"');
    expect(html).toContain('Exact matches');
    expect(html).toContain('Let λ denote the arrival rate.');
    expect(html).toContain('class="annotation-item__page">4</span>');
    expect(html).toContain('aria-label="Open result on page 4 in References"');
    expect(html).toContain('class="review-chrome__page-input pdf-search__input"');
    expect(html).toContain('pdf-search__search-icon');
    expect(html).toContain('aria-label="Clear search"');
    expect(html).toContain('class="annotation-item__content pdf-search__result"');
    expect(html).toContain('class="annotation-item__action pdf-search__reference"');
    expect(html).not.toContain('Try a symbol name or LaTeX command');
    expect(html).not.toContain('Symbols in this PDF');
  });

  it('filters document symbols by glyph, common name, and LaTeX command', () => {
    const symbols = [
      { label: 'λ lambda (\\lambda)', query: 'λ' },
      { label: 'θ theta (\\theta)', query: 'θ' },
    ];

    expect(filterPdfSearchSymbolSuggestions(symbols, '')).toEqual(symbols);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'lam')).toEqual([symbols[0]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, '\\theta')).toEqual([symbols[1]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'λ')).toEqual([symbols[0]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'sigma')).toEqual([]);
  });

  it('shows partial coverage only once and omits complete-page coverage', () => {
    const render = (searchedPages: number, totalPages: number) => renderToStaticMarkup(
      <PdfSearchWorkspace
        state={{
          ...initialPdfSearchState(totalPages),
          status: searchedPages === totalPages ? 'results' : 'partial',
          query: 'stable',
          coverage: {
            searchedPages,
            totalPages,
            unsearchablePages: searchedPages === totalPages ? [] : [totalPages - 1],
            limitedPages: [],
          },
        }}
        onQueryChange={vi.fn()}
        onResultActivate={vi.fn()}
        onResultOpenReference={vi.fn()}
        onAlternativeActivate={vi.fn()}
      />,
    );

    const partial = render(2, 3);
    expect(partial).toContain('2 of 3 pages searchable');
    expect(render(3, 3)).not.toContain('3 of 3 pages searchable');
  });
});
