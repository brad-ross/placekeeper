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
  { glyph: 'κ', name: 'kappa', latex: '\\kappa', aliases: [] },
  { glyph: 'μ', name: 'mu', latex: '\\mu', aliases: [] },
  { glyph: 'ν', name: 'nu', latex: '\\nu', aliases: [] },
  { glyph: 'ξ', name: 'xi', latex: '\\xi', aliases: [] },
  { glyph: 'π', name: 'pi', latex: '\\pi', aliases: [] },
  { glyph: 'Π', name: 'capital pi', latex: '\\Pi', aliases: ['uppercase pi'] },
  { glyph: 'ρ', name: 'rho', latex: '\\rho', aliases: [] },
  { glyph: 'σ', name: 'sigma', latex: '\\sigma', aliases: [] },
  { glyph: 'τ', name: 'tau', latex: '\\tau', aliases: [] },
  { glyph: 'φ', name: 'phi', latex: '\\phi', aliases: [] },
  {
    glyph: 'ϕ',
    name: 'phi',
    latex: '\\phi',
    aliases: ['phi symbol', 'varphi', '\\varphi'],
  },
  {
    glyph: 'ϵ',
    name: 'epsilon',
    latex: '\\epsilon',
    aliases: ['epsilon symbol', 'varepsilon', '\\varepsilon'],
  },
  { glyph: 'ω', name: 'omega', latex: '\\omega', aliases: [] },
  { glyph: '+', name: 'plus', latex: '+', aliases: ['plus sign'] },
  { glyph: '−', name: 'minus', latex: '-', aliases: ['minus sign', 'negative'] },
  { glyph: '=', name: 'equals', latex: '=', aliases: ['equal', 'equals sign'] },
  { glyph: '<', name: 'less than', latex: '<', aliases: [] },
  { glyph: '>', name: 'greater than', latex: '>', aliases: [] },
  { glyph: '/', name: 'slash', latex: '/', aliases: ['solidus', 'division slash'] },
  {
    glyph: '|',
    name: 'vertical bar',
    latex: '\\vert',
    aliases: ['vertical line', 'absolute value', 'mid', '\\mid'],
  },
  {
    glyph: '⏐',
    name: 'vertical line extension',
    latex: '\\vert',
    aliases: ['delimiter extension'],
  },
  { glyph: '·', name: 'center dot', latex: '\\cdot', aliases: ['middle dot', 'dot'] },
  { glyph: '˜', name: 'tilde', latex: '\\tilde', aliases: ['small tilde'] },
  { glyph: '∗', name: 'asterisk', latex: '\\ast', aliases: ['asterisk operator'] },
  {
    glyph: '∝',
    name: 'proportional to',
    latex: '\\propto',
    aliases: ['proportional'],
  },
  { glyph: '≡', name: 'equivalent', latex: '\\equiv', aliases: ['identical to'] },
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

const SYMBOL_GLYPHS = new Set(SYMBOLS.map(({ glyph }) => glyph));

function normalizedAlias(value: string): string {
  return value.normalize('NFC').trim().toLocaleLowerCase();
}

function normalizedExact(value: string): string {
  return value.normalize('NFC').trim();
}

function matchesAlias(
  symbol: PdfSymbolSuggestion,
  exactQuery: string,
  normalizedQuery: string,
): boolean {
  return symbol.glyph === exactQuery
    || normalizedAlias(symbol.name) === normalizedQuery
    || (symbol.latex.startsWith('\\') && normalizedExact(symbol.latex) === exactQuery)
    || symbol.aliases.some((alias) => (
      alias.startsWith('\\')
        ? normalizedExact(alias) === exactQuery
        : normalizedAlias(alias) === normalizedQuery
    ));
}

export function isKnownSymbolGlyph(value: string): boolean {
  return SYMBOL_GLYPHS.has(value);
}

export function detectedSymbolSuggestions(
  detectedGlyphs: ReadonlySet<string>,
): PdfSymbolSuggestion[] {
  return SYMBOLS.filter(({ glyph }) => detectedGlyphs.has(glyph));
}

export function resolveDetectedSymbolQueries(
  query: string,
  detectedGlyphs: ReadonlySet<string>,
): PdfSymbolSuggestion[] {
  const exactQuery = normalizedExact(query);
  const normalizedQuery = normalizedAlias(query);
  return detectedSymbolSuggestions(detectedGlyphs)
    .filter((symbol) => matchesAlias(symbol, exactQuery, normalizedQuery));
}

export function isSymbolAliasQuery(query: string): boolean {
  const exactQuery = normalizedExact(query);
  const normalizedQuery = normalizedAlias(query);
  return SYMBOLS.some((symbol) => matchesAlias(symbol, exactQuery, normalizedQuery));
}
