import { transformRect, type PdfPageObject, type Rect, type Rotation } from "@embedpdf/models";
import type { PageLayout } from "@embedpdf/plugin-scroll";
import type { PdfRect } from "../../../../packages/core/src/pdf-writer.js";

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
