import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DocumentContextState } from '../src/host/document-in-context.js';
import { unavailableViewerControls } from '../src/pdf/viewer-controls.js';
import { DocumentContextButton } from '../src/review/DocumentContextButton.js';
import { ReviewChrome } from '../src/review/ReviewChrome.js';
import { REVIEW_CHROME_PRESENTATIONS } from '../src/review/review-chrome-layout.js';

describe('document context button', () => {
  it.each([
    [{ status: 'idle', canActivate: true }, 'Put document in context', true],
    [{ status: 'publishing', canActivate: false }, 'Putting document in context…', false],
    [{ status: 'available', canActivate: false }, 'Document in context', false],
    [{ status: 'unsupported', canActivate: false, reason: 'This host does not support PDF delivery.' }, 'Document not in context. This host does not support PDF delivery.', false],
    [{ status: 'unavailable', canActivate: true, reason: 'The host declined the PDF.' }, 'Document not in context. The host declined the PDF. Try again', true],
    [{ status: 'unavailable', canActivate: false, reason: 'PDF bytes are unavailable.' }, 'Document not in context. PDF bytes are unavailable.', false],
  ] satisfies [DocumentContextState, string, boolean][])(
    'exposes the %j state through a named native button',
    (state, label, actionable) => {
      const markup = renderToStaticMarkup(<DocumentContextButton state={state} onActivate={() => {}} />);

      expect(markup).toContain('<button type="button"');
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain('lucide-bot');
      if (actionable) {
        expect(markup).not.toContain('aria-disabled="true"');
      } else {
        expect(markup).toContain('aria-disabled="true"');
      }
      expect(markup).not.toMatch(/\sdisabled(?:=|\s|>)/u);
      expect(markup).not.toContain('tabindex="-1"');
      expect(markup).toContain(`role="status" aria-atomic="true">${state.status === 'idle' ? '' : label}</span>`);
      expect(markup.includes('aria-busy="true"')).toBe(state.status === 'publishing');
      expect(markup.includes('codex-context-status--connecting')).toBe(state.status === 'publishing');
      expect(markup.includes('codex-context-status--current')).toBe(state.status === 'available');
    },
  );

  it('renders one app-owned control and includes its footprint in each sizing candidate', () => {
    const markup = renderToStaticMarkup(<ReviewChrome
      documentTitle="paper.pdf"
      viewerState={unavailableViewerControls()}
      canUndo={false}
      canRedo={false}
      onUndo={() => {}}
      onRedo={() => {}}
      documentContext={{ state: { status: 'idle', canActivate: true }, onActivate: () => {} }}
    />);

    expect(markup.match(/data-document-context="idle"/gu)).toHaveLength(1);
    expect(markup.match(/review-chrome__context--document/gu)).toHaveLength(1 + REVIEW_CHROME_PRESENTATIONS.length);
  });
});
