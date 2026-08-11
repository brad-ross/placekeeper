import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { initialPdfSearchState, type PdfSearchResult } from '../src/pdf/pdf-search-model.js';
import { PdfSearchWorkspace } from '../src/review/PdfSearchWorkspace.js';

const result: PdfSearchResult = {
  id: 'result-1',
  pageIndex: 3,
  charIndex: 10,
  charCount: 6,
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
    expect(html).toContain('Page 4');
    expect(html).toContain('aria-label="Open result on page 4 in References"');
  });

  it('shows only the detected-symbol catalog supplied for this PDF', () => {
    const html = renderToStaticMarkup(<PdfSearchWorkspace
      state={{
        ...initialPdfSearchState(2),
        symbolCatalog: [{ label: 'λ lambda', query: 'λ', kind: 'symbol' }],
      }}
      onQueryChange={vi.fn()}
      onResultActivate={vi.fn()}
      onResultOpenReference={vi.fn()}
      onAlternativeActivate={vi.fn()}
    />);

    expect(html).toContain('Symbols in this PDF');
    expect(html).toContain('title="Search for λ lambda"');
    expect(html).not.toContain('theta');
  });
});
