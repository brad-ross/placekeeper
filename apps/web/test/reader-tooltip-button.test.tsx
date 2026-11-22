import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  READER_TOOLTIP_HOVER_DELAY_MS,
  ReaderTooltipButton,
  readerTooltipEscapeDismisses,
  readerTooltipFocusOpens,
} from '../src/reader/ReaderTooltipButton.js';

describe('review tooltip button', () => {
  it('uses the approved hover delay while keyboard focus opens immediately', () => {
    expect(READER_TOOLTIP_HOVER_DELAY_MS).toBe(600);
    expect(readerTooltipFocusOpens(false)).toBe(true);
    expect(readerTooltipFocusOpens(true)).toBe(false);
  });

  it('dismisses for a completed Escape key without consuming IME composition', () => {
    expect(readerTooltipEscapeDismisses('Escape', false)).toBe(true);
    expect(readerTooltipEscapeDismisses('Escape', true)).toBe(false);
    expect(readerTooltipEscapeDismisses('Enter', false)).toBe(false);
  });

  it('keeps the accessible name authoritative and limits native title fallback to disabled controls', () => {
    const enabled = renderToStaticMarkup(
      <ReaderTooltipButton label="Open in References"><span /></ReaderTooltipButton>,
    );
    const disabled = renderToStaticMarkup(
      <ReaderTooltipButton label="Open in References" tooltip="Unavailable while loading" disabled><span /></ReaderTooltipButton>,
    );
    expect(enabled).toContain('aria-label="Open in References"');
    expect(enabled).not.toContain('title=');
    expect(disabled).toContain('title="Unavailable while loading"');
  });
});
