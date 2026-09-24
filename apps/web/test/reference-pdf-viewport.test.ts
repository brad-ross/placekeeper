import { Rotation } from '@embedpdf/models';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readCssSource } from '../../../test/support/read-css-source.js';
import {
  DESTINATION_BAND_TOKEN,
  DestinationBandLayer,
  referenceOwnedMarkTargetIsInteractive,
} from '../src/pdf/ReferencePdfViewport.js';
import type { DestinationBand } from '../src/review/navigation-coordinator.js';

function targetWithAncestor(ancestorSelector: string): EventTarget {
  return {
    closest: (selector: string) => selector.split(',').includes(ancestorSelector) ? {} : null,
  } as unknown as EventTarget;
}

describe('Reference owned-mark pointer ownership', () => {
  it.each([
    '[data-pdf-link-control]',
    '[data-review-contextual-ui]',
    '[data-review-editor]',
    'input',
    'textarea',
    '[contenteditable="true"]',
  ])('reserves the interactive descendant %s', (selector) => {
    expect(referenceOwnedMarkTargetIsInteractive(targetWithAncestor(selector))).toBe(true);
  });

  it.each([
    '[data-owned-mark]',
    '[data-owned-annotation-layer]',
    '[data-source-annotation-layer]',
    '.pdf-workspace__page',
  ])('allows passive annotation geometry through %s', (selector) => {
    expect(referenceOwnedMarkTargetIsInteractive(targetWithAncestor(selector))).toBe(false);
  });
});

const BAND_PAGE = { index: 2, objectNumber: 3, size: { width: 600, height: 800 }, rotation: Rotation.Degree0 } as const;

function bandLayout(pageIndex: number, scale = 1, rotated = false) {
  return {
    pageIndex, pageNumber: pageIndex + 1, x: 0, y: 0,
    width: 600 * scale, height: 800 * scale,
    rotatedWidth: (rotated ? 800 : 600) * scale, rotatedHeight: (rotated ? 600 : 800) * scale,
    elevated: false,
  };
}

function band(targetIdentity: string, rects: DestinationBand['rects'], overrides: Partial<DestinationBand> = {}): DestinationBand {
  return { documentGeneration: 4, targetIdentity, pageIndex: 2, rects, ...overrides };
}

const ENTRY_RECTS = [
  { origin: { x: 72, y: 100 }, size: { width: 400, height: 12 } },
  { origin: { x: 72, y: 113 }, size: { width: 300, height: 12 } },
] as const;

function renderBand(props: Partial<Parameters<typeof DestinationBandLayer>[0]> = {}): string {
  return renderToStaticMarkup(createElement(DestinationBandLayer, {
    band: band('target-14', ENTRY_RECTS),
    page: BAND_PAGE,
    layout: bandLayout(2),
    documentRotation: Rotation.Degree0,
    documentGeneration: 4,
    ...props,
  }));
}

describe('Destination Band layer', () => {
  it('Covers AE1. renders one band element per extent rect on the destination page, stable across re-renders', () => {
    const html = renderBand();
    expect(html).toContain('data-pdf-destination-band-layer');
    expect(html).toContain('data-destination-target="target-14"');
    expect(html.match(/data-pdf-destination-band="/gu)).toHaveLength(2);
    expect(html).toContain('left:72px;top:100px;width:400px;height:12px');
    expect(html).toContain('left:72px;top:113px;width:300px;height:12px');
    // The page re-renders when the reader scrolls away and back; the band is a pure projection of props.
    expect(renderBand()).toBe(html);
  });

  it('is inert, aria-hidden, pointer-transparent, textless, and carries no annotation identity', () => {
    const html = renderBand();
    expect(html).toMatch(/^<div inert="" aria-hidden="true" data-pdf-destination-band-layer=/u);
    expect(html).toContain('pointer-events:none');
    expect(html.replace(/<[^>]*>/gu, '')).toBe('');
    for (const attribute of [
      'data-owned-mark', 'data-review-id', 'data-owned-focus-id', 'data-source-annotation',
      'data-annotation-key', 'data-pdf-link-control', 'data-pdf-search-highlight',
    ]) expect(html).not.toContain(attribute);
  });

  it('tracks zoom and page plus document rotation', () => {
    const zoomed = renderBand({ layout: bandLayout(2, 2) });
    expect(zoomed).toContain('left:144px;top:200px;width:800px;height:24px');
    const rotatedPage = { ...BAND_PAGE, rotation: Rotation.Degree90 };
    const rotated = renderBand({ page: rotatedPage, layout: bandLayout(2, 1, true) });
    // 90deg: x' = height - (y + h), y' = x.
    expect(rotated).toContain('left:688px;top:72px;width:12px;height:400px');
    const documentRotated = renderBand({
      page: BAND_PAGE, layout: bandLayout(2, 1, true), documentRotation: Rotation.Degree90,
    });
    expect(documentRotated).toContain('left:688px;top:72px;width:12px;height:400px');
  });

  it('renders nothing on other pages, for stale generations, empty extents, or no band', () => {
    expect(renderBand({ layout: bandLayout(3) })).toBe('');
    expect(renderBand({ documentGeneration: 5 })).toBe('');
    expect(renderBand({ band: band('target-14', []) })).toBe('');
    expect(renderBand({ band: null })).toBe('');
    expect(renderBand({ page: undefined })).toBe('');
  });

  it('shows only the band it is given when the active References tab switches', () => {
    const first = renderBand({ band: band('tab-a', ENTRY_RECTS) });
    const second = renderBand({ band: band('tab-b', [{ origin: { x: 10, y: 500 }, size: { width: 50, height: 12 } }]) });
    expect(first).toContain('data-destination-target="tab-a"');
    expect(first).not.toContain('tab-b');
    expect(second).toContain('data-destination-target="tab-b"');
    expect(second).not.toContain('tab-a');
    expect(second).not.toContain('top:100px');
  });
});

describe('Destination Band styling', () => {
  const tokens = readCssSource(new URL('../src/app/review-design-tokens.css', import.meta.url));
  const styles = readCssSource(new URL('../src/app/review-search-references.css', import.meta.url));

  it('defines a translucent blue band token with no separate edge', () => {
    expect(DESTINATION_BAND_TOKEN).toBe('--review-destination-band');
    expect(tokens).toMatch(/--review-destination-band:\s*rgb\(\d+ \d+ \d+ \/ \d+%\);/u);
    expect(tokens).not.toContain('--review-destination-band-edge');
  });

  it('paints the band from its own token like a text highlight, never selectable', () => {
    const bandRule = /\[data-pdf-destination-band\]\s*\{([^}]*)\}/u.exec(styles)?.[1] ?? '';
    expect(bandRule).toContain('var(--review-destination-band)');
    expect(bandRule).toContain('pointer-events: none');
    expect(bandRule).toContain('user-select: none');
    expect(bandRule).not.toContain('--review-pdf-selection-bg');
    expect(bandRule).not.toContain('--review-warning');
    // Same shape and blending as highlight marks.
    expect(bandRule).toContain('border-radius: var(--pdf-mark-radius, 3px)');
    expect(bandRule).toContain('mix-blend-mode: multiply');
    expect(styles).not.toContain('data-pdf-destination-band-edge');
  });
});
