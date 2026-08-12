import { describe, expect, it } from 'vitest';

import {
  findRelatedWordForms,
  relatedPhraseQueries,
} from '../src/pdf/pdf-search-morphology.js';

describe('PDF search morphology', () => {
  const inventory = ['stable', 'stability', 'stabilizes', 'stabilized', 'model', 'models', 'table'];

  it('keeps exact words out of conservative related forms', () => {
    expect(findRelatedWordForms('stable', inventory)).toEqual([
      'stability',
      'stabilized',
      'stabilizes',
    ]);
  });

  it('rejects unrelated suffix collisions and semantic guesses', () => {
    expect(findRelatedWordForms('stable', [...inventory, 'table', 'robust'])).not.toContain('table');
    expect(findRelatedWordForms('stable', [...inventory, 'robust'])).not.toContain('robust');
  });

  it('preserves phrase order and bounds expansion', () => {
    const related = relatedPhraseQueries('stable model', inventory);
    expect(related).toContain('stability model');
    expect(related).toContain('stabilizes models');
    expect(related).not.toContain('model stability');
    expect(related.length).toBeLessThanOrEqual(64);
  });
});
