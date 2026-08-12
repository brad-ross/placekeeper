import { describe, expect, it } from "vitest";

import { projectReviewItem } from "../src/annotation-projection.js";
import {
  createImportedReviewState,
  createPortableAnnotationCustom,
  decodePortableAnnotationJson,
  inspectPortableAnnotation,
  PORTABLE_ANNOTATION_MAX_BYTES,
} from "../src/portable-annotation.js";
import type { ReviewItem } from "../src/review-model.js";

const item: ReviewItem = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "replace",
  pageIndex: 0,
  createdAt: "2026-08-11T12:00:00.000Z",
  updatedAt: "2026-08-11T12:01:00.000Z",
  payload: {
    quote: "unique",
    prefix: "a ",
    suffix: " equilibrium",
    rect: { x: 72, y: 92, width: 90, height: 16 },
    segmentRects: [{ x: 72, y: 92, width: 90, height: 16 }],
    reliable: true,
    proposedText: "locally unique",
  },
};

const visible = {
  id: item.id,
  pageIndex: 0,
  subtype: "strikeOut",
  contents: "locally unique",
  author: "PDF Proofreader",
  rect: { origin: { x: 72, y: 92 }, size: { width: 90, height: 16 } },
  segmentRects: [
    { origin: { x: 72, y: 92 }, size: { width: 90, height: 16 } },
  ],
};

describe("portable annotation codec", () => {
  it("round-trips the full semantic item through the namespaced v1 envelope", () => {
    const custom = createPortableAnnotationCustom(item, projectReviewItem(item));
    const result = inspectPortableAnnotation(custom, visible);

    expect(result).toEqual({ status: "owned", item });
    expect(JSON.stringify(custom)).toContain('"pdfMarkup"');
    expect(JSON.stringify(custom)).not.toContain("sourceRootId");
  });

  it.each([
    ["missing", undefined, "foreign"],
    ["future", { pdfMarkup: { schemaVersion: 2 } }, "invalid"],
    ["mismatched id", { pdfMarkup: { ...createPortableAnnotationCustom(item, projectReviewItem(item)).pdfMarkup, item: { ...item, id: "other" } } }, "invalid"],
    ["prototype key", JSON.parse('{"pdfMarkup":{"schemaVersion":1,"__proto__":{}}}'), "invalid"],
  ] as const)("classifies %s metadata without claiming the visible mark", (_name, custom, status) => {
    expect(inspectPortableAnnotation(custom, visible).status).toBe(status);
  });

  it("rejects mismatched visible projection and duplicate visible IDs", () => {
    const custom = createPortableAnnotationCustom(item, projectReviewItem(item));
    expect(
      inspectPortableAnnotation(custom, { ...visible, contents: "changed elsewhere" }),
    ).toMatchObject({ status: "invalid" });
    expect(
      inspectPortableAnnotation(custom, visible, { visibleIdCount: 2 }),
    ).toMatchObject({ status: "invalid" });
  });

  it("rejects kind-invalid semantic payloads and semantic projection drift", () => {
    const custom = createPortableAnnotationCustom(item, projectReviewItem(item));
    expect(inspectPortableAnnotation({
      pdfMarkup: {
        ...custom.pdfMarkup,
        item: { ...item, payload: { ...item.payload, rect: { x: 72, y: 92, width: -1, height: 16 } } },
      },
    }, visible)).toMatchObject({ status: "invalid", reason: "invalid-payload" });
    expect(inspectPortableAnnotation({
      pdfMarkup: {
        ...custom.pdfMarkup,
        item: { ...item, payload: { ...item.payload, proposedText: "different semantics" } },
      },
    }, visible)).toMatchObject({ status: "invalid", reason: "projection-mismatch" });
  });

  it("accepts bounded PDFium text-note normalization but rejects larger geometry drift", () => {
    const note: ReviewItem = {
      ...item,
      kind: "pageNote",
      payload: {
        position: { x: 40, y: 50, width: 18, height: 18 },
        comment: "Check this page.",
      },
    };
    const annotation = projectReviewItem(note);
    const noteVisible = {
      id: note.id,
      pageIndex: 0,
      subtype: "text",
      contents: "Check this page.",
      author: "PDF Proofreader",
      rect: { origin: { x: 40, y: 48 }, size: { width: 20, height: 20 } },
    };

    expect(inspectPortableAnnotation(annotation.custom, noteVisible).status).toBe("owned");
    expect(inspectPortableAnnotation(annotation.custom, {
      ...noteVisible,
      rect: { origin: { x: 60.2, y: 48 }, size: { width: 20, height: 20 } },
    })).toMatchObject({ status: "invalid", reason: "projection-mismatch" });
  });

  it("bounds raw JSON before parsing and does not include rejected input in errors", () => {
    const secret = "PRIVATE-SECRET";
    const oversized = JSON.stringify({
      pdfMarkup: { value: secret.repeat(PORTABLE_ANNOTATION_MAX_BYTES) },
    });
    const result = decodePortableAnnotationJson(oversized);

    expect(result).toMatchObject({ status: "invalid", reason: "too-large" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("creates a fresh imported review state with empty undo history", () => {
    const state = createImportedReviewState({
      sessionId: "session",
      source: { fileId: "file", digest: "a".repeat(64), byteLength: 100 },
      items: [item],
    });

    expect(state.items).toEqual([item]);
    expect(state.revision).toBe(0);
    expect(state.history).toEqual([]);
    expect(state.historyCursor).toBe(0);
  });
});
