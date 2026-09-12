import type { ReviewItem } from '../../../../packages/core/src/review-model.js';

/** Top-origin anchors measured from the unchanged Section 4.1 of arXiv:2312.07520v3. */
export async function createDemoItems(): Promise<ReviewItem[]> {
  const samples = [
    { kind: 'highlight', quote: 'connected components', comment: 'A useful summary of the approach.', x: 285.386, y: 516.212, width: 115.741 },
    { kind: 'delete', quote: 'with one vertex per cohort', x: 50.4, y: 498.285, width: 143.076 },
    { kind: 'replace', quote: 'finite number of iterations', proposedText: 'finitely many iterations', x: 255.875, y: 623.775, width: 131.804 },
  ] as const;
  return samples.map((sample, index) => {
    const rect = { x: sample.x, y: sample.y, width: sample.width, height: 11.955 };
    return { id: `00000000-0000-4000-8000-00000000000${index}`, kind: sample.kind, pageIndex: 13,
      createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
      payload: { quote: sample.quote, ...('comment' in sample ? { comment: sample.comment } : {}), ...('proposedText' in sample ? { proposedText: sample.proposedText } : {}), prefix: '', suffix: '', rect, segmentRects: [rect], reliable: true } };
  });
}
