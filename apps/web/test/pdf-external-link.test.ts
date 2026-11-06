import { PdfActionType } from '@embedpdf/models';
import { expect, it } from 'vitest';
import { classifyPdfExternalLink } from '../src/pdf/pdf-external-link.js';

it('accepts only embedded web URI actions', () => {
  expect(classifyPdfExternalLink({ type: 'action', action: { type: PdfActionType.URI, uri: 'https://example.com/a#b' } })).toBe('https://example.com/a#b');
  for (const target of [undefined, 'https://example.com', { type: 'destination' },
    { type: 'action', action: { type: PdfActionType.Launch, uri: 'https://example.com' } },
    { type: 'action', action: { type: PdfActionType.URI, uri: 'file:///tmp/a' } }]) {
    expect(classifyPdfExternalLink(target)).toBeNull();
  }
});
