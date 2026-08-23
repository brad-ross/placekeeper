import { describe, expect, it } from 'vitest';

import {
  detectedSymbolSuggestions,
  isSymbolAliasQuery,
  resolveDetectedSymbolQueries,
} from '../src/pdf/pdf-symbol-catalog.js';

describe('PDF symbol catalog', () => {
  const detected = new Set(['λ', 'β', '∑']);

  const extractedMathSymbols = [
    ['·', 'center dot', '\\cdot'],
    ['Π', 'capital pi', '\\Pi'],
    ['α', 'alpha', '\\alpha'],
    ['δ', 'delta', '\\delta'],
    ['θ', 'theta', '\\theta'],
    ['κ', 'kappa', '\\kappa'],
    ['λ', 'lambda', '\\lambda'],
    ['ν', 'nu', '\\nu'],
    ['ξ', 'xi', '\\xi'],
    ['ρ', 'rho', '\\rho'],
    ['σ', 'sigma', '\\sigma'],
    ['τ', 'tau', '\\tau'],
    ['ϕ', 'phi', '\\phi'],
    ['ϵ', 'epsilon', '\\epsilon'],
    ['˜', 'tilde', '\\tilde'],
    ['→', 'right arrow', '\\to'],
    ['∂', 'partial', '\\partial'],
    ['∈', 'element of', '\\in'],
    ['∑', 'summation', '\\sum'],
    ['−', 'minus', '-'],
    ['∗', 'asterisk', '\\ast'],
    ['∝', 'proportional to', '\\propto'],
    ['∫', 'integral', '\\int'],
    ['≡', 'equivalent', '\\equiv'],
    ['≤', 'less than or equal', '\\leq'],
    ['≥', 'greater than or equal', '\\geq'],
    ['⏐', 'vertical line extension', '\\vert'],
  ] as const;

  it('offers only symbols detected in the current PDF', () => {
    expect(detectedSymbolSuggestions(detected).map(({ glyph }) => glyph)).toEqual(['β', 'λ', '∑']);
  });

  it('resolves names and LaTeX commands only through detected glyphs', () => {
    expect(resolveDetectedSymbolQueries('lambda', detected).map(({ glyph }) => glyph)).toEqual(['λ']);
    expect(resolveDetectedSymbolQueries('\\lambda', detected).map(({ glyph }) => glyph))
      .toEqual(['λ']);
    expect(resolveDetectedSymbolQueries('alpha', detected)).toEqual([]);
  });

  it('does not treat a literal name as a symbol without explicit resolution', () => {
    expect(resolveDetectedSymbolQueries('lambda', new Set())).toEqual([]);
  });

  it('recognizes known names even before checking this document inventory', () => {
    expect(isSymbolAliasQuery('theta')).toBe(true);
    expect(resolveDetectedSymbolQueries('\\degree', new Set(['°']))[0]?.glyph).toBe('°');
    expect(isSymbolAliasQuery('stability')).toBe(false);
  });

  it('resolves supported extracted mathematical symbols', () => {
    const extractedMathInventory = new Set(extractedMathSymbols.map(([glyph]) => glyph));

    for (const [glyph, name, latex] of extractedMathSymbols) {
      expect(resolveDetectedSymbolQueries(name, extractedMathInventory).map((entry) => entry.glyph))
        .toContain(glyph);
      if (latex.startsWith('\\')) {
        expect(resolveDetectedSymbolQueries(latex, extractedMathInventory).map((entry) => entry.glyph))
          .toContain(glyph);
      }
    }
  });

  it('preserves case for LaTeX commands that distinguish capital Greek letters', () => {
    const piVariants = new Set(['π', 'Π']);

    expect(resolveDetectedSymbolQueries('pi', piVariants).map(({ glyph }) => glyph)).toEqual(['π']);
    expect(resolveDetectedSymbolQueries('capital pi', piVariants).map(({ glyph }) => glyph))
      .toEqual(['Π']);
    expect(resolveDetectedSymbolQueries('\\pi', piVariants).map(({ glyph }) => glyph))
      .toEqual(['π']);
    expect(resolveDetectedSymbolQueries('\\Pi', piVariants).map(({ glyph }) => glyph))
      .toEqual(['Π']);
  });

  it('returns every detected glyph mapped to a shared alias', () => {
    const variants = new Set(['φ', 'ϕ', '|', '⏐']);

    expect(resolveDetectedSymbolQueries('\\phi', variants).map(({ glyph }) => glyph))
      .toEqual(['φ', 'ϕ']);
    expect(resolveDetectedSymbolQueries('\\vert', variants).map(({ glyph }) => glyph))
      .toEqual(['|', '⏐']);
  });

  it('does not rewrite a literal ASCII hyphen to Unicode minus', () => {
    const minus = new Set(['−']);

    expect(resolveDetectedSymbolQueries('-', minus)).toEqual([]);
    expect(resolveDetectedSymbolQueries('minus', minus).map(({ glyph }) => glyph)).toEqual(['−']);
  });
});
