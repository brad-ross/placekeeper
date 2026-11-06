import { PdfActionType } from '@embedpdf/models';
import { externalWebUrl } from '../../../../packages/core/src/external-web-url.js';

export function classifyPdfExternalLink(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'action' || !('action' in value)) return null;
  const action = value.action;
  if (!action || typeof action !== 'object' || !('type' in action) || action.type !== PdfActionType.URI || !('uri' in action)) return null;
  return externalWebUrl(action.uri);
}
