import { PDFName, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';

import { createFixturePdf } from './fixture-document.js';

/** Alternating text blocks with fixed advances make simultaneous page alignment measurable. */
export async function fitTextBookPdf(): Promise<Uint8Array> {
  const document = await createFixturePdf();
  const font = await document.embedFont(StandardFonts.Courier);
  const image = await document.embedPng(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  const pages = Array.from({ length: 12 }, (_, index) => {
    const cropped = index === 6;
    const page = document.addPage(cropped ? [660, 880] : [600, 800]);
    const cropX = cropped ? 30 : 0;
    const cropY = cropped ? 40 : 0;
    if (cropped) {
      page.setCropBox(cropX, cropY, 600, 800);
      page.setRotation(degrees(90));
    }
    if (index === 4) return page;
    if (index === 5) {
      page.drawImage(image, { x: 120, y: 160, width: 360, height: 480 });
      return page;
    }
    const left = cropX + (index % 2 === 0 ? 90 : 210);
    page.drawText(`Book page ${index + 1}`, { x: cropX + 25, y: cropY + 770, font, size: 8 });
    for (let row = 0; row < 32; row++) {
      const baseline = cropY + 720 - row * 20;
      if (index === 3 && baseline >= 330 && baseline <= 460) continue;
      if (index === 2) {
        // Two 138-point columns and their 24-point gutter occupy 300 points.
        for (let column = 0; column < 2; column++) {
          const text = `Column ${column + 1} row ${String(row + 1).padStart(2, '0')} body`.padEnd(23, 'x');
          page.drawText(text, { x: left + column * 162, y: baseline, font, size: 10 });
        }
      } else {
        const text = row === 0 && index === 0
          ? 'Jump to distant text on page twelve.'
          : row === 0 && index === 11
            ? 'Distant target: stable text and aligned annotation.'
            : `Body page ${String(index + 1).padStart(2, '0')} line ${String(row + 1).padStart(2, '0')}: selectable reading text.`;
        page.drawText(text.padEnd(50, 'x').slice(0, 50), { x: left, y: baseline, font, size: 10 });
      }
    }
    if (index === 3) {
      // Vector table exceeds the body block without changing the text detector's evidence.
      for (const x of [20, 160, 300, 440, 580]) {
        page.drawLine({ start: { x, y: 350 }, end: { x, y: 450 }, thickness: 1, color: rgb(0.65, 0.1, 0.1) });
      }
      for (const y of [350, 375, 400, 425, 450]) {
        page.drawLine({ start: { x: 20, y }, end: { x: 580, y }, thickness: 1, color: rgb(0.65, 0.1, 0.1) });
      }
    }
    return page;
  });
  const context = document.context;
  const destination = context.obj([pages[11]!.ref, PDFName.of('XYZ'), 210, 720, 0]);
  const link = context.register(context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [90, 716, 390, 731],
    Border: [0, 0, 0],
    Contents: PDFString.of('Distant text target'),
    Dest: destination,
  }));
  pages[0]!.node.set(PDFName.of('Annots'), context.obj([link]));
  return document.save({ useObjectStreams: false });
}
