import { StandardFonts } from 'pdf-lib';
import { createFixturePdf } from './fixture-document.js';

/** Fixed metadata, page count and line inventory make cross-host samples comparable. */
export async function largeTextHeavyPdf(): Promise<Uint8Array> {
  const document = await createFixturePdf();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= 120; pageNumber++) {
    const page = document.addPage([612, 792]);
    page.drawText(`Large corpus page ${pageNumber}`, { x: 48, y: 744, size: 14, font });
    for (let line = 1; line <= 48; line++) {
      page.drawText(`Page ${pageNumber} line ${line}: deterministic review evidence and search token corpus-${pageNumber}-${line}.`,
        { x: 48, y: 720 - line * 13, size: 9, font });
    }
  }
  return document.save();
}

