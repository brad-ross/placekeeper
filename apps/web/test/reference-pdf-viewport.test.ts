import { describe, expect, it } from 'vitest';

import { referenceOwnedMarkTargetIsInteractive } from '../src/pdf/ReferencePdfViewport.js';

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
