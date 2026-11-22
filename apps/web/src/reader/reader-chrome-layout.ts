export const READER_CHROME_PRESENTATIONS = [
  'expanded',
  'historyCompact',
  'zoomCompact',
  'navigationCompact',
] as const;

export type ReaderChromePresentation = typeof READER_CHROME_PRESENTATIONS[number];

export type ReaderChromePresentationWidths = Readonly<
  Record<ReaderChromePresentation, number>
>;

export const READER_CHROME_EXPANSION_HYSTERESIS = 24;

const MOST_COMPACT_PRESENTATION: ReaderChromePresentation = 'navigationCompact';

function validMeasurement(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validExpansionHysteresis(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasCompleteMeasurements(input: {
  readonly availableWidth: number;
  readonly widths: ReaderChromePresentationWidths;
}): boolean {
  return validMeasurement(input.availableWidth)
    && READER_CHROME_PRESENTATIONS.every((presentation) => (
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
export function chooseReaderChromePresentation(input: {
  readonly availableWidth: number;
  readonly widths: ReaderChromePresentationWidths;
  readonly previous: ReaderChromePresentation | null;
  readonly expansionHysteresis?: number;
}): ReaderChromePresentation {
  if (!hasCompleteMeasurements(input)) return MOST_COMPACT_PRESENTATION;

  const previousIndex = input.previous === null
    ? -1
    : READER_CHROME_PRESENTATIONS.indexOf(input.previous);
  const expansionHysteresis = input.expansionHysteresis === undefined
    || !validExpansionHysteresis(input.expansionHysteresis)
    ? READER_CHROME_EXPANSION_HYSTERESIS
    : input.expansionHysteresis;

  for (let index = 0; index < READER_CHROME_PRESENTATIONS.length; index += 1) {
    const presentation = READER_CHROME_PRESENTATIONS[index]!;
    const isExpansion = previousIndex >= 0 && index < previousIndex;
    const requiredWidth = input.widths[presentation]
      + (isExpansion ? expansionHysteresis : 0);
    if (input.availableWidth >= requiredWidth) return presentation;
  }

  // NavigationCompact is the supported minimum presentation even when the
  // bar is narrower than its measured intrinsic width.
  return MOST_COMPACT_PRESENTATION;
}

/**
 * The document title shrinks with an ellipsis as the bar narrows; below this
 * many pixels of room it shows only the file icon, since a few letters and an
 * ellipsis no longer identify the document.
 */
export const READER_CHROME_TITLE_MIN_WIDTH = 56;
export const READER_CHROME_TITLE_HYSTERESIS = 16;

export type ReaderChromeTitlePresentation = 'title' | 'icon';

/**
 * Chooses whether the top bar shows the document title or only its icon.
 * `titleRoom` is the width left for the title text once every other control
 * has its natural width. Restoring the title needs extra runway so a bar
 * resting near the threshold does not flicker.
 */
export function chooseReaderChromeTitlePresentation(input: {
  readonly titleRoom: number;
  readonly previous: ReaderChromeTitlePresentation;
  readonly minWidth?: number;
  readonly hysteresis?: number;
}): ReaderChromeTitlePresentation {
  if (!Number.isFinite(input.titleRoom)) return input.previous;
  const minWidth = input.minWidth ?? READER_CHROME_TITLE_MIN_WIDTH;
  const hysteresis = input.hysteresis ?? READER_CHROME_TITLE_HYSTERESIS;
  const required = input.previous === 'icon' ? minWidth + hysteresis : minWidth;
  return input.titleRoom >= required ? 'title' : 'icon';
}

/**
 * Whether Undo/Redo combine into one button and Back/Forward move into the
 * page menu. This is the last step after the title has collapsed to its icon:
 * it happens only when even the icon no longer fits at the normal control
 * spacing (`titleRoom` below zero), so gaps are never squeezed instead.
 *
 * `savings` is how much room combining freed when it happened, measured from
 * the live bar. The separate controls return only once that room, plus some
 * runway, is available again.
 */
export function chooseReaderChromeHistoryCompact(input: {
  readonly titleRoom: number;
  readonly compact: boolean;
  readonly savings: number | null;
  readonly hysteresis?: number;
}): boolean {
  if (!Number.isFinite(input.titleRoom)) return input.compact;
  if (!input.compact) return input.titleRoom < 0;
  if (input.savings === null || !Number.isFinite(input.savings)) return true;
  const hysteresis = input.hysteresis ?? READER_CHROME_TITLE_HYSTERESIS;
  return input.titleRoom - input.savings < hysteresis;
}
