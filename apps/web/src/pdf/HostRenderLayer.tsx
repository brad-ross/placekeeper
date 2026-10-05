import { useDocumentState } from '@embedpdf/core/react';
import { PdfErrorCode, ignore, type PdfErrorReason, type Task } from '@embedpdf/models';
import { RenderLayer, useRenderCapability } from '@embedpdf/plugin-render/react';
import { useEffect, useState, type ComponentProps } from 'react';
import type { ViewerResourcePolicy } from './embedpdf-viewer.js';

/** Codex permits data images, but does not permit Blob image URLs. */
export function subscribeNativeRaster(
  task: Pick<Task<Blob, PdfErrorReason>, 'wait' | 'abort'>,
  publish: (url: string) => void,
  readerFactory: () => FileReader = () => new FileReader(),
): () => void {
  let current = true;
  let releaseImage: (() => void) | undefined;
  task.wait(blob => {
    if (!current) return;
    releaseImage = subscribeNativeImage(blob, publish, readerFactory);
  }, ignore);
  return () => {
    current = false;
    releaseImage?.();
    task.abort({ code: PdfErrorCode.Cancelled, message: 'canceled render task' });
  };
}

export function subscribeNativeImage(blob: Blob, publish: (url: string) => void, readerFactory: () => FileReader = () => new FileReader(), onFailure: () => void = ignore): () => void {
  let current = true;
  const reader = readerFactory();
  reader.onload = () => { if (current && typeof reader.result === 'string') publish(reader.result); };
  reader.onerror = () => { if (current) onFailure(); };
  reader.readAsDataURL(blob);
  return () => {
    current = false;
    reader.onload = null;
    reader.onerror = null;
    if (reader.readyState === 1) reader.abort();
  };
}

type RenderProps = ComponentProps<typeof RenderLayer>;

function NativeRenderLayer({ documentId, pageIndex, scale, dpr, style, ...props }: RenderProps) {
  const { provides } = useRenderCapability();
  const documentState = useDocumentState(documentId);
  const [imageUrl, setImageUrl] = useState<string>();
  const actualScale = scale ?? documentState?.scale ?? 1;
  const actualDpr = dpr ?? window.devicePixelRatio;
  const refreshVersion = documentState?.pageRefreshVersions[pageIndex] ?? 0;
  useEffect(() => {
    if (!provides) return;
    return subscribeNativeRaster(provides.forDocument(documentId).renderPage({
      pageIndex, options: { scaleFactor: actualScale, dpr: actualDpr },
    }), setImageUrl);
  }, [provides, documentId, pageIndex, actualScale, actualDpr, refreshVersion]);
  return imageUrl ? <img src={imageUrl} {...props} style={{ width: '100%', height: '100%', ...style }} /> : null;
}

export function HostRenderLayer({ resourceHost, ...props }: RenderProps & { resourceHost: ViewerResourcePolicy['host'] }) {
  return resourceHost === 'codex' ? <NativeRenderLayer {...props} /> : <RenderLayer {...props} />;
}
