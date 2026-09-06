import { transformRect, type PdfPageObject, type Rect, type Rotation } from "@embedpdf/models";
import type { PageLayout } from "@embedpdf/plugin-scroll";
import type { PdfRect } from "../../../../packages/core/src/pdf-writer.js";
import type { CSSProperties } from 'react';

/** Keep the text baseline oriented with the PDF while retaining its exact anchor bounds. */
export function ownedMarkStyle(
  page: PdfPageObject,
  layout: PageLayout,
  documentRotation: Rotation,
  rect: PdfRect,
): CSSProperties & { '--pdf-mark-scale': number } {
  const positioned = positionOwnedRect(page, layout, documentRotation, rect);
  const scale = layout.width / page.size.width;
  const rotation = combinePageRotation(page.rotation, documentRotation);
  return {
    '--pdf-mark-scale': scale,
    position: 'absolute',
    left: positioned.origin.x + positioned.size.width / 2,
    top: positioned.origin.y + positioned.size.height / 2,
    width: rect.width * scale,
    height: rect.height * scale,
    transform: `translate(-50%, -50%) rotate(${rotation * 90}deg)`,
  };
}

export function combinePageRotation(pageRotation: Rotation, documentRotation: Rotation): Rotation {
  return ((pageRotation + documentRotation) % 4) as Rotation;
}

/** Map crop-relative page evidence into the scaled, rotated page canvas. */
export function positionOwnedRect(
  page: PdfPageObject,
  layout: PageLayout,
  documentRotation: Rotation,
  rect: PdfRect,
): Rect {
  const scale = layout.width / page.size.width;
  const rotation = combinePageRotation(page.rotation, documentRotation);
  return transformRect(
    page.size,
    {
      origin: {
        x: rect.x,
        y: rect.y,
      },
      size: { width: rect.width, height: rect.height },
    },
    rotation,
    scale,
  );
}
