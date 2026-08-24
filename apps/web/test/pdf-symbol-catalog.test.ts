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

  it('ranks detected suggestions by search likelihood with code-point tie-breaking', () => {
    expect(detectedSymbolSuggestions(detected(', ( + 𝟘 α'))
      .map(({ glyph }) => glyph)).toEqual(['α', '𝟘', '+', '(', ',']);
    expect(detectedSymbolSuggestions(detected('λ β'))
      .map(({ glyph }) => glyph)).toEqual(['β', 'λ']);
  });

  it('re-ranks each progressive inventory independently of discovery order', () => {
    const ids = new Set<PdfSymbolRecordId>();

    addDetectedSymbolRecordIds(',', ids);
    expect(detectedSymbolSuggestions(ids).map(({ glyph }) => glyph)).toEqual([',']);
    addDetectedSymbolRecordIds('+', ids);
    expect(detectedSymbolSuggestions(ids).map(({ glyph }) => glyph)).toEqual(['+', ',']);
    addDetectedSymbolRecordIds('𝟘', ids);
    expect(detectedSymbolSuggestions(ids).map(({ glyph }) => glyph)).toEqual(['𝟘', '+', ',']);
    addDetectedSymbolRecordIds('λ', ids);
    expect(detectedSymbolSuggestions(ids).map(({ glyph }) => glyph)).toEqual(['λ', '𝟘', '+', ',']);
    addDetectedSymbolRecordIds('β', ids);
    expect(detectedSymbolSuggestions(ids).map(({ glyph }) => glyph)).toEqual([
      'β', 'λ', '𝟘', '+', ',',
    ]);
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
    expect(detectedSymbolSuggestions(detected('°'))[0]?.preferredCommand).toBe('\\textdegree');
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

  it.each([
    ['∑', 'summation'],
    ['∏', 'product'],
    ['∂', 'partial'],
    ['∂', 'partial derivative'],
    ['∇', 'gradient'],
    ['∇', 'del'],
    ['°', 'degree'],
    ['°', '\\degree'],
    ['°', 'degrees'],
    ['≤', 'less than or equal'],
    ['≥', 'greater than or equal'],
    ['≠', 'not equal'],
    ['≠', '\\neq'],
    ['≈', 'approximately equal'],
    ['≈', 'approximately'],
    ['→', 'right arrow'],
    ['→', '\\to'],
    ['→', 'arrow'],
  ] as const)('preserves legacy compatibility input %s through %s', (glyph, query) => {
    expect(resolveDetectedSymbolQueries(query, detected(glyph)).map((record) => record.glyph))
      .toEqual([glyph]);
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

  it.each([
    ['\\beta', 'β ϐ', ['β', 'ϐ']],
    ['\\epsilon', 'ε ϵ', ['ε', 'ϵ']],
    ['\\theta', 'θ ϑ', ['θ', 'ϑ']],
    ['\\kappa', 'κ ϰ', ['κ', 'ϰ']],
    ['\\rho', 'ρ ϱ', ['ρ', 'ϱ']],
    ['\\phi', 'φ ϕ', ['φ', 'ϕ']],
    ['\\pi', 'π ϖ', ['π', 'ϖ']],
    ['\\Theta', 'Θ ϴ', ['Θ', 'ϴ']],
    ['\\Upsilon', 'Υ ϒ', ['Υ', 'ϒ']],
    ['\\mu', 'μ µ', ['µ', 'μ']],
  ] as const)('expands generic Greek-family query %s across detected variants', (
    query,
    documentText,
    expectedGlyphs,
  ) => {
    expect(resolveDetectedSymbolQueries(query, detected(documentText)).map(({ glyph }) => glyph))
      .toEqual(expectedGlyphs);
  });

  it('expands a canonical query to detected styled members but keeps styled aliases narrow', () => {
    const ids = detected('β 𝛃');

    expect(resolveDetectedSymbolQueries('\\beta', ids).map(({ glyph }) => glyph))
      .toEqual(['β', '𝛃']);
    expect(resolveDetectedSymbolQueries('beta', ids).map(({ glyph }) => glyph))
      .toEqual(['β', '𝛃']);
    expect(resolveDetectedSymbolQueries('\\mbfbeta', ids).map(({ glyph }) => glyph))
      .toEqual(['𝛃']);
  });

  it('keeps epsilon aliases inside the Greek family and leaves IPA open e independently searchable', () => {
    const ids = detected('ε ϵ 𝛆 𝛜 ɛ');
    const greekFamily = ['ε', 'ϵ', '𝛆', '𝛜'];

    expect(resolveDetectedSymbolQueries('\\epsilon', ids).map(({ glyph }) => glyph))
      .toEqual(greekFamily);
    expect(resolveDetectedSymbolQueries('\\varepsilon', ids).map(({ glyph }) => glyph))
      .toEqual(greekFamily);
    expect(resolveDetectedSymbolQueries('varepsilon', ids).map(({ glyph }) => glyph))
      .toEqual(greekFamily);
    expect(resolveDetectedSymbolQueries('\\mbfvarepsilon', ids).map(({ glyph }) => glyph))
      .toEqual(['𝛆']);
    expect(resolveDetectedSymbolQueries('latin small letter open e', ids).map(({ glyph }) => glyph))
      .toEqual(['ɛ']);
  });

  it('keeps final sigma separate while expanding each sigma family to its styled members', () => {
    const ids = detected('ς σ 𝛓 𝛔');

    expect(resolveDetectedSymbolQueries('\\sigma', ids).map(({ glyph }) => glyph))
      .toEqual(['σ', '𝛔']);
    expect(resolveDetectedSymbolQueries('\\varsigma', ids).map(({ glyph }) => glyph))
      .toEqual(['ς', '𝛓']);
    expect(resolveDetectedSymbolQueries('\\mbfvarsigma', ids).map(({ glyph }) => glyph))
      .toEqual(['𝛓']);
  });

  it('does not broaden aliases across dangerous mathematical lookalikes', () => {
    const ids = detected('- − | ∣ ⏐ ∅ ⌀ ~ ˜ ∼ × ∗ · ⋅');
    const cases = [
      ['minus', ['−']],
      ['\\vert', ['|']],
      ['\\mid', ['∣']],
      ['vertical line extension', ['⏐']],
      ['\\varnothing', ['∅']],
      ['\\diameter', ['⌀']],
      ['\\textasciitilde', ['~']],
      ['small tilde', ['˜']],
      ['\\sim', ['∼']],
      ['\\times', ['×']],
      ['\\ast', ['∗']],
      ['\\cdot', ['·', '⋅']],
    ] as const;

    for (const [query, expectedGlyphs] of cases) {
      expect(resolveDetectedSymbolQueries(query, ids).map(({ glyph }) => glyph), query)
        .toEqual(expectedGlyphs);
    }
  });

  it('preserves intentional command exclusions from generated family expansion', () => {
    const ids = detected('∈ ε ϵ 𝛆 ∂ 𝛛 ı 𝒤');

    expect(resolveDetectedSymbolQueries('\\in', ids).map(({ glyph }) => glyph)).toEqual(['∈']);
    expect(resolveDetectedSymbolQueries('\\partial', ids).map(({ glyph }) => glyph)).toEqual(['∂']);
    expect(resolveDetectedSymbolQueries('\\imath', ids).map(({ glyph }) => glyph)).toEqual(['ı']);
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
