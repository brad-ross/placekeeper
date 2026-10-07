---
title: Align host raster rotation and selection paint
date: 2026-10-06
category: ui-bugs
module: Shared PDF raster and selection rendering
problem_type: ui_bug
component: frontend_stimulus
severity: high
symptoms:
  - Rotated cropped pages stretched an unrotated bitmap into the rotated page box
  - Selected text copied correctly while its visible highlight remained horizontal
  - A selection rotation fix obscured colored glyphs without changing the selection color
root_cause: logic_error
resolution_type: code_fix
tags: [pdf-rendering, rotation, crop-relative-geometry, selection, compositing, native-codex, main-and-references]
---

# Align host raster rotation and selection paint

## Problem

The live PDF could disagree with its own selection and search layers even when canonical text geometry was correct. Native-host qualification exposed a shared rendering defect: page layout, raster orientation, selection paint, and blending did not all apply the same presentation transform.

This concerns the live reader. Correct pixels here do not establish that exported PDF annotations have valid normal appearances in other readers.

## Symptoms

- A cropped page with a quarter-turn rotation had a landscape page box but a portrait bitmap stretched into it.
- Text selection and copy returned the expected text while the visible selection stayed horizontal over rotated text.
- Rotating the selection wrapper fixed geometry but introduced a separate blending group that obscured red text, including at zero rotation.

These are observed investigation outcomes, not inferred from the final implementation (session history).

## What Didn't Work

The original checks accepted decoded pixels and positive dimensions. Both remained true for the stretched raster. Browser parity was also insufficient: investigation reproduced the same rotation omission in the browser path (session history).

Correct selection text and copy output did not prove correct paint. After the rotation fix, unchanged color and correct rectangle bounds still did not prove legible glyphs. The transformed wrapper changed compositing, so the second defect required rendered-pixel evidence (session history).

Do not repair a presentation error by rewriting durable annotation anchors. Do not compensate for an isolated blend group by changing the intended selection color or opacity.

## Solution

### Render pixels in the page box's orientation

`HostRenderLayer` combines intrinsic page rotation with viewer rotation and explicitly supplies that rotation to `renderPage`. Main and References use this shared layer. The raster and the scroller therefore agree on orientation before the image fills the page box (`apps/web/src/pdf/HostRenderLayer.tsx:74`, `apps/web/src/pdf/PdfWorkspace.tsx:428`, `apps/web/src/pdf/ReferencePdfViewport.tsx:524`).

The displayed-image key includes host, document, page, and combined rotation. A previous bitmap may bridge a zoom render, but a page or rotation change hides an image with the wrong key. Scale, pixel density, and refresh version still trigger a new render (`apps/web/src/pdf/HostRenderLayer.tsx:70`).

Keep image transport separate from geometry. The Codex branch converts completed blobs to data images; the browser branch creates Blob URLs and releases them on image load or cleanup. Both subscriptions reject late completion and abort retired render tasks (`apps/web/src/pdf/HostRenderLayer.tsx:8`, `apps/web/src/pdf/HostRenderLayer.tsx:43`). These lifecycle guards establish ownership of the current image; they are not OS memory measurements.

### Rotate selection paint without changing its anchors

Owned geometry remains crop-relative. `positionOwnedRect` maps natural page rectangles through combined rotation and scale. The selection plugin's natural rectangles instead sit inside `selectionLayerStyle`: a natural-size layer centered in the rotated page box and rotated as a group (`apps/web/src/pdf/owned-overlay.ts:27`, `apps/web/src/pdf/owned-overlay.ts:55`). Both Main and References use that wrapper around `SelectionLayer` (`apps/web/src/pdf/PdfWorkspace.tsx:434`, `apps/web/src/pdf/ReferencePdfViewport.tsx:530`).

Apply `mixBlendMode: 'multiply'` to the transformed wrapper itself. Its descendants' blending does not by itself make the isolated transformed group blend with the page raster. The wrapper also has `pointerEvents: 'none'`, preserving its role as paint rather than a new interaction coordinate system (`apps/web/src/pdf/owned-overlay.ts:68`).

## Why This Works

Canonical anchors, layout bounds, rendered pixels, and compositing answer different questions. Sharing their rotation input makes them agree without giving presentation transforms authority over saved geometry. Group-level blending then preserves the selected glyphs against the page beneath that group.

The investigation required three independent checks: raster orientation, selection geometry, and final selected pixels. Passing one could conceal a failure in the next. This is why checking only DOM rectangles, selected text, or a successful image decode missed the actual defects.

## Prevention

Use an asymmetric fixture with a nonzero CropBox origin. Distinct colored markers detect mirrored or wrong-quarter-turn output that a symmetric page could conceal. Compare raster aspect ratio with displayed aspect ratio and marker positions with overlay positions.

The regression covers two image-resource policies, four intrinsic rotations, all four viewer rotations, and both Main and References. It checks selection/copy text, painted rectangles, the unchanged selection background token, and preservation of black or red glyph pixels against a baseline (`test/acceptance/host-raster-rotation.spec.ts:5`, `test/acceptance/host-raster-rotation.spec.ts:188`, `test/acceptance/host-raster-rotation.spec.ts:203`). The baseline uses the already-decoded raster rather than reloading a URL that may legitimately have been revoked (session history).

This regression mounts production components in a browser harness. It does not independently prove installed-host transport, OS clipboard behavior, physical gestures, or exported PDF appearance. Keep those evidence categories explicit when reporting qualification.

## Related Issues

- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) owns persisted appearance and crop-relative interoperability.
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) owns resource transport and host adapters.
- [Pointer-anchored zoom across custom viewer geometry](pointer-anchored-zoom-across-custom-viewer-geometry.md) explains presentation transform ownership during zoom.
- [Reject stale viewer selection snapshots](reject-stale-viewer-selection-snapshots.md) owns semantic selection authority and generation fences.
