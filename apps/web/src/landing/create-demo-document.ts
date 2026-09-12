import { PDFDocument, PDFDict, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';

/** A small, original document with selectable text, real destinations, and an outline. */
export async function createDemoDocument(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Urban trees and summer heat');
  pdf.setAuthor('Placekeeper');
  const body = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const sans = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = Array.from({ length: 4 }, () => pdf.addPage([612, 792]));
  const ink = rgb(.2, .2, .2);
  const titles = ['Urban trees and summer heat', 'Results', 'Appendix A. Measurement', 'References'];
  for (const [index, page] of pages.entries()) {
    page.drawText('FIELD NOTES  /  URBAN ENVIRONMENT', { x: 58, y: 747, font: sans, size: 8, color: rgb(.45, .45, .45) });
    page.drawText(String(index + 1), { x: 548, y: 747, font: sans, size: 8, color: ink });
    page.drawText(titles[index]!, { x: 58, y: 690, font: bold, size: index === 0 ? 25 : 21, color: ink });
  }
  const paragraph = (pageIndex: number, text: string, y: number) => {
    const page = pages[pageIndex]!;
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (body.widthOfTextAtSize(next, 12) > 490) {
        page.drawText(line, { x: 58, y, font: body, size: 12, color: ink });
        y -= 20;
        line = word;
      } else line = next;
    }
    if (line) page.drawText(line, { x: 58, y, font: body, size: 12, color: ink });
    return y - 35;
  };
  pages[0]!.drawText('A short study of shade, streets, and the spaces between buildings', { x: 58, y: 660, font: body, size: 12, color: rgb(.45, .45, .45) });
  let y = paragraph(0, 'Abstract. Trees change how a city feels on a summer afternoon. Their shade cools the pavement, while their leaves move water back into the air. This note considers how the location of trees matters alongside the total amount of tree cover.', 608);
  const linksY = y;
  y -= 100;
  pages[0]!.drawText('1  Shade at street level', { x: 58, y, font: bold, size: 16, color: ink });
  y = paragraph(0, 'A shaded route can be more useful than an isolated patch of green. For a person walking to work, what matters is not only the temperature at the destination but also the exposure along the way. Connected shade makes the journey more comfortable.', y - 32);
  y = paragraph(0, 'The largest differences appear in the afternoon, when direct sunlight reaches the pavement. Streets with continuous canopy remain cooler than exposed streets nearby. The pattern persists across the different measurement locations.', y);
  const link = (label: string, target: number, linkY: number) => {
    const x = 58;
    pages[0]!.drawText(label, { x, y: linkY, font: body, size: 12, color: rgb(.22, .35, .5) });
    const width = body.widthOfTextAtSize(label, 12);
    pages[0]!.drawLine({ start: { x, y: linkY - 2 }, end: { x: x + width, y: linkY - 2 }, thickness: .5, color: rgb(.22, .35, .5) });
    return pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [x, linkY - 3, x + width, linkY + 13], Border: [0, 0, 0], Dest: [pages[target]!.ref, 'XYZ', null, 710, null] }));
  };
  pages[0]!.node.set(PDFName.of('Annots'), pdf.context.obj([
    link('Table 1. Afternoon temperatures by street type', 1, linksY),
    link('Appendix A. How the measurements were collected', 2, linksY - 28),
    link('References and further reading', 3, linksY - 56),
  ]));
  paragraph(0, 'These observations suggest a practical priority: connect existing shaded segments before adding isolated trees. The quality of a route depends on the gaps as much as on its average canopy cover.', y);
  pages[1]!.drawText('Table 1. Afternoon temperatures by street type', { x: 58, y: 644, font: bold, size: 14, color: ink });
  const rows = [['Street type', 'Surface temperature', 'Canopy cover'], ['Continuous shade', '28.4 C', '72%'], ['Intermittent shade', '33.1 C', '38%'], ['Exposed pavement', '39.7 C', '6%']];
  rows.forEach((row, i) => {
    const rowY = 602 - i * 35;
    row.forEach((text, column) => pages[1]!.drawText(text, { x: [58, 264, 435][column]!, y: rowY, size: 11, font: i === 0 ? bold : body, color: ink }));
    pages[1]!.drawLine({ start: { x: 58, y: rowY - 12 }, end: { x: 552, y: rowY - 12 }, thickness: .5, color: rgb(.7, .7, .7) });
  });
  paragraph(1, 'Note: the values in this sample document are illustrative. Surface temperatures describe the pavement, not the surrounding air. Differences across streets also reflect building height, orientation, and the materials used at ground level.', 425);
  paragraph(1, '2  Interpreting the pattern', 307);
  paragraph(1, 'Shade affects both the level and the timing of exposure. A street can have substantial canopy cover and still leave a long unshaded section at the hottest part of the day. Measurements taken along a route reveal these gaps.', 270);
  y = 636;
  for (const text of [
    'Measurements were collected along walking routes at regular intervals. Each observation recorded surface conditions, nearby trees, and whether the pavement was shaded at the moment of measurement.',
    'The routes crossed residential streets, commercial blocks, and small public spaces. Keeping the measurement interval consistent made it possible to compare connected shade with scattered patches of cover.',
    'A second visit followed the same route later in the afternoon. This helped distinguish persistent shade from a temporary shadow cast by a nearby building.',
    'The analysis describes local conditions. It does not separate the effects of trees from every other feature of a street. Repeated observations and careful comparisons would be needed to estimate a causal effect.',
    'For planning purposes, a map of the unshaded gaps can be as useful as a map of the trees themselves. It identifies where an additional tree might connect two otherwise comfortable walking segments.',
  ]) y = paragraph(2, text, y);
  paragraph(3, 'This original sample document was prepared for the Placekeeper interactive demo. The measurements are illustrative, and the document is free to annotate.', 630);
  paragraph(3, 'Suggested questions: Where would additional shade help most? What else might explain the differences in Table 1? Which measurements would you collect next?', 535);
  const outline = pdf.context.register(pdf.context.obj({ Type: 'Outlines' }));
  const items = pages.map((page, i) => pdf.context.register(pdf.context.obj({ Title: PDFString.of(titles[i]!), Parent: outline, Dest: [page.ref, 'Fit'] })));
  items.forEach((item, i) => {
    const dict = pdf.context.lookup(item, PDFDict);
    if (i > 0) dict.set(PDFName.of('Prev'), items[i - 1]!);
    if (i < items.length - 1) dict.set(PDFName.of('Next'), items[i + 1]!);
  });
  pdf.context.assign(outline, pdf.context.obj({ Type: 'Outlines', First: items[0], Last: items.at(-1), Count: items.length }));
  pdf.catalog.set(PDFName.of('Outlines'), outline);
  return pdf.save();
}
