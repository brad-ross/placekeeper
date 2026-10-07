import { useDocumentState } from '@embedpdf/core/react';
import { PdfErrorCode, ignore, type PdfErrorReason, type Task } from '@embedpdf/models';
import { RenderLayer, useRenderCapability } from '@embedpdf/plugin-render/react';
import { useEffect, useState, type ComponentProps } from 'react';
import type { ViewerResourcePolicy } from './embedpdf-viewer.js';
import { combinePageRotation } from './owned-overlay.js';

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

export function subscribeBrowserRaster(
  task: Pick<Task<Blob, PdfErrorReason>, 'wait' | 'abort'>,
  publish: (url: string, release: () => void) => void,
  urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL,
): () => void {
  let current = true;
  let imageUrl: string | undefined;
  const release = () => {
    if (imageUrl === undefined) return;
    urls.revokeObjectURL(imageUrl);
    imageUrl = undefined;
  };
  task.wait(blob => {
    if (!current) return;
    imageUrl = urls.createObjectURL(blob);
    publish(imageUrl, release);
  }, ignore);
  return () => {
    current = false;
    release();
    task.abort({ code: PdfErrorCode.Cancelled, message: 'canceled render task' });
  };
}

export function HostRenderLayer({ resourceHost, documentId, pageIndex, scale, dpr, style, onLoad, ...props }: RenderProps & { resourceHost: ViewerResourcePolicy['host'] }) {
  const { provides } = useRenderCapability();
  const documentState = useDocumentState(documentId);
  const [image, setImage] = useState<{ url: string; key: string; release?: () => void }>();
  const actualScale = scale ?? documentState?.scale ?? 1;
  const actualDpr = dpr ?? window.devicePixelRatio;
  const refreshVersion = documentState?.pageRefreshVersions[pageIndex] ?? 0;
  // The scroller already lays out the rotated page; render its pixels in that
  // same orientation instead of stretching an unrotated bitmap into the box.
  const rotation = combinePageRotation(documentState?.document?.pages[pageIndex]?.rotation ?? 0, documentState?.rotation ?? 0);
  // A previous bitmap can cover a zoom render, but cannot cover a page turn or
  // rotation: its orientation would disagree with the overlays and page box.
  const key = `${resourceHost}:${documentId}:${pageIndex}:${rotation}`;
  useEffect(() => {
    if (!provides) return;
    const task = provides.forDocument(documentId).renderPage({
      pageIndex, options: { scaleFactor: actualScale, dpr: actualDpr, rotation },
    });
    return resourceHost === 'codex'
      ? subscribeNativeRaster(task, url => setImage({ url, key }))
      : subscribeBrowserRaster(task, (url, release) => setImage({ url, key, release }));
  }, [provides, documentId, pageIndex, actualScale, actualDpr, rotation, refreshVersion, resourceHost, key]);
  return image?.key === key ? <img src={image.url} {...props} onLoad={event => { image.release?.(); onLoad?.(event); }} style={{ width: '100%', height: '100%', ...style }} /> : null;
}
