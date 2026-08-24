import { useLayoutEffect, useRef, useState } from 'react';

import type { AnnotationReaderRecord } from './annotation-reader.js';

export interface AnnotationExcerptGeometry {
  readonly clientHeight: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
}

const OVERFLOW_EPSILON_PX = 1;

export function annotationExcerptOverflows(geometry: AnnotationExcerptGeometry): boolean {
  return geometry.scrollHeight - geometry.clientHeight > OVERFLOW_EPSILON_PX
    || geometry.scrollWidth - geometry.clientWidth > OVERFLOW_EPSILON_PX;
}

function useAnnotationExcerptOverflow(
  content: string,
  enabled: boolean,
  onOverflowChange?: (overflowing: boolean) => void,
) {
  const excerptRef = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const onOverflowChangeRef = useRef(onOverflowChange);
  onOverflowChangeRef.current = onOverflowChange;

  useLayoutEffect(() => {
    const excerpt = excerptRef.current;
    if (!enabled || excerpt === null) {
      setOverflowing(false);
      onOverflowChangeRef.current?.(false);
      return;
    }

    let disposed = false;
    let animationFrame = 0;
    const measure = () => {
      animationFrame = 0;
      if (disposed) return;
      const nextOverflowing = annotationExcerptOverflows(excerpt);
      setOverflowing(nextOverflowing);
      onOverflowChangeRef.current?.(nextOverflowing);
    };
    const scheduleMeasure = () => {
      if (disposed) return;
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(excerpt);
    if (excerpt.parentElement !== null) resizeObserver?.observe(excerpt.parentElement);
    window.addEventListener('resize', scheduleMeasure);
    document.fonts?.addEventListener('loadingdone', scheduleMeasure);
    void document.fonts?.ready.then(scheduleMeasure);
    measure();

    return () => {
      disposed = true;
      if (animationFrame !== 0) cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      document.fonts?.removeEventListener('loadingdone', scheduleMeasure);
    };
  }, [content, enabled]);

  return { excerptRef, overflowing };
}

export interface AnnotationExcerptProps {
  readonly content: string;
  readonly readerRecord: AnnotationReaderRecord | null;
  readonly onReadFull?: (record: AnnotationReaderRecord, trigger: HTMLButtonElement) => void;
  readonly onOverflowChange?: (record: AnnotationReaderRecord, overflowing: boolean) => void;
}

export function AnnotationExcerpt({
  content,
  readerRecord,
  onReadFull,
  onOverflowChange,
}: AnnotationExcerptProps) {
  const enabled = readerRecord !== null && onReadFull !== undefined;
  const { excerptRef, overflowing } = useAnnotationExcerptOverflow(
    content,
    enabled,
    readerRecord === null || onOverflowChange === undefined
      ? undefined
      : (nextOverflowing) => onOverflowChange(readerRecord, nextOverflowing),
  );

  return (
    <>
      <span
        ref={excerptRef}
        className="annotation-item__excerpt"
        data-full-annotation-eligible={enabled ? 'true' : 'false'}
      >
        {content}
      </span>
      {enabled ? (
        <button
          type="button"
          className="annotation-item__more"
          data-read-full-annotation="true"
          aria-label={`Read full ${readerRecord.typeLabel} annotation on page ${readerRecord.pageNumber}`}
          title="Read full annotation"
          hidden={!overflowing}
          onClick={(event) => {
            event.stopPropagation();
            onReadFull(readerRecord, event.currentTarget);
          }}
        >
          More ›
        </button>
      ) : null}
    </>
  );
}
