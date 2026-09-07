import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  REVIEW_TOOLTIP_HOVER_DELAY_MS,
  ReviewTooltipButton,
  reviewTooltipEscapeDismisses,
  reviewTooltipFocusOpens,
} from '../src/review/ReviewTooltipButton.js';

describe('review tooltip button', () => {
  it('uses the approved hover delay while keyboard focus opens immediately', () => {
    expect(REVIEW_TOOLTIP_HOVER_DELAY_MS).toBe(600);
    expect(reviewTooltipFocusOpens(false)).toBe(true);
    expect(reviewTooltipFocusOpens(true)).toBe(false);
  });

  it('dismisses for a completed Escape key without consuming IME composition', () => {
    expect(reviewTooltipEscapeDismisses('Escape', false)).toBe(true);
    expect(reviewTooltipEscapeDismisses('Escape', true)).toBe(false);
    expect(reviewTooltipEscapeDismisses('Enter', false)).toBe(false);
  });

  it('keeps the accessible name authoritative and limits native title fallback to disabled controls', () => {
    const enabled = renderToStaticMarkup(
      <ReviewTooltipButton label="Open in References"><span /></ReviewTooltipButton>,
    );
    const disabled = renderToStaticMarkup(
      <ReviewTooltipButton label="Open in References" tooltip="Unavailable while loading" disabled><span /></ReviewTooltipButton>,
    );
    expect(enabled).toContain('aria-label="Open in References"');
    expect(enabled).not.toContain('title=');
    expect(disabled).toContain('title="Unavailable while loading"');
  });
});
