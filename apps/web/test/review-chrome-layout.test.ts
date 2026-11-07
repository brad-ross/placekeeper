import { describe, expect, it } from 'vitest';

import {
  REVIEW_CHROME_PRESENTATIONS,
  chooseReviewChromeHistoryCompact,
  chooseReviewChromePresentation,
  chooseReviewChromeTitlePresentation,
  REVIEW_CHROME_TITLE_HYSTERESIS,
  REVIEW_CHROME_TITLE_MIN_WIDTH,
  type ReviewChromePresentationWidths,
} from '../src/review/review-chrome-layout.js';

const widths: ReviewChromePresentationWidths = {
  expanded: 800,
  historyCompact: 700,
  zoomCompact: 600,
  navigationCompact: 500,
};

describe('review chrome responsive presentation', () => {
  it('collapses in Edit history, Zoom, Navigation order at measured fit edges', () => {
    expect(REVIEW_CHROME_PRESENTATIONS).toEqual([
      'expanded',
      'historyCompact',
      'zoomCompact',
      'navigationCompact',
    ]);

    const cases = [
      { availableWidth: 800, expected: 'expanded' },
      { availableWidth: 799, expected: 'historyCompact' },
      { availableWidth: 700, expected: 'historyCompact' },
      { availableWidth: 699, expected: 'zoomCompact' },
      { availableWidth: 600, expected: 'zoomCompact' },
      { availableWidth: 599, expected: 'navigationCompact' },
    ] as const;

    for (const { availableWidth, expected } of cases) {
      expect(chooseReviewChromePresentation({
        availableWidth,
        widths,
        previous: 'expanded',
      })).toBe(expected);
    }
  });

  it('chooses the least-collapsed exact fit on the first complete measurement', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 800,
      widths,
      previous: null,
    })).toBe('expanded');
    expect(chooseReviewChromePresentation({
      availableWidth: 799,
      widths,
      previous: null,
    })).toBe('historyCompact');
  });

  it('requires the restoration margin only when expanding', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 723,
      widths,
      previous: 'zoomCompact',
    })).toBe('zoomCompact');
    expect(chooseReviewChromePresentation({
      availableWidth: 724,
      widths,
      previous: 'zoomCompact',
    })).toBe('historyCompact');

    expect(chooseReviewChromePresentation({
      availableWidth: 823,
      widths,
      previous: 'navigationCompact',
    })).toBe('historyCompact');
    expect(chooseReviewChromePresentation({
      availableWidth: 824,
      widths,
      previous: 'navigationCompact',
    })).toBe('expanded');

    expect(chooseReviewChromePresentation({
      availableWidth: 699,
      widths,
      previous: 'historyCompact',
    })).toBe('zoomCompact');
  });

  it('allows callers to disable expansion hysteresis explicitly', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 700,
      widths,
      previous: 'zoomCompact',
      expansionHysteresis: 0,
    })).toBe('historyCompact');
  });

  it('jumps across multiple levels when intermediate presentations do not fit', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 550,
      widths,
      previous: 'expanded',
    })).toBe('navigationCompact');

    expect(chooseReviewChromePresentation({
      availableWidth: 824,
      widths,
      previous: 'navigationCompact',
    })).toBe('expanded');
  });

  it('keeps the most compact presentation until every measurement is valid', () => {
    const invalidSamples: Array<{
      availableWidth: number;
      widths: ReviewChromePresentationWidths;
    }> = [
      { availableWidth: 0, widths },
      { availableWidth: Number.NaN, widths },
      { availableWidth: 900, widths: { ...widths, expanded: 0 } },
      { availableWidth: 900, widths: { ...widths, zoomCompact: Number.POSITIVE_INFINITY } },
    ];

    for (const sample of invalidSamples) {
      expect(chooseReviewChromePresentation({
        ...sample,
        previous: 'expanded',
      })).toBe('navigationCompact');
    }

    expect(chooseReviewChromePresentation({
      availableWidth: 900,
      widths,
      previous: 'navigationCompact',
    })).toBe('expanded');
  });

  it('falls back to NavigationCompact when no measured presentation fits', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 320,
      widths,
      previous: 'expanded',
    })).toBe('navigationCompact');
  });
});

describe('review chrome title presentation', () => {
  it('shows the title while there is room for a readable truncated title', () => {
    expect(chooseReviewChromeTitlePresentation({ titleRoom: 200, previous: 'title' })).toBe('title');
    expect(chooseReviewChromeTitlePresentation({ titleRoom: REVIEW_CHROME_TITLE_MIN_WIDTH, previous: 'title' })).toBe('title');
  });

  it('collapses to the file icon below the minimum title width', () => {
    expect(chooseReviewChromeTitlePresentation({ titleRoom: REVIEW_CHROME_TITLE_MIN_WIDTH - 1, previous: 'title' })).toBe('icon');
    expect(chooseReviewChromeTitlePresentation({ titleRoom: -40, previous: 'title' })).toBe('icon');
  });

  it('needs extra runway to restore the title so it does not flicker at the edge', () => {
    expect(chooseReviewChromeTitlePresentation({ titleRoom: REVIEW_CHROME_TITLE_MIN_WIDTH + 4, previous: 'icon' })).toBe('icon');
    expect(chooseReviewChromeTitlePresentation({
      titleRoom: REVIEW_CHROME_TITLE_MIN_WIDTH + REVIEW_CHROME_TITLE_HYSTERESIS,
      previous: 'icon',
    })).toBe('title');
  });

  it('keeps the previous presentation for an unusable measurement', () => {
    expect(chooseReviewChromeTitlePresentation({ titleRoom: Number.NaN, previous: 'icon' })).toBe('icon');
  });
});

describe('review chrome history compaction', () => {
  it('combines history controls only once even the icon-only title no longer fits', () => {
    expect(chooseReviewChromeHistoryCompact({ titleRoom: 0, compact: false, savings: null })).toBe(false);
    expect(chooseReviewChromeHistoryCompact({ titleRoom: -1, compact: false, savings: null })).toBe(true);
  });

  it('restores separate controls only when the room they need, plus runway, is back', () => {
    // Combining freed 70px: separate controls need titleRoom >= 70 + hysteresis.
    expect(chooseReviewChromeHistoryCompact({ titleRoom: 75, compact: true, savings: 70 })).toBe(true);
    expect(chooseReviewChromeHistoryCompact({
      titleRoom: 70 + REVIEW_CHROME_TITLE_HYSTERESIS,
      compact: true,
      savings: 70,
    })).toBe(false);
  });

  it('stays combined until the freed room has been measured', () => {
    expect(chooseReviewChromeHistoryCompact({ titleRoom: 500, compact: true, savings: null })).toBe(true);
    expect(chooseReviewChromeHistoryCompact({ titleRoom: Number.NaN, compact: false, savings: null })).toBe(false);
  });
});
