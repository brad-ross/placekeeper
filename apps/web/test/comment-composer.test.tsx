import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { boundedTextAreaHeight, CommentComposer } from '../src/review/CommentComposer.js';

function renderComposer(overrides: Partial<Parameters<typeof CommentComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <CommentComposer
      title="Highlight Comment"
      optional
      anchorNavigation={{ visibility: 'visible', pending: false, onReturn: vi.fn() }}
      onSave={vi.fn()}
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
    expect(html).not.toContain('>Keep</span>');
    expect(html).toContain('>Save</span>');
    expect(html.indexOf('</textarea>')).toBeLessThan(html.indexOf('comment-composer__actions'));
  });

  it.each([
    ['visible', false, false, ''],
    ['unavailable', false, false, ''],
    ['outside', false, true, 'Back to passage'],
    ['outside', true, true, 'Returning to passage'],
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
      expect(html.indexOf('comment-composer__anchor')).toBeLessThan(
        html.indexOf('comment-composer__body'),
      );
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
    });
    const allowedWhitespace = renderComposer({
      title: 'Replacement',
      optional: false,
      allowWhitespace: true,
      initialValue: ' ',
      saveLabel: 'Apply',
    });

    expect(optional).not.toContain('disabled=""');
    expect(requiredWhitespace).toContain('<span class="sr-only">Replacement</span>');
    expect(requiredWhitespace).not.toContain('class="comment-composer__label"');
    expect(requiredWhitespace).toContain('disabled=""');
    expect(allowedWhitespace).not.toContain('disabled=""');
  });

  it('clamps auto-growth before the editor becomes internally scrollable', () => {
    expect(boundedTextAreaHeight({ scrollHeight: 40, minHeight: 84, maxHeight: 220 })).toBe(84);
    expect(boundedTextAreaHeight({ scrollHeight: 160, minHeight: 84, maxHeight: 220 })).toBe(160);
    expect(boundedTextAreaHeight({ scrollHeight: 360, minHeight: 84, maxHeight: 220 })).toBe(220);
  });

  it('exposes stable placement data and an original-page cue without duplicating the draft', () => {
    const html = renderComposer({
      initialValue: 'Persistent draft',
      placement: { kind: 'below', style: { left: 18, top: 42 } },
      anchorNavigation: { visibility: 'outside', pending: false, pageNumber: 7, onReturn: vi.fn() },
    });
    expect(html).toContain('data-composer-placement="below"');
    expect(html).toContain('style="left:18px;top:42px"');
    expect(html).toContain('comment-composer__page-cue"> · 7</span>');
    expect(html.match(/Persistent draft/g)).toHaveLength(1);
  });
});
