import { transformRect, type PdfPageObject, type Rect, type Rotation } from "@embedpdf/models";
import type { PageLayout } from "@embedpdf/plugin-scroll";
import type { PdfRect } from "../../../../packages/core/src/pdf-writer.js";

/** Map canonical PDF user-space evidence into the scaled, rotated crop-relative page canvas. */
export function positionOwnedRect(
  page: PdfPageObject,
  layout: PageLayout,
  documentRotation: Rotation,
  rect: PdfRect,
): Rect {
  const crop = page.boxes?.crop;
  const scale = layout.width / page.size.width;
  const rotation = ((page.rotation + documentRotation) % 4) as Rotation;
  return transformRect(
    page.size,
    {
      origin: {
        x: rect.x - (crop?.left ?? 0),
        y: rect.y - (crop?.top ?? 0),
      },
      size: { width: rect.width, height: rect.height },
    },
    rotation,
    scale,
  );
}
