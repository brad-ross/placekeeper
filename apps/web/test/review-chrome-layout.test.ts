import { describe, expect, it } from 'vitest';

import {
  REVIEW_CHROME_PRESENTATIONS,
  chooseReviewChromePresentation,
  type ReviewChromePresentationWidths,
} from '../src/review/review-chrome-layout.js';

const widths: ReviewChromePresentationWidths = {
  expanded: 800,
  zoomCompact: 700,
  historyCompact: 600,
  navigationCompact: 500,
};

describe('review chrome responsive presentation', () => {
  it('collapses in Zoom, Edit history, Navigation order at measured fit edges', () => {
    expect(REVIEW_CHROME_PRESENTATIONS).toEqual([
      'expanded',
      'zoomCompact',
      'historyCompact',
      'navigationCompact',
    ]);

    const cases = [
      { availableWidth: 800, expected: 'expanded' },
      { availableWidth: 799, expected: 'zoomCompact' },
      { availableWidth: 700, expected: 'zoomCompact' },
      { availableWidth: 699, expected: 'historyCompact' },
      { availableWidth: 600, expected: 'historyCompact' },
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
    })).toBe('zoomCompact');
  });

  it('requires the restoration margin only when expanding', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 723,
      widths,
      previous: 'historyCompact',
    })).toBe('historyCompact');
    expect(chooseReviewChromePresentation({
      availableWidth: 724,
      widths,
      previous: 'historyCompact',
    })).toBe('zoomCompact');

    expect(chooseReviewChromePresentation({
      availableWidth: 823,
      widths,
      previous: 'navigationCompact',
    })).toBe('zoomCompact');
    expect(chooseReviewChromePresentation({
      availableWidth: 824,
      widths,
      previous: 'navigationCompact',
    })).toBe('expanded');

    expect(chooseReviewChromePresentation({
      availableWidth: 699,
      widths,
      previous: 'zoomCompact',
    })).toBe('historyCompact');
  });

  it('allows callers to disable expansion hysteresis explicitly', () => {
    expect(chooseReviewChromePresentation({
      availableWidth: 700,
      widths,
      previous: 'historyCompact',
      expansionHysteresis: 0,
    })).toBe('zoomCompact');
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
