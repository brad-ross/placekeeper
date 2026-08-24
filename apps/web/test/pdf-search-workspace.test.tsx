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
  excerptMatch: { start: 4, length: 1 },
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
      copyLinkForResult={(searchResult) => ({
        getLink: () => `placekeeper:///tmp/Paper.pdf#v=1&page=${searchResult.pageIndex + 1}`,
        writeText: async () => undefined,
      })}
      onAlternativeActivate={vi.fn()}
    />);

    expect(html).toContain('role="searchbox"');
    expect(html).toContain('aria-label="Search this PDF"');
    expect(html).toContain('Exact matches');
    expect(html).toContain('class="pdf-search__result-page">4</span>');
    expect(html).toContain('class="pdf-search__result-separator">·</span>');
    expect(html).toContain('Let <strong class="pdf-search__result-match">λ</strong> denote the arrival rate.');
    expect(html).toContain('aria-label="Open result on page 4 in References"');
    expect(html).toContain('aria-label="Copy page link for Search result on page 4"');
    expect(html).toContain('lucide-link');
    expect(html).toContain('aria-label="Secondary actions for Search result on page 4"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('class="review-chrome__page-input pdf-search__input"');
    expect(html).toContain('pdf-search__search-icon');
    expect(html).toContain('aria-label="Clear search"');
    expect(html).toContain('class="annotation-item__content pdf-search__result"');
    expect(html).toContain('data-row-action="open-reference"');
    expect(html).not.toContain('Exact symbol');
    expect(html).not.toContain('First occurrence');
    expect(html).not.toContain('Try a symbol name or LaTeX command');
    expect(html).not.toContain('Symbols in this PDF');
  });

  it('filters document symbols by exact glyph, natural name, and case-sensitive commands', () => {
    const symbols = [
      {
        label: 'λ greek small letter lamda (\\lambda)',
        query: 'λ',
        symbolSearch: {
          glyph: 'λ',
          commands: ['\\lambda'],
          entities: ['lambda'],
          naturalTerms: ['greek small letter lamda', 'lambda'],
        },
      },
      {
        label: 'θ greek small letter theta (\\theta)',
        query: 'θ',
        symbolSearch: {
          glyph: 'θ',
          commands: ['\\theta', '\\vartheta'],
          entities: ['theta'],
          naturalTerms: ['greek small letter theta'],
        },
      },
    ];

    expect(filterPdfSearchSymbolSuggestions(symbols, '')).toEqual(symbols);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'lam')).toEqual([symbols[0]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, '\\theta')).toEqual([symbols[1]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, '\\vart')).toEqual([symbols[1]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, '\\Theta')).toEqual([]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'GREEK SMALL LETTER THETA')).toEqual([symbols[1]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'λ')).toEqual([symbols[0]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'sigma')).toEqual([]);
  });

  it('keeps entity IDs and canonically equivalent-looking glyphs distinct', () => {
    const symbols = [
      {
        label: 'Α greek capital letter alpha (\\Alpha)',
        query: 'Α',
        symbolSearch: {
          glyph: 'Α',
          commands: ['\\Alpha'],
          entities: ['Alpha'],
          naturalTerms: ['greek capital letter alpha'],
        },
      },
      {
        label: 'α greek small letter alpha (\\alpha)',
        query: 'α',
        symbolSearch: {
          glyph: 'α',
          commands: ['\\alpha'],
          entities: ['alpha'],
          naturalTerms: ['greek small letter alpha'],
        },
      },
      {
        label: 'Ω greek capital letter omega (\\Omega)',
        query: 'Ω',
        symbolSearch: {
          glyph: 'Ω',
          commands: ['\\Omega'],
          entities: ['Omega'],
          naturalTerms: ['greek capital letter omega'],
        },
      },
      {
        label: 'Ω ohm sign (\\Omega)',
        query: 'Ω',
        symbolSearch: {
          glyph: 'Ω',
          commands: ['\\Omega'],
          entities: ['ohm'],
          naturalTerms: ['ohm sign'],
        },
      },
    ];

    expect(filterPdfSearchSymbolSuggestions(symbols, 'Alpha')).toEqual([symbols[0]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'alpha')).toEqual([symbols[1]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'Ω')).toEqual([symbols[2]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'Ω')).toEqual([symbols[3]]);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'not detected')).toEqual([]);
  });

  it('preserves ranked order while filtering without capping the full dropdown', () => {
    const symbols = Array.from({ length: 12 }, (_, index) => ({
      label: `symbol ${index} shared term`,
      query: String.fromCodePoint(0x3b1 + index),
      symbolSearch: {
        glyph: String.fromCodePoint(0x3b1 + index),
        commands: [`\\symbol${index}`],
        entities: [`symbol${index}`],
        naturalTerms: [index % 2 === 0 ? `shared term ${index}` : `other term ${index}`],
      },
    }));

    expect(filterPdfSearchSymbolSuggestions(symbols, '')).toEqual(symbols);
    expect(filterPdfSearchSymbolSuggestions(symbols, '')).toHaveLength(12);
    expect(filterPdfSearchSymbolSuggestions(symbols, 'shared').map(({ query }) => query))
      .toEqual(symbols.filter((_, index) => index % 2 === 0).map(({ query }) => query));
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
