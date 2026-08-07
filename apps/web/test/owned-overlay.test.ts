import { Rotation } from "@embedpdf/models";
import { describe, expect, it } from "vitest";

import { positionOwnedRect } from "../src/pdf/owned-overlay.js";

describe("owned annotation overlay geometry", () => {
  it("subtracts the crop origin and applies 90-degree rotation plus zoom exactly once", () => {
    const positioned = positionOwnedRect(
      {
        index: 0,
        objectNumber: 1,
        size: { width: 600, height: 800 },
        rotation: Rotation.Degree90,
        boxes: {
          media: { left: 0, top: 0, right: 700, bottom: 1000 },
          crop: { left: 100, top: 200, right: 700, bottom: 1000 },
        },
      },
      {
        pageIndex: 0, pageNumber: 1, x: 0, y: 0,
        width: 1200, height: 1600, rotatedWidth: 1600, rotatedHeight: 1200,
        elevated: false,
      },
      Rotation.Degree0,
      { x: 110, y: 220, width: 30, height: 40 },
    );
    expect(positioned).toEqual({
      origin: { x: 1480, y: 20 },
      size: { width: 80, height: 60 },
    });
  });

  it("combines page and document rotation", () => {
    const positioned = positionOwnedRect(
      { index: 0, objectNumber: 1, size: { width: 100, height: 200 }, rotation: Rotation.Degree90 },
      { pageIndex: 0, pageNumber: 1, x: 0, y: 0, width: 100, height: 200, rotatedWidth: 100, rotatedHeight: 200, elevated: false },
      Rotation.Degree180,
      { x: 10, y: 20, width: 30, height: 40 },
    );
    expect(positioned).toEqual({ origin: { x: 20, y: 60 }, size: { width: 40, height: 30 } });
  });
});
