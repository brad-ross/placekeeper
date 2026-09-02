import { describe, expect, it } from 'vitest';

import {
  REVIEW_CHROME_PRESENTATIONS,
  chooseReviewChromePresentation,
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
