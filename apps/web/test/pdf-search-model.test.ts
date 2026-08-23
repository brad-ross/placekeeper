import { describe, expect, it } from 'vitest';

import {
  buildSearchResultId,
  canonicalizeFormula,
  canonicalizeProse,
  classifyPdfSearchQuery,
  isSingleUnicodeScalarQuery,
} from '../src/pdf/pdf-search-model.js';

describe('PDF search model', () => {
  it('normalizes prose without weakening punctuation or page boundaries', () => {
    expect(canonicalizeProse('  Stable\n model,  ')).toBe(' stable model, ');
    expect(canonicalizeProse('Λ')).toBe('λ');
  });

  it('normalizes only layout whitespace for formulas', () => {
    expect(canonicalizeFormula('  λ  x + β ')).toBe('λx+β');
    expect(canonicalizeFormula('λ')).not.toBe(canonicalizeFormula('Λ'));
    expect(canonicalizeFormula('≤')).not.toBe(canonicalizeFormula('<='));
    expect(canonicalizeFormula('Ω')).not.toBe(canonicalizeFormula('Ω'));
  });

  it('recognizes exactly one trimmed Unicode scalar without normalizing it', () => {
    expect(isSingleUnicodeScalarQuery(' 𝔼 ')).toBe(true);
    expect(isSingleUnicodeScalarQuery('Ω')).toBe(true);
    expect(isSingleUnicodeScalarQuery('Ω')).toBe(true);
    expect(isSingleUnicodeScalarQuery('ab')).toBe(false);
    expect(isSingleUnicodeScalarQuery('')).toBe(false);
  });

  it('classifies notation separately from prose', () => {
    expect(classifyPdfSearchQuery('stable model')).toBe('prose');
    expect(classifyPdfSearchQuery('lambda')).toBe('prose');
    expect(classifyPdfSearchQuery('\\lambda')).toBe('symbol-command');
    expect(classifyPdfSearchQuery('λx + β')).toBe('formula');
  });

  it('keeps separate occurrences on one page distinct', () => {
    expect(buildSearchResultId(4, 2, 10, 3, { x: 4, y: 5 })).not.toBe(
      buildSearchResultId(4, 2, 30, 3, { x: 4, y: 5 }),
    );
  });
});
