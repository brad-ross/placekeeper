import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { ReviewItem } from '../../../../packages/core/src/review-model.js';

/** Anchors use the same font, wrapping and page coordinates as the sample abstract. */
export async function createDemoItems(): Promise<ReviewItem[]> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const text = 'Abstract. Trees change how a city feels on a summer afternoon. Their shade cools the pavement, while their leaves move water back into the air. This note considers how the location of trees matters alongside the total amount of tree cover.';
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, 12) > 490) { lines.push(line); line = word; }
    else line = next;
  }
  lines.push(line);
  const samples = [
    { kind: 'highlight', quote: 'Trees change how a city feels', comment: 'A useful summary of the question.' },
    { kind: 'delete', quote: 'This note considers' },
    { kind: 'replace', quote: 'the total amount of tree cover', proposedText: 'overall canopy cover' },
  ] as const;
  return samples.map((sample, index) => {
    const row = lines.findIndex((value) => value.includes(sample.quote));
    if (row < 0) throw new Error(`Sample passage is not on one line: ${sample.quote}`);
    const prefix = lines[row]!.split(sample.quote)[0]!;
    const rect = { x: 58 + font.widthOfTextAtSize(prefix, 12), y: 792 - (608 - row * 20) - 10, width: font.widthOfTextAtSize(sample.quote, 12), height: 13 };
    return { id: `00000000-0000-4000-8000-00000000000${index}`, kind: sample.kind, pageIndex: 0,
      createdAt: '2026-09-12T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
      payload: { quote: sample.quote, ...('comment' in sample ? { comment: sample.comment } : {}), ...('proposedText' in sample ? { proposedText: sample.proposedText } : {}), prefix, suffix: '', rect, segmentRects: [rect], reliable: true } };
  });
}
