import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CommentComposer } from '../src/review/CommentComposer.js';

function renderComposer(overrides: Partial<Parameters<typeof CommentComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <CommentComposer
      title="Highlight Comment"
      optional
      anchorNavigation={{ visibility: 'visible', pending: false, onReturn: vi.fn() }}
      onSave={vi.fn()}
      onSkip={vi.fn()}
      onDismiss={vi.fn()}
      {...overrides}
    />,
  );
}

describe('CommentComposer contextual authoring contract', () => {
  it('keeps the live PDF as the only source context and places actions beneath the input', () => {
    const html = renderComposer();

    expect(html).toContain('data-comment-composer');
    expect(html).toContain('role="region"');
    expect(html).toContain('<form');
    expect(html).not.toContain('data-comment-composer-backdrop');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('data-source-context');
    expect(html).not.toContain('Read Document');
    expect(html).not.toContain('Return to Editor');
    expect(html).not.toContain('Anchor in view');
    expect(html).toContain('>Cancel</span>');
    expect(html).toContain('>Keep</span>');
    expect(html).toContain('>Save</span>');
    expect(html.indexOf('</textarea>')).toBeLessThan(html.indexOf('comment-composer__actions'));
  });

  it.each([
    ['visible', false, false, ''],
    ['unavailable', false, false, ''],
    ['outside', false, true, 'Return to annotation'],
    ['outside', true, true, 'Returning to annotation'],
  ] as const)('shows one icon-only anchor control only while the anchor is %s', (
    visibility,
    pending,
    visible,
    label,
  ) => {
    const html = renderComposer({
      initialValue: 'Draft remains here',
      anchorNavigation: { visibility, pending, onReturn: vi.fn() },
    });

    expect(html.includes('comment-composer__anchor')).toBe(visible);
    if (visible) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).not.toContain(`<span>${label}</span>`);
    }
    expect(html).toContain('Draft remains here');
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
