import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VIEWER_ZOOM_MAX_PERCENT } from '../src/pdf/viewer-controls.js';

import {
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

const neutralStyles = readFileSync(
  new URL('../src/app/neutral-chrome.css', import.meta.url),
  'utf8',
);

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
import { readFileSync } from 'node:fs';
