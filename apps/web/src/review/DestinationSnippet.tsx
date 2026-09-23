import { useEffect, useState, type CSSProperties } from 'react';

import type { PdfDestinationDescription } from '../pdf/destination-description.js';
import {
  createDestinationSnippetSession,
  destinationSnippetOverlay,
  type DestinationSnippetImageState,
  type DestinationSnippetRenderer,
} from '../pdf/destination-snippet.js';
import {
  DESTINATION_BAND_EDGE_TOKEN,
  DESTINATION_BAND_TOKEN,
} from '../pdf/ReferencePdfViewport.js';

export interface DestinationSnippetFrameProps {
  readonly image: DestinationSnippetImageState;
  readonly description: PdfDestinationDescription | null;
  /** The destination description is still resolving. */
  readonly resolving: boolean;
  /** The bare destination page numeral, for example "14". */
  readonly pageNumeral: string;
}

/**
 * Fixed-height, non-focusable preview of the destination (R3, R6; KTD11).
 * The extent highlight is a DOM overlay in the Destination Band tokens, never
 * burned into the bitmap. The frame's size never depends on the image.
 */
export function DestinationSnippetFrame({
  image,
  description,
  resolving,
  pageNumeral,
}: DestinationSnippetFrameProps) {
  const status = image.status === 'ready'
    ? 'ready'
    : resolving || image.status === 'loading' ? 'loading' : 'unavailable';
  const region = image.status === 'ready' ? image.region : null;
  const overlay = region === null || description === null
    ? []
    : destinationSnippetOverlay(description, region);
  return (
    <div
      className="destination-snippet"
      data-destination-snippet=""
      data-snippet-status={status}
      aria-hidden="true"
    >
      {image.status === 'ready' && region !== null ? (
        <div
          className="destination-snippet__canvas"
          style={{ aspectRatio: `${region.size.width} / ${region.size.height}` }}
        >
          <img className="destination-snippet__image" src={image.url} alt="" draggable={false} />
          {overlay.map((box, index) => (
            <span
              key={index}
              className="destination-snippet__extent"
              data-destination-snippet-extent=""
              style={{
                left: `${box.left}%`,
                top: `${box.top}%`,
                width: `${box.width}%`,
                height: `${box.height}%`,
                background: `var(${DESTINATION_BAND_TOKEN})`,
                ...(index === 0 ? { boxShadow: `inset 2px 0 0 var(${DESTINATION_BAND_EDGE_TOKEN})` } : {}),
              } satisfies CSSProperties}
            />
          ))}
        </div>
      ) : null}
      <span className="destination-snippet__page">{pageNumeral}</span>
    </div>
  );
}

function useDestinationSnippetImage(
  description: PdfDestinationDescription | null,
  render: DestinationSnippetRenderer | undefined,
): DestinationSnippetImageState {
  const [image, setImage] = useState<DestinationSnippetImageState>({ status: 'idle' });
  useEffect(() => {
    if (description === null || render === undefined) {
      setImage({ status: 'idle' });
      return undefined;
    }
    const session = createDestinationSnippetSession({ render, onChange: setImage });
    session.load(description);
    // Dismissal, a new request, or a new description aborts the render and
    // revokes the object URL (KTD3).
    return () => session.dispose();
  }, [description, render]);
  return image;
}

export interface DestinationSnippetProps {
  readonly description: PdfDestinationDescription | null;
  readonly resolving: boolean;
  readonly pageNumeral: string;
  readonly render?: DestinationSnippetRenderer;
}

export function DestinationSnippet({ description, resolving, pageNumeral, render }: DestinationSnippetProps) {
  const image = useDestinationSnippetImage(description, render);
  return (
    <DestinationSnippetFrame
      image={image}
      description={description}
      // The render starts in an effect; treat the first paint as loading.
      resolving={resolving || (image.status === 'idle' && description !== null && render !== undefined)}
      pageNumeral={description?.pageNumeral ?? pageNumeral}
    />
  );
}
