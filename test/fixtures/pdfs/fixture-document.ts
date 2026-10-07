import { PDFDocument } from 'pdf-lib';

const fixtureMetadataDate = new Date('2024-01-01T00:00:00.000Z');

export async function createFixturePdf(): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  // pdf-lib otherwise stamps both values with the wall clock. These fixtures
  // are integrity-pinned release inputs, so their metadata must be reproducible.
  document.setCreationDate(fixtureMetadataDate);
  document.setModificationDate(fixtureMetadataDate);
  return document;
}

