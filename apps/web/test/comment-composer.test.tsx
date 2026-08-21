import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewItem } from '../../../packages/core/src/review-model.js';
import { CommentComposer } from '../src/review/CommentComposer.js';
import { authoringSourceContext } from '../src/review/authoring-session.js';

const selectionContext = {
  kind: 'selection',
  pageNumber: 3,
  prefix: 'Before the ',
  quote: 'locally unique equilibrium',
  suffix: ' exists after the policy change.',
} as const;

function renderComposer(overrides: Partial<Parameters<typeof CommentComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <CommentComposer
      title="Highlight Comment"
      optional
      sourceContext={selectionContext}
      anchorNavigation={{ visibility: 'visible', pending: false, onReturn: vi.fn() }}
      onReadDocument={vi.fn()}
      onSave={vi.fn()}
      onSkip={vi.fn()}
      onDismiss={vi.fn()}
      {...overrides}
    />,
  );
}

describe('CommentComposer contextual authoring contract', () => {
  it('is a named nonmodal region and form with truthful selection context', () => {
    const html = renderComposer();

    expect(html).toContain('data-comment-composer');
    expect(html).toContain('role="region"');
    expect(html).toContain('<form');
    expect(html).not.toContain('data-comment-composer-backdrop');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('data-source-context="selection"');
    expect(html).toContain('Page 3');
    expect(html).toContain('Before the ');
    expect(html).toContain('<mark>locally unique equilibrium</mark>');
    expect(html).toContain('exists after the policy change.');
    expect(html).toContain('data-return-state="visible"');
    expect(html).toContain('Anchor in view');
    expect(html).toContain('>Read Document</span>');
    expect(html).toContain('>Cancel</span>');
    expect(html).toContain('>Keep</span>');
    expect(html).toContain('>Save</span>');
    expect(html).not.toContain('Review note');
  });

  it('bounds long source prose behind a deterministic full-context disclosure', () => {
    const longPrefix = `opening ${'context '.repeat(30)}`;
    const longQuote = `selected ${'claim '.repeat(30)}`;
    const longSuffix = `closing ${'context '.repeat(30)}`;
    const html = renderComposer({
      sourceContext: {
        kind: 'selection',
        pageNumber: 8,
        prefix: longPrefix,
        quote: longQuote,
        suffix: longSuffix,
      },
    });

    expect(html).toContain('data-context-expanded="false"');
    expect(html).toContain('>Show Full Context</button>');
    expect(html).toContain('…');
    expect(html.length).toBeLessThan(longPrefix.length + longQuote.length + longSuffix.length + 4_000);
  });

  it('renders a semantic caret even when persisted insertion context has empty sides', () => {
    const html = renderComposer({
      title: 'Edit Insertion',
      optional: false,
      sourceContext: { kind: 'caret', pageNumber: 1, leftContext: '', rightContext: '' },
      saveLabel: 'Apply',
      onSkip: undefined,
    });

    expect(html).toContain('data-source-context="caret"');
    expect(html).toContain('Page 1');
    expect(html).toContain('aria-label="Original insertion point"');
    expect(html).toContain('data-context-caret');
    expect(html).toContain('>Apply</span>');
    expect(html).not.toContain('>Keep</span>');
  });

  it('shows Page Note prose only when it was reliably captured', () => {
    const nearby = renderComposer({
      title: 'Page Note',
      optional: false,
      sourceContext: { kind: 'page', pageNumber: 12, nearbyText: 'Observed near the anchored point.' },
      onSkip: undefined,
    });
    const fallback = renderComposer({
      title: 'Edit Page Note',
      optional: false,
      sourceContext: { kind: 'anchor', pageNumber: 12, anchorLabel: 'Page Note anchor' },
      onSkip: undefined,
    });

    expect(nearby).toContain('data-source-context="page"');
    expect(nearby).toContain('Observed near the anchored point.');
    expect(fallback).toContain('data-source-context="anchor"');
    expect(fallback).toContain('Page Note anchor');
    expect(fallback).toContain('Text context unavailable');
    expect(fallback).not.toContain('Observed near the anchored point.');
  });

  it('derives persisted edit context without synthesizing missing prose', () => {
    const replacement: ReviewItem = {
      id: 'replacement',
      kind: 'replace',
      pageIndex: 4,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
      payload: {
        quote: 'the original claim',
        prefix: 'Before ',
        suffix: ' after.',
        proposedText: 'the revised claim',
      },
    };
    const missing: ReviewItem = {
      ...replacement,
      id: 'missing',
      payload: { proposedText: 'the revised claim' },
    };

    expect(authoringSourceContext({ kind: 'edit', item: replacement })).toEqual({
      kind: 'selection',
      pageNumber: 5,
      prefix: 'Before ',
      quote: 'the original claim',
      suffix: ' after.',
    });
    expect(authoringSourceContext({ kind: 'edit', item: missing })).toEqual({
      kind: 'anchor',
      pageNumber: 5,
      anchorLabel: 'Replacement anchor',
    });
  });

  it.each([
    ['outside', false, 'Return to Anchor', false],
    ['outside', true, 'Returning…', true],
    ['unavailable', false, 'Anchor unavailable', true],
  ] as const)('presents the %s Return state without hiding the draft', (visibility, pending, label, disabled) => {
    const html = renderComposer({
      initialValue: 'Draft remains here',
      anchorNavigation: { visibility, pending, onReturn: vi.fn() },
    });

    expect(html).toContain(`data-return-state="${pending ? 'pending' : visibility}"`);
    expect(html).toContain(label);
    expect(html).toContain('Draft remains here');
    expect(html.includes('disabled')).toBe(disabled);
  });

  it('retains optionality, whitespace, and accessible field-label semantics', () => {
    const optional = renderComposer();
    const requiredWhitespace = renderComposer({
      title: 'Replacement',
      optional: false,
      allowWhitespace: false,
      fieldLabel: 'Replacement',
      initialValue: '   ',
      saveLabel: 'Apply',
      onSkip: undefined,
    });
    const allowedWhitespace = renderComposer({
      title: 'Replacement',
      optional: false,
      allowWhitespace: true,
      initialValue: ' ',
      saveLabel: 'Apply',
      onSkip: undefined,
    });

    expect(optional).not.toContain('disabled=""');
    expect(requiredWhitespace).toContain('<span class="sr-only">Replacement</span>');
    expect(requiredWhitespace).not.toContain('class="comment-composer__label"');
    expect(requiredWhitespace).toContain('disabled=""');
    expect(allowedWhitespace).not.toContain('disabled=""');
  });
});
