import { describe, expect, it } from 'vitest';

import {
  addDetectedSymbolRecordIds,
  detectedSymbolSuggestions,
  isSymbolAliasQuery,
  resolveDetectedSymbolQueries,
  type PdfSymbolRecordId,
} from '../src/pdf/pdf-symbol-catalog.js';

function detected(text: string): Set<PdfSymbolRecordId> {
  const result = new Set<PdfSymbolRecordId>();
  addDetectedSymbolRecordIds(text, result);
  return result;
}

describe('PDF symbol catalog', () => {
  it('offers only generated mathematical symbols detected in the current PDF', () => {
    expect(detectedSymbolSuggestions(detected('Let λ and β be fixed ∑'))
      .map(({ glyph }) => glyph)).toEqual(['β', 'λ', '∑']);
  });

  it('resolves authoritative names and commands only through detected record IDs', () => {
    const ids = detected('λ β ∑');

    expect(resolveDetectedSymbolQueries('greek small letter lamda', ids)
      .map(({ glyph }) => glyph)).toEqual(['λ']);
    expect(resolveDetectedSymbolQueries('GREEK SMALL LETTER LAMDA', ids)
      .map(({ glyph }) => glyph)).toEqual(['λ']);
    expect(resolveDetectedSymbolQueries('\\lambda', ids).map(({ glyph }) => glyph))
      .toEqual(['λ']);
    expect(resolveDetectedSymbolQueries('alpha', ids)).toEqual([]);
  });

  it('does not treat a one-scalar literal as a semantic alias query', () => {
    const ids = detected('λ');

    expect(resolveDetectedSymbolQueries('λ', ids)).toEqual([]);
    expect(isSymbolAliasQuery('λ')).toBe(false);
  });

  it('recognizes catalog aliases before checking this document inventory', () => {
    expect(isSymbolAliasQuery('theta')).toBe(true);
    expect(resolveDetectedSymbolQueries('deg', detected('°'))[0]?.glyph).toBe('°');
    expect(isSymbolAliasQuery('stability')).toBe(false);
  });

  it('covers the reported PDF inventory with aliases present in the generated source', () => {
    const inventory = [
      ['·', '\\cdot'], ['Π', '\\Pi'], ['α', '\\alpha'], ['δ', '\\delta'],
      ['θ', '\\theta'], ['κ', '\\kappa'], ['λ', '\\lambda'], ['ν', '\\nu'],
      ['ξ', '\\xi'], ['ρ', '\\rho'], ['σ', '\\sigma'], ['τ', '\\tau'],
      ['ϕ', 'varphi'], ['ϵ', 'varepsilon'], ['˜', 'small tilde'],
      ['→', '\\rightarrow'], ['∂', '\\partial'], ['∈', '\\in'], ['∑', '\\sum'],
      ['−', 'minus'], ['∗', '\\ast'], ['∝', '\\propto'], ['∫', '\\int'],
      ['≡', '\\equiv'], ['≤', '\\leq'], ['≥', '\\geq'],
      ['⏐', 'vertical line extension'], ['+', 'plus sign'], ['<', 'less-than sign'],
      ['=', 'equals sign'], ['>', 'greater-than sign'], ['|', 'vertical line'], ['/', 'solidus'],
    ] as const;
    const ids = detected(inventory.map(([glyph]) => glyph).join(' '));

    for (const [glyph, query] of inventory) {
      expect(resolveDetectedSymbolQueries(query, ids).map((entry) => entry.glyph), query)
        .toContain(glyph);
    }
  });

  it('preserves case for commands and entity identifiers', () => {
    const ids = detected('π Π α Α');

    expect(resolveDetectedSymbolQueries('pi', ids).map(({ glyph }) => glyph)).toEqual(['π']);
    expect(resolveDetectedSymbolQueries('Pi', ids).map(({ glyph }) => glyph)).toEqual(['Π']);
    expect(resolveDetectedSymbolQueries('PI', ids)).toEqual([]);
    expect(resolveDetectedSymbolQueries('alpha', ids).map(({ glyph }) => glyph)).toEqual(['α']);
    expect(resolveDetectedSymbolQueries('Alpha', ids).map(({ glyph }) => glyph)).toEqual(['Α']);
    expect(resolveDetectedSymbolQueries('ALPHA', ids)).toEqual([]);
    expect(resolveDetectedSymbolQueries('\\pi', ids).map(({ glyph }) => glyph)).toEqual(['π']);
    expect(resolveDetectedSymbolQueries('\\Pi', ids).map(({ glyph }) => glyph)).toEqual(['Π']);
    expect(resolveDetectedSymbolQueries('\\PI', ids)).toEqual([]);
  });

  it('returns every detected glyph in an audited shared-command group', () => {
    const ids = detected('φ ϕ');

    expect(resolveDetectedSymbolQueries('\\phi', ids).map(({ glyph }) => glyph))
      .toEqual(['φ', 'ϕ']);
  });

  it('does not rewrite ASCII hyphen or invent a command for U+23D0', () => {
    const ids = detected('- − ⏐ |');

    expect(resolveDetectedSymbolQueries('-', ids)).toEqual([]);
    expect(resolveDetectedSymbolQueries('minus', ids).map(({ glyph }) => glyph)).toEqual(['−']);
    const extension = resolveDetectedSymbolQueries('vertical line extension', ids)[0];
    expect(extension).toMatchObject({ glyph: '⏐', preferredCommand: null, commands: [] });
    expect(resolveDetectedSymbolQueries('\\vert', ids).map(({ glyph }) => glyph)).toEqual(['|']);
  });

  it('does not promote ordinary prose letters or private-use scalars to suggestions', () => {
    expect(detectedSymbolSuggestions(detected('Café \u{E000}'))).toEqual([]);
  });

  it('retains admitted punctuation such as the target PDF solidus in suggestions', () => {
    expect(detectedSymbolSuggestions(detected('/')).map(({ glyph }) => glyph)).toEqual(['/']);
  });

  it('does not fan out through an unaudited shared description', () => {
    const ids = detected('" & < > © ® ™');

    expect(resolveDetectedSymbolQueries('legacy uppercase name', ids)).toEqual([]);
  });

  it('accumulates record IDs without revisiting earlier text', () => {
    const ids = new Set<PdfSymbolRecordId>();

    expect(addDetectedSymbolRecordIds('λ', ids)).toBe(true);
    expect(addDetectedSymbolRecordIds('λ', ids)).toBe(false);
    expect(addDetectedSymbolRecordIds('β', ids)).toBe(true);
    expect(detectedSymbolSuggestions(ids).map(({ glyph }) => glyph)).toEqual(['β', 'λ']);
  });
});
