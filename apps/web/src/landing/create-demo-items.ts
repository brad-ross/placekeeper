import type { ReviewItem } from '../../../../packages/core/src/review-model.js';

/** User-authored examples on original page 14 of arXiv:2312.07520v3.
 * Top-origin anchors preserve the selections and caret from the live demo.
 */
export async function createDemoItems(): Promise<ReviewItem[]> {
  const samples: Pick<ReviewItem, 'kind' | 'payload'>[] = [
    {
      kind: 'highlight',
      payload: {
        quote: 'The algorithm then repeats this process with super cohorts playing the role of the original cohorts:',
        comment: 'Is this language too redundant?',
        prefix: '', suffix: '', reliable: true,
        rect: { x: 68, y: 550, width: 493, height: 16 },
        segmentRects: [{ x: 68, y: 550, width: 493, height: 16 }],
      },
    },
    {
      kind: 'insert',
      payload: {
        proposedText: 'same-component',
        leftContext: '', rightContext: '', reliable: true,
        position: { x: 175, y: 604, width: 2, height: 15 },
      },
    },
    {
      kind: 'replace',
      payload: {
        quote: 'a finite number of iterations',
        proposedText: 'finitely many iterations',
        prefix: '', suffix: '', reliable: true,
        rect: { x: 247, y: 622, width: 140, height: 15 },
        segmentRects: [{ x: 247, y: 622, width: 140, height: 15 }],
      },
    },
    {
      kind: 'delete',
      payload: {
        quote: '; it cannot decrease further once super cohorts stop changing',
        prefix: '', suffix: '', reliable: true,
        rect: { x: 50, y: 720, width: 511, height: 25 },
        segmentRects: [
          { x: 514, y: 720, width: 47, height: 13 },
          { x: 50, y: 732, width: 218, height: 13 },
        ],
      },
    },
  ];
  return samples.map((sample, index) => ({
    ...sample,
    id: `00000000-0000-4000-8000-00000000000${index}`,
    pageIndex: 13,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  }));
}
