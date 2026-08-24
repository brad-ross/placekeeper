import { describe, expect, it } from 'vitest';

import { annotationExcerptOverflows } from '../src/review/AnnotationExcerpt.js';

describe('annotation excerpt overflow geometry', () => {
  it('only reports rendered overflow beyond the reserved three-line box', () => {
    expect(annotationExcerptOverflows({
      clientHeight: 52,
      clientWidth: 220,
      scrollHeight: 88,
      scrollWidth: 220,
    })).toBe(true);
    expect(annotationExcerptOverflows({
      clientHeight: 52,
      clientWidth: 220,
      scrollHeight: 52,
      scrollWidth: 220,
    })).toBe(false);
  });

  it('tolerates sub-pixel layout noise but catches genuine horizontal clipping', () => {
    expect(annotationExcerptOverflows({
      clientHeight: 52,
      clientWidth: 220,
      scrollHeight: 52.5,
      scrollWidth: 220.5,
    })).toBe(false);
    expect(annotationExcerptOverflows({
      clientHeight: 52,
      clientWidth: 220,
      scrollHeight: 52,
      scrollWidth: 224,
    })).toBe(true);
  });
});
