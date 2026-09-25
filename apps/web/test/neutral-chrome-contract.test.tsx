import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VIEWER_ZOOM_MAX_PERCENT } from '../src/pdf/viewer-controls.js';

import { documentIdentityLabel } from '../src/review/DocumentActionsMenu.js';
import {
  pageInputWidth,
  ReviewChrome,
  validPageNumber,
  validZoomPercent,
} from '../src/review/ReviewChrome.js';

const readyViewer = {
  ready: true,
  pageReady: true,
  zoomReady: true,
  currentPage: 3,
  totalPages: 12,
  zoomPercent: 100,
} as const;

const neutralStyles = readCssSource(
  new URL('../src/app/neutral-chrome.css', import.meta.url));

function chrome(overrides: Partial<Parameters<typeof ReviewChrome>[0]> = {}) {
  return renderToStaticMarkup(<ReviewChrome
    documentTitle="paper.pdf"
    viewerState={readyViewer}
    fitWidthReady
    canUndo={false}
    canRedo={false}
    canNavigateBack={false}
    canNavigateForward
    onUndo={vi.fn()}
    onRedo={vi.fn()}
    {...overrides}
  />);
}

describe('neutral toolbar contract', () => {
  it('clamps valid signed whole-number drafts and rejects malformed drafts', () => {
    expect(validPageNumber('0', 12)).toBe(1);
    expect(validPageNumber('+40', 12)).toBe(12);
    expect(validPageNumber('1.5', 12)).toBeUndefined();
    expect(validPageNumber('1e2', 12)).toBeUndefined();
    expect(validZoomPercent('-1')).toBe(20);
    expect(validZoomPercent('+9000')).toBe(VIEWER_ZOOM_MAX_PERCENT);
    expect(validZoomPercent('100.5')).toBeUndefined();
  });

  it('uses direct page and zoom inputs with fixed suffixes', () => {
    const html = chrome();
    expect(html).toContain('class="review-chrome__page-input"');
    expect(html).toContain('value="3"');
    expect(html).toContain('data-review-page-position');
    expect(html).toContain('<span aria-hidden="true">/ 12</span>');
    expect(html).toContain('class="review-chrome__zoom-input"');
    expect(html).toContain('class="review-chrome__zoom-suffix">%</span>');
  });

  it('shows the PDF title in the identity with the filename alone as its tooltip', () => {
    const html = chrome({
      displayTitle: 'Estimating Counterfactual Matrix Means',
      saveOptionsAvailable: true,
    });
    expect(html).toContain('<span class="review-chrome__filename">Estimating Counterfactual Matrix Means</span>');
    expect(html).not.toContain('Save options');
    expect(html).toContain('aria-label="Estimating Counterfactual Matrix Means, paper.pdf, Saved. Open automatic save options"');
    expect(documentIdentityLabel('paper.pdf', 'paper.pdf')).toBe('paper.pdf');
    // Without a PDF title the filename is shown, as before.
    expect(chrome()).toContain('<span class="review-chrome__filename">paper.pdf</span>');
  });

  it('sizes the page input to its digits so the page group spaces evenly', () => {
    expect(pageInputWidth('3')).toBe('calc(0.62em + 6px)');
    expect(pageInputWidth('123')).toBe(`calc(${3 * 0.62}em + 6px)`);
    expect(pageInputWidth('')).toBe('calc(0.62em + 6px)');
    expect(chrome()).toContain('style="width:calc(0.62em + 6px)"');
  });

  it('omits each unavailable history action without reserving an empty edit group', () => {
    const html = chrome();
    const live = html.slice(0, html.indexOf('data-review-chrome-sizing-rack'));
    expect(live).not.toContain('aria-label="Undo"');
    expect(live).not.toContain('aria-label="Redo"');
    expect(live).not.toContain('data-main-history="back"');
    expect(live).toContain('data-main-history="forward"');
    expect(live).not.toContain('aria-label="Edit history"');
  });
});

describe('neutral bottom References contract', () => {
  it('places the header controls in the vertical tab column beside the preview', () => {
    expect(neutralStyles).toMatch(
      /\.review-workspace\[data-workspace-presentation="bottom"\]\[data-workspace-header-variant="references"\][\s\S]*> \.review-workspace__header\s*\{[^}]*position:\s*absolute;[^}]*top:\s*12px;[^}]*left:\s*12px;[^}]*width:\s*var\(--reference-tab-column\);/u,
    );
    expect(neutralStyles).toMatch(
      /\.review-workspace__panel--references\[data-reference-tabs-orientation="vertical"\]\s*\{[^}]*grid-template-columns:\s*var\(--reference-tab-column[^}]*padding:\s*12px;/u,
    );
    expect(neutralStyles).toMatch(
      /\.reference-tabs\[data-reference-tabs-orientation="vertical"\]\s*\{[^}]*padding:\s*46px 0 0;/u,
    );
  });
});
import { readCssSource } from '../../../test/support/read-css-source.js';
