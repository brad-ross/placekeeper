export interface PdfSymbolSuggestion {
  readonly glyph: string;
  readonly name: string;
  readonly latex: string;
  readonly aliases: readonly string[];
}

const SYMBOLS: readonly PdfSymbolSuggestion[] = [
  { glyph: 'β', name: 'beta', latex: '\\beta', aliases: [] },
  { glyph: 'λ', name: 'lambda', latex: '\\lambda', aliases: [] },
  { glyph: '∑', name: 'summation', latex: '\\sum', aliases: ['sum'] },
  { glyph: 'α', name: 'alpha', latex: '\\alpha', aliases: [] },
  { glyph: 'γ', name: 'gamma', latex: '\\gamma', aliases: [] },
  { glyph: 'δ', name: 'delta', latex: '\\delta', aliases: [] },
  { glyph: 'θ', name: 'theta', latex: '\\theta', aliases: [] },
  { glyph: 'μ', name: 'mu', latex: '\\mu', aliases: [] },
  { glyph: 'π', name: 'pi', latex: '\\pi', aliases: [] },
  { glyph: 'ρ', name: 'rho', latex: '\\rho', aliases: [] },
  { glyph: 'σ', name: 'sigma', latex: '\\sigma', aliases: [] },
  { glyph: 'τ', name: 'tau', latex: '\\tau', aliases: [] },
  { glyph: 'φ', name: 'phi', latex: '\\phi', aliases: [] },
  { glyph: 'ω', name: 'omega', latex: '\\omega', aliases: [] },
  { glyph: '∏', name: 'product', latex: '\\prod', aliases: [] },
  { glyph: '∫', name: 'integral', latex: '\\int', aliases: [] },
  { glyph: '∂', name: 'partial', latex: '\\partial', aliases: ['partial derivative'] },
  { glyph: '∇', name: 'nabla', latex: '\\nabla', aliases: ['gradient', 'del'] },
  { glyph: '∞', name: 'infinity', latex: '\\infty', aliases: [] },
  { glyph: '°', name: 'degree', latex: '\\degree', aliases: ['degrees'] },
  { glyph: '≤', name: 'less than or equal', latex: '\\leq', aliases: ['le', 'leq'] },
  { glyph: '≥', name: 'greater than or equal', latex: '\\geq', aliases: ['ge', 'geq'] },
  { glyph: '≠', name: 'not equal', latex: '\\neq', aliases: [] },
  { glyph: '≈', name: 'approximately equal', latex: '\\approx', aliases: ['approximately'] },
  { glyph: '→', name: 'right arrow', latex: '\\to', aliases: ['arrow'] },
  { glyph: '∈', name: 'element of', latex: '\\in', aliases: [] },
  { glyph: '∀', name: 'for all', latex: '\\forall', aliases: [] },
  { glyph: '∃', name: 'there exists', latex: '\\exists', aliases: [] },
];

function normalizedAlias(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase();
}

export function detectedSymbolSuggestions(
  detectedGlyphs: ReadonlySet<string>,
): PdfSymbolSuggestion[] {
  return SYMBOLS.filter(({ glyph }) => detectedGlyphs.has(glyph));
}

export function resolveDetectedSymbolQuery(
  query: string,
  detectedGlyphs: ReadonlySet<string>,
): PdfSymbolSuggestion | null {
  const normalized = normalizedAlias(query);
  return detectedSymbolSuggestions(detectedGlyphs).find((symbol) => (
    symbol.glyph === query
    || normalizedAlias(symbol.name) === normalized
    || normalizedAlias(symbol.latex) === normalized
    || symbol.aliases.some((alias) => normalizedAlias(alias) === normalized)
  )) ?? null;
}

export function isSymbolAliasQuery(query: string): boolean {
  const normalized = normalizedAlias(query);
  return SYMBOLS.some((symbol) => (
    symbol.glyph === query
    || normalizedAlias(symbol.name) === normalized
    || normalizedAlias(symbol.latex) === normalized
    || symbol.aliases.some((alias) => normalizedAlias(alias) === normalized)
  ));
}
