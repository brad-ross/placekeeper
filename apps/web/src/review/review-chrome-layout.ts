export const REVIEW_CHROME_PRESENTATIONS = [
  'expanded',
  'zoomCompact',
  'historyCompact',
  'navigationCompact',
] as const;

export type ReviewChromePresentation = typeof REVIEW_CHROME_PRESENTATIONS[number];

export type ReviewChromePresentationWidths = Readonly<
  Record<ReviewChromePresentation, number>
>;

export const REVIEW_CHROME_EXPANSION_HYSTERESIS = 24;

const MOST_COMPACT_PRESENTATION: ReviewChromePresentation = 'navigationCompact';

function validMeasurement(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validExpansionHysteresis(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasCompleteMeasurements(input: {
  readonly availableWidth: number;
  readonly widths: ReviewChromePresentationWidths;
}): boolean {
  return validMeasurement(input.availableWidth)
    && REVIEW_CHROME_PRESENTATIONS.every((presentation) => (
      validMeasurement(input.widths[presentation])
    ));
}

/**
 * Selects the least-collapsed presentation that fits the measured top bar.
 *
 * Collapsing happens as soon as a presentation no longer fits. Expanding
 * requires additional runway so small measurement changes near an edge do
 * not oscillate the controls. A missing previous presentation represents the
 * first complete measurement and therefore does not apply restore hysteresis.
 */
export function chooseReviewChromePresentation(input: {
  readonly availableWidth: number;
  readonly widths: ReviewChromePresentationWidths;
  readonly previous: ReviewChromePresentation | null;
  readonly expansionHysteresis?: number;
}): ReviewChromePresentation {
  if (!hasCompleteMeasurements(input)) return MOST_COMPACT_PRESENTATION;

  const previousIndex = input.previous === null
    ? -1
    : REVIEW_CHROME_PRESENTATIONS.indexOf(input.previous);
  const expansionHysteresis = input.expansionHysteresis === undefined
    || !validExpansionHysteresis(input.expansionHysteresis)
    ? REVIEW_CHROME_EXPANSION_HYSTERESIS
    : input.expansionHysteresis;

  for (let index = 0; index < REVIEW_CHROME_PRESENTATIONS.length; index += 1) {
    const presentation = REVIEW_CHROME_PRESENTATIONS[index]!;
    const isExpansion = previousIndex >= 0 && index < previousIndex;
    const requiredWidth = input.widths[presentation]
      + (isExpansion ? expansionHysteresis : 0);
    if (input.availableWidth >= requiredWidth) return presentation;
  }

  // NavigationCompact is the supported minimum presentation even when the
  // bar is narrower than its measured intrinsic width.
  return MOST_COMPACT_PRESENTATION;
}
