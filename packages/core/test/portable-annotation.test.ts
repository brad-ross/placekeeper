import { describe, expect, it } from "vitest";

import {
  projectReviewItem,
  projectReviewItemProjections,
} from "../src/annotation-projection.js";
import {
  assertPortableAnnotationWritable,
  createImportedReviewState,
  createPortableAnnotationCustom,
  decodePortableAnnotationJson,
  inspectPortableAnnotation,
  inspectPortableAnnotations,
  inspectProjectedPortableAnnotations,
  inspectProjectedPortableAnnotation,
  PORTABLE_ANNOTATION_MAX_BYTES,
  serializePortableAnnotationGroup,
} from "../src/portable-annotation.js";
import {
  anchorEvidenceFromReviewItem,
  canonicalizeReviewItem,
  type ReviewItem,
} from "../src/review-model.js";
import { MAX_REVIEW_SELECTION_SEGMENTS } from "../src/review-reducer.js";

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
  author: "Placekeeper",
  rect: { origin: { x: 72, y: 92 }, size: { width: 90, height: 16 } },
  segmentRects: [
    { origin: { x: 72, y: 92 }, size: { width: 90, height: 16 } },
  ],
};

function crossPageItem(pageCount = 3): ReviewItem {
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => ({
    pageIndex,
    quote: `page ${pageIndex + 1}`,
    prefix: pageIndex === 0 ? "before " : "",
    suffix: pageIndex === pageCount - 1 ? " after" : "",
    rect: { x: 72, y: 42 + pageIndex * 10, width: 100, height: 16 },
    segmentRects: [
      { x: 72, y: 42 + pageIndex * 10, width: 100, height: 16 },
    ],
  }));
  return {
    ...item,
    payload: {
      ...item.payload,
      quote: pages.map(({ quote }) => quote).join("\n"),
      prefix: pages[0]!.prefix,
      suffix: pages.at(-1)!.suffix,
      rect: pages[0]!.rect,
      segmentRects: pages[0]!.segmentRects,
      pages,
      pageBoundaries: pages.slice(0, -1).map(({ pageIndex }) => ({
        afterPageIndex: pageIndex,
        separator: "\n",
      })),
    },
  };
}

describe("portable annotation codec", () => {
  it("regroups arbitrarily enumerated v3 children into one exact canonical item", () => {
    const crossPage = crossPageItem();
    const projected = projectReviewItemProjections(crossPage);

    expect(projected.map(({ id }) => id)).toEqual([
      `${crossPage.id}:projection:1`,
      `${crossPage.id}:projection:2`,
      `${crossPage.id}:projection:3`,
    ]);
    expect(inspectProjectedPortableAnnotations([
      projected[2]!,
      projected[0]!,
      projected[1]!,
    ])).toMatchObject({
      status: "owned",
      items: [crossPage],
      ownedIndexes: [0, 1, 2],
    });
  });

  it("keeps v2 children backward compatible while deduplicating v3 groups", () => {
    const crossPage = crossPageItem(2);
    const legacyItem = { ...item, id: "22222222-2222-4222-8222-222222222222" };
    const legacy = projectReviewItem(legacyItem);
    const projected = projectReviewItemProjections(crossPage);

    expect(inspectProjectedPortableAnnotation(legacy)).toMatchObject({ status: "owned" });

    expect(inspectProjectedPortableAnnotations([
      projected[1]!,
      legacy,
      projected[0]!,
    ])).toMatchObject({
      status: "owned",
      items: [crossPage, legacyItem],
      ownedIndexes: [0, 1, 2],
    });
  });

  it("uses page-local projection identity when a foreign annotation reuses an ID", () => {
    const projected = projectReviewItem(item);
    const foreignOnAnotherPage = {
      custom: undefined,
      visible: { ...visible, pageIndex: 1 },
    };
    expect(inspectProjectedPortableAnnotation(projected)).toMatchObject({ status: "owned" });
    const inspection = inspectPortableAnnotations([
      {
        custom: projected.custom,
        visible,
      },
      foreignOnAnotherPage,
    ]);
    expect(inspection).toMatchObject({
      status: "owned",
      items: [item],
      ownedIndexes: [0],
    });
  });

  it.each([
    ["missing child", (children: any[]) => children.slice(0, 2)],
    ["duplicate projection index", (children: any[]) => [children[0], children[1], {
      ...children[2],
      custom: {
        placekeeper: {
          ...children[2].custom.placekeeper,
          projectionIndex: 1,
        },
      },
    }]],
    ["projection/page-order disagreement", (children: any[]) => [children[0], {
      ...children[1],
      pageIndex: 0,
      custom: {
        placekeeper: {
          ...children[1].custom.placekeeper,
          projection: {
            ...children[1].custom.placekeeper.projection,
            pageIndex: 0,
          },
        },
      },
    }, children[2]]],
    ["extra child", (children: any[]) => [...children, {
      ...children[2],
      id: `${item.id}:projection:4`,
      projectionIndex: 3,
      custom: {
        placekeeper: {
          ...children[2].custom.placekeeper,
          projectionId: `${item.id}:projection:4`,
          projectionIndex: 3,
          projection: {
            ...children[2].custom.placekeeper.projection,
            id: `${item.id}:projection:4`,
          },
        },
      },
    }]],
    ["canonical payload mismatch", (children: any[]) => [children[0], {
      ...children[1],
      custom: {
        placekeeper: {
          ...children[1].custom.placekeeper,
          item: {
            ...children[1].custom.placekeeper.item,
            payload: {
              ...children[1].custom.placekeeper.item.payload,
              proposedText: "drifted",
            },
          },
        },
      },
    }, children[2]]],
    ["page evidence mismatch", (children: any[]) => [children[0], {
      ...children[1],
      custom: {
        placekeeper: {
          ...children[1].custom.placekeeper,
          projection: {
            ...children[1].custom.placekeeper.projection,
            quote: "wrong page text",
          },
        },
      },
    }, children[2]]],
    ["duplicate physical id", (children: any[]) => [children[0], {
      ...children[1],
      id: children[0].id,
      custom: {
        placekeeper: {
          ...children[1].custom.placekeeper,
          projectionId: children[0].id,
          projection: {
            ...children[1].custom.placekeeper.projection,
            id: children[0].id,
          },
        },
      },
    }, children[2]]],
  ])("fails the complete v3 group closed for %s", (_name, mutate) => {
    const projected = projectReviewItemProjections(crossPageItem());
    expect(inspectProjectedPortableAnnotations(mutate(projected)))
      .toMatchObject({ status: "invalid" });
  });

  it('serializes deterministic page-specific envelopes for one logical cross-page item', () => {
    const crossPage: ReviewItem = {
      ...item,
      payload: {
        ...item.payload,
        quote: 'unique\ncontinuation',
        pages: [
          {
            pageIndex: 0,
            quote: 'unique',
            prefix: 'a ',
            suffix: '',
            rect: { x: 72, y: 92, width: 90, height: 16 },
            segmentRects: [{ x: 72, y: 92, width: 90, height: 16 }],
          },
          {
            pageIndex: 1,
            quote: 'continuation',
            prefix: '',
            suffix: ' ends',
            rect: { x: 72, y: 42, width: 100, height: 16 },
            segmentRects: [{ x: 72, y: 42, width: 100, height: 16 }],
          },
        ],
        pageBoundaries: [{ afterPageIndex: 0, separator: '\n' }],
      },
    };

    const group = serializePortableAnnotationGroup(crossPage);
    expect(group).toHaveLength(2);
    expect(group.map(({ pageIndex, projectionIndex, projectionCount }) => ({ pageIndex, projectionIndex, projectionCount })))
      .toEqual([
        { pageIndex: 0, projectionIndex: 0, projectionCount: 2 },
        { pageIndex: 1, projectionIndex: 1, projectionCount: 2 },
      ]);
    expect(group.every(({ byteLength }) => byteLength <= PORTABLE_ANNOTATION_MAX_BYTES)).toBe(true);
    expect(group[1]?.custom.placekeeper.projection).toMatchObject({
      pageIndex: 1,
      subtype: 'strikeOut',
      contents: 'locally unique',
      rect: { y: 42 },
      segmentRects: [{ y: 42 }],
    });
    expect(group[0]?.custom.placekeeper.item).toMatchObject({
      id: crossPage.id,
      kind: 'replace',
      pageIndex: 0,
      payload: {
        quote: 'unique\ncontinuation',
        proposedText: 'locally unique',
        pageBoundaries: [{ afterPageIndex: 0, separator: '\n' }],
      },
    });
    expect(serializePortableAnnotationGroup(crossPage)).toEqual(group);

    const canonicalized = canonicalizeReviewItem(crossPage, {
      ownerViewId: 'main',
      baseGeneration: 4,
    });
    const canonicalizedGroup = serializePortableAnnotationGroup(canonicalized);
    expect(canonicalizedGroup.map(({ serialized }) => serialized))
      .toEqual(group.map(({ serialized }) => serialized));
    expect(canonicalizedGroup.map(({ byteLength }) => byteLength))
      .toEqual(group.map(({ byteLength }) => byteLength));
    expect(canonicalizedGroup[0]?.custom.placekeeper.item).not.toHaveProperty('reconciliation');
  });
  it("round-trips the full semantic item through the crop-relative v2 envelope", () => {
    const annotation = projectReviewItem(item);
    const custom = createPortableAnnotationCustom(item, annotation);
    const result = inspectPortableAnnotation(custom, visible);

    expect(result).toEqual({ status: "owned", item });
    expect(annotation.author).toBe("Placekeeper");
    expect(custom.placekeeper).toMatchObject({
      owner: "placekeeper",
      schemaVersion: 2,
      itemId: item.id,
      projection: { author: "Placekeeper" },
    });
    expect(JSON.stringify(custom)).toContain('"placekeeper"');
    expect(JSON.stringify(custom)).not.toContain("sourceRootId");
  });

  it.each([
    ["missing", undefined, "foreign"],
    ["future", { placekeeper: { schemaVersion: 3 } }, "invalid"],
    ["mismatched id", { placekeeper: { ...createPortableAnnotationCustom(item, projectReviewItem(item)).placekeeper, item: { ...item, id: "other" } } }, "invalid"],
    ["prototype key", JSON.parse('{"placekeeper":{"schemaVersion":2,"__proto__":{}}}'), "invalid"],
  ] as const)("classifies %s metadata without claiming the visible mark", (_name, custom, status) => {
    expect(inspectPortableAnnotation(custom, visible).status).toBe(status);
  });

  it("accepts only the exact Placekeeper author after validating the owned envelope", () => {
    const annotation = projectReviewItem(item, "Placekeeper");
    expect(inspectPortableAnnotation(annotation.custom, visible)).toEqual({
      status: "owned",
      item,
    });

    const unrelated = projectReviewItem(item, "Placekeeper Preview");
    expect(inspectPortableAnnotation(unrelated.custom, {
      ...visible,
      author: "Placekeeper Preview",
    })).toMatchObject({ status: "invalid", reason: "unsupported-author" });
    expect(inspectPortableAnnotation(undefined, {
      ...visible,
      author: "Placekeeper",
    })).toEqual({ status: "foreign" });
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
      placekeeper: {
        ...custom.placekeeper,
        item: { ...item, payload: { ...item.payload, rect: { x: 72, y: 92, width: -1, height: 16 } } },
      },
    }, visible)).toMatchObject({ status: "invalid", reason: "invalid-payload" });
    expect(inspectPortableAnnotation({
      placekeeper: {
        ...custom.placekeeper,
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
      author: "Placekeeper",
      rect: { origin: { x: 40, y: 48 }, size: { width: 20, height: 20 } },
    };

    expect(inspectPortableAnnotation(annotation.custom, noteVisible).status).toBe("owned");
    expect(inspectPortableAnnotation(annotation.custom, {
      ...noteVisible,
      rect: { origin: { x: 60.2, y: 48 }, size: { width: 20, height: 20 } },
    })).toMatchObject({ status: "invalid", reason: "projection-mismatch" });

    const insertion: ReviewItem = {
      ...item,
      kind: "insert",
      payload: {
        position: { x: 149, y: 89, width: 2, height: 16 },
        leftContext: "Selectable p",
        rightContext: "lacekeeper text",
        proposedText: "inserted text",
        reliable: true,
      },
    };
    const insertionAnnotation = projectReviewItem(insertion);
    const normalizedInsertion = {
      id: insertion.id,
      pageIndex: 0,
      subtype: "text",
      contents: "inserted text",
      author: "Placekeeper",
      rect: { origin: { x: 149, y: 89 }, size: { width: 20, height: 20 } },
    };
    expect(inspectPortableAnnotation(insertionAnnotation.custom, normalizedInsertion)).toEqual({
      status: "owned",
      item: insertion,
    });
    expect(inspectPortableAnnotation(insertionAnnotation.custom, {
      ...normalizedInsertion,
      rect: { origin: { x: 149, y: 89 }, size: { width: 22.2, height: 20 } },
    })).toMatchObject({ status: "invalid", reason: "projection-mismatch" });
  });

  it("round-trips a legitimate highlight with 33 text segments", () => {
    const segmentRects = Array.from({ length: 33 }, (_, index) => ({
      x: 72 + index,
      y: 92 + index * 8,
      width: 90,
      height: 8,
    }));
    const longHighlight: ReviewItem = {
      ...item,
      kind: "highlight",
      pageIndex: 25,
      payload: {
        quote: "A legitimate selection spanning many lines",
        prefix: "",
        suffix: "",
        rect: { x: 72, y: 92, width: 122, height: 264 },
        segmentRects,
        reliable: true,
      },
    };

    expect(inspectProjectedPortableAnnotation(projectReviewItem(longHighlight))).toEqual({
      status: "owned",
      item: longHighlight,
    });
  });

  it("keeps the command-level segment ceiling within the portable metadata bounds", () => {
    const maximumHighlight: ReviewItem = {
      ...item,
      kind: "highlight",
      payload: {
        quote: "A selection at the supported geometry limit",
        prefix: "",
        suffix: "",
        rect: { x: 72, y: 92, width: 122, height: 1_024 },
        segmentRects: Array.from({ length: MAX_REVIEW_SELECTION_SEGMENTS }, (_, index) => ({
          x: 72,
          y: 92 + index * 8,
          width: 90,
          height: 8,
        })),
        reliable: true,
      },
    };

    const maximumAnnotation = projectReviewItem(maximumHighlight);
    expect(inspectProjectedPortableAnnotation(maximumAnnotation))
      .toMatchObject({ status: "owned" });
    expect(() => assertPortableAnnotationWritable(maximumAnnotation)).not.toThrow();

    const overLimit: ReviewItem = {
      ...maximumHighlight,
      payload: {
        ...maximumHighlight.payload,
        segmentRects: [
          ...(maximumHighlight.payload.segmentRects as readonly Record<string, number>[]),
          { x: 72, y: 92 + MAX_REVIEW_SELECTION_SEGMENTS * 8, width: 90, height: 8 },
        ],
      },
    };
    const overLimitAnnotation = projectReviewItem(overLimit);
    expect(inspectProjectedPortableAnnotation(overLimitAnnotation))
      .toMatchObject({ status: "invalid", reason: "unsafe-shape" });
    expect(() => assertPortableAnnotationWritable(overLimitAnnotation))
      .toThrow(/too complex to preserve as editable metadata/u);
  });

  it("bounds raw JSON before parsing and does not include rejected input in errors", () => {
    const secret = "PRIVATE-SECRET";
    const oversized = JSON.stringify({
      placekeeper: { value: secret.repeat(PORTABLE_ANNOTATION_MAX_BYTES) },
    });
    const result = decodePortableAnnotationJson(oversized);

    expect(result).toMatchObject({ status: "invalid", reason: "too-large" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("retains bounded traversal for hostile nested containers", () => {
    const hostile = {
      placekeeper: Array.from(
        { length: 128 },
        () => Array.from({ length: 128 }, () => null),
      ),
    };

    expect(inspectPortableAnnotation(hostile, visible)).toEqual({
      status: "invalid",
      reason: "unsafe-shape",
    });
  });

  it("creates a fresh imported review state with empty undo history", () => {
    const unresolved: ReviewItem = {
      ...item,
      reconciliation: {
        schemaVersion: 1,
        ownerViewId: "panel-a",
        baseGeneration: 2,
        revision: 3,
        anchor: anchorEvidenceFromReviewItem(item),
        disposition: { kind: "ambiguous", reason: "multiple-quote-matches" },
        previousAnchors: [],
      },
    };
    const state = createImportedReviewState({
      sessionId: "session",
      source: { fileId: "file", digest: "a".repeat(64), byteLength: 100 },
      items: [unresolved],
      workflowMode: "generated-output",
      documentGeneration: 3,
    });

    expect(state.items).toEqual([unresolved]);
    expect(inspectProjectedPortableAnnotation(projectReviewItem(unresolved))).toMatchObject({
      status: "owned",
      item: { id: unresolved.id, reconciliation: { disposition: { kind: "ambiguous" } } },
    });
    expect(state.revision).toBe(0);
    expect(state.history).toEqual([]);
    expect(state.historyCursor).toBe(0);
    expect(state.schemaVersion).toBe(2);
  });
});
