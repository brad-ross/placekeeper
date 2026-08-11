import { describe, expect, it } from 'vitest';

import {
  detectedSymbolSuggestions,
  resolveDetectedSymbolQuery,
} from '../src/pdf/pdf-symbol-catalog.js';

describe('PDF symbol catalog', () => {
  const detected = new Set(['λ', 'β', '∑']);

  it('offers only symbols detected in the current PDF', () => {
    expect(detectedSymbolSuggestions(detected).map(({ glyph }) => glyph)).toEqual(['β', 'λ', '∑']);
  });

  it('resolves names and LaTeX commands only through detected glyphs', () => {
    expect(resolveDetectedSymbolQuery('lambda', detected)?.glyph).toBe('λ');
    expect(resolveDetectedSymbolQuery('\\lambda', detected)?.glyph).toBe('λ');
    expect(resolveDetectedSymbolQuery('alpha', detected)).toBeNull();
  });

  it('does not treat a literal name as a symbol without explicit resolution', () => {
    expect(resolveDetectedSymbolQuery('lambda', new Set())).toBeNull();
  });
});
