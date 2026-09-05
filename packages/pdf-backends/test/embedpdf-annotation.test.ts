import {
  PdfAnnotationName,
  PdfAnnotationSubtype,
  type PdfAnnotationObject,
} from '@embedpdf/models';
import { describe, expect, it } from 'vitest';

import {
  annotationPreservationSignature,
  pdfRewriteMarkers,
} from '../src/embedpdf-annotation.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const baseAnnotation = {
  id: 'runtime-id-one',
  type: PdfAnnotationSubtype.TEXT,
  rect: { origin: { x: 40, y: 50 }, size: { width: 18, height: 18 } },
  contents: 'Check this claim.',
  author: 'Placekeeper',
  flags: ['print'],
  opacity: 0.45,
  strokeColor: '#1565c0',
  fillColor: '#ffffff',
  name: PdfAnnotationName.Note,
  created: new Date('2026-09-03T12:00:00.000Z'),
  modified: new Date('2026-09-03T12:01:00.000Z'),
  appearanceModes: 1,
  custom: { placekeeper: { owner: 'placekeeper', schemaVersion: 2 } },
} as unknown as PdfAnnotationObject;

describe('annotationPreservationSignature', () => {
  it('ignores only PDFium runtime ID changes', () => {
    expect(annotationPreservationSignature({
      ...baseAnnotation,
      id: 'runtime-id-two',
    }, 0)).toBe(annotationPreservationSignature(baseAnnotation, 0));

    expect(annotationPreservationSignature(baseAnnotation, 1))
      .not.toBe(annotationPreservationSignature(baseAnnotation, 0));
  });

  it.each([
    ['opacity', { opacity: 0.8 }],
    ['stroke color', { strokeColor: '#d32f2f' }],
    ['fill color', { fillColor: '#eeeeee' }],
    ['annotation name', { name: PdfAnnotationName.Insert }],
    ['creation date', { created: new Date('2026-09-04T12:00:00.000Z') }],
    ['modified date', { modified: new Date('2026-09-04T12:01:00.000Z') }],
    ['appearance modes', { appearanceModes: 0 }],
    ['custom metadata', { custom: { placekeeper: { owner: 'other', schemaVersion: 2 } } }],
  ])('detects a changed %s', (_label, change) => {
    expect(annotationPreservationSignature({
      ...baseAnnotation,
      ...change,
    } as PdfAnnotationObject, 0)).not.toBe(annotationPreservationSignature(baseAnnotation, 0));
  });
});

describe('pdfRewriteMarkers', () => {
  it('does not match absent or partial rewrite markers', () => {
    expect(pdfRewriteMarkers(encode('%PDF-1.7\n////Encryp\n////DocMD\n%%EOF'))).toEqual({
      encrypted: false,
      docMdp: false,
    });
  });

  it('detects both rewrite markers', () => {
    expect(pdfRewriteMarkers(encode(
      '%PDF-1.7\n1 0 obj\n<< /Encrypt 4 0 R /Perms << /DocMDP 7 0 R >> >>\n%%EOF',
    ))).toEqual({
      encrypted: true,
      docMdp: true,
    });
  });

  it.each([
    ['/Encrypt', '/Encryptordinary-data'],
    ['/Encrypt', 'ordinary-data/Encrypt'],
    ['/DocMDP', '/DocMDPordinary-data'],
    ['/DocMDP', 'ordinary-data/DocMDP'],
  ])('detects %s at a buffer boundary', (marker, source) => {
    const result = pdfRewriteMarkers(encode(source));
    expect(marker === '/Encrypt' ? result.encrypted : result.docMdp).toBe(true);
  });
});
