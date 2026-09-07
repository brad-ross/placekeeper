import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PdfOutlineItem } from '../src/pdf/pdf-outline.js';
import { OutlineNavigator } from '../src/review/OutlineNavigator.js';

const item = (id: string, children: PdfOutlineItem[] = []): PdfOutlineItem => ({
  id, label: id, pageContext: null, target: null, children,
});
const items = [item('section', [item('subsection', [item('current')]), item('sibling')]), item('other')];

function highlighted(currentItemId: string | null, expanded: string[]) {
  const html = renderToStaticMarkup(<OutlineNavigator
    discovery={{ status: 'loaded-tree', documentGeneration: 1, items }}
    currentItemId={currentItemId} expandedItemIds={new Set(expanded)}
    onActivate={() => undefined} onOpenReference={() => undefined}
    onExpandedItemIdsChange={() => undefined}
  />);
  return {
    current: [...html.matchAll(/aria-label="([^"]+)"[^>]*aria-current="location"/g)].map((match) => match[1]),
    highlights: [...html.matchAll(/data-current="true"/g)].length,
  };
}

describe('outline current-location highlight', () => {
  it.each([
    [[], 'section'],
    [['subsection'], 'section'],
    [['section'], 'subsection'],
    [['section', 'subsection'], 'current'],
  ])('highlights the visible ancestor with expanded branches %j', (expanded, expected) => {
    expect(highlighted('current', expanded)).toEqual({ current: [expected], highlights: 1 });
  });

  it('retains a current parent and does not highlight its expanded children', () => {
    expect(highlighted('section', ['section', 'subsection'])).toEqual({ current: ['section'], highlights: 1 });
    expect(highlighted('sibling', ['section'])).toEqual({ current: ['sibling'], highlights: 1 });
  });

  it.each([null, 'missing'])('does not invent a highlight for current item %s', (current) => {
    expect(highlighted(current, [])).toEqual({ current: [], highlights: 0 });
  });
});
