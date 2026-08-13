import { describe, expect, it } from "vitest";

import {
  createAtomicLiveContextObservation,
  createExecutionBaseline,
  createPdfEvidenceCatalog,
  createReconciliationOutcome,
  createReviewSnapshot,
  createUnavailableLiveContextObservation,
  diffReviewSnapshots,
  reviewSemanticDigest,
  type ExistingPdfAnnotation,
} from "../src/live-context.js";
import { createCompleteDisposition } from "../src/disposition.js";
import type { ReviewItem } from "../src/review-model.js";

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

const rect = (x: number, y: number) => ({ x, y, width: 80, height: 14 });

function replaceItem(suffix: number, pageIndex: number, y: number, proposedText: string): ReviewItem {
  const geometry = rect(72, y);
  return {
    id: id(suffix),
    kind: "replace",
    pageIndex,
    createdAt: `2026-08-12T12:00:${String(suffix).padStart(2, "0")}.000Z`,
    updatedAt: `2026-08-12T12:00:${String(suffix).padStart(2, "0")}.000Z`,
    payload: {
      quote: `claim ${suffix}`,
      prefix: "before ",
      suffix: " after",
      rect: geometry,
      segmentRects: [geometry],
      reliable: true,
      proposedText,
    },
  };
}

const source = { fileId: id(90), digest: "a".repeat(64), byteLength: 400 };

function snapshot(
  cursor: string,
  revision: number,
  items: readonly ReviewItem[],
) {
  return createReviewSnapshot({
    cursor,
    revision,
    items,
    sourceHints: new Map([
      [id(1), { path: "paper.tex", line: 12, confidence: "high", provenance: "synctex" }],
    ]),
  });
}

describe("live PDF context contracts", () => {
  it("orders records deterministically and hashes canonical review semantics", () => {
    const first = replaceItem(1, 1, 100, "first replacement");
    const second = replaceItem(2, 0, 50, "second replacement");
    const reordered = [first, second];
    const timestampOnlyChange = [
      { ...second, updatedAt: "2026-08-12T15:00:00.000Z" },
      { ...first, updatedAt: "2026-08-12T15:00:01.000Z" },
    ];

    expect(snapshot("cursor-1", 2, reordered).items.map(({ id }) => id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(reviewSemanticDigest(reordered)).toBe(reviewSemanticDigest(timestampOnlyChange));
    expect(reviewSemanticDigest(reordered)).not.toBe(
      reviewSemanticDigest([{ ...first, payload: { ...first.payload, proposedText: "different" } }, second]),
    );
  });

  it("represents initial, unchanged, and add/edit/remove observations without losing records", () => {
    const first = replaceItem(1, 0, 50, "first replacement");
    const removed = replaceItem(2, 0, 100, "remove me");
    const initial = snapshot("cursor-1", 2, [removed, first]);

    expect(diffReviewSnapshots({ current: initial })).toEqual({
      mode: "full",
      reason: "initial",
      cursor: "cursor-1",
      revision: 2,
      semanticDigest: initial.semanticDigest,
      itemCount: 2,
      items: initial.items,
    });
    expect(diffReviewSnapshots({ previous: initial, current: initial, cursorStatus: "known" })).toEqual({
      mode: "unchanged",
      baseCursor: "cursor-1",
      cursor: "cursor-1",
      revision: 2,
      semanticDigest: initial.semanticDigest,
      itemCount: 2,
    });

    const edited = { ...first, payload: { ...first.payload, proposedText: "edited replacement" } };
    const added = replaceItem(3, 1, 30, "new item");
    const current = snapshot("cursor-2", 5, [added, edited]);
    const delta = diffReviewSnapshots({ previous: initial, current, cursorStatus: "known" });

    expect(delta).toMatchObject({
      mode: "delta",
      baseCursor: "cursor-1",
      cursor: "cursor-2",
      revision: 5,
      semanticDigest: current.semanticDigest,
      itemCount: 2,
      removed: [removed.id],
    });
    if (delta.mode !== "delta") throw new Error("Expected a delta");
    expect(delta.added.map(({ id }) => id)).toEqual([added.id]);
    expect(delta.edited.map(({ id }) => id)).toEqual([edited.id]);
  });

  it("falls back to a complete snapshot when the caller cursor is unknown", () => {
    const previous = snapshot("cursor-old", 1, [replaceItem(1, 0, 10, "old")]);
    const current = snapshot("cursor-current", 2, [replaceItem(2, 1, 10, "new")]);

    expect(diffReviewSnapshots({ previous, current, cursorStatus: "unknown" })).toEqual({
      mode: "full",
      reason: "unknown-cursor",
      cursor: "cursor-current",
      revision: 2,
      semanticDigest: current.semanticDigest,
      itemCount: 1,
      items: current.items,
    });
  });

  it("keeps canonical Review Items separate from read-only existing PDF annotations", () => {
    const review = snapshot("cursor-1", 1, [replaceItem(1, 0, 10, "replacement")]);
    const existing: ExistingPdfAnnotation = {
      id: id(1),
      origin: "source-pdf",
      readOnly: true,
      pageIndex: 0,
      subtype: "highlight",
      contents: "foreign highlight",
      author: "Reviewer",
      rect: rect(10, 20),
      metadata: { subject: "External review" },
    };
    const evidence = createPdfEvidenceCatalog({
      handle: {
        schemaVersion: 1,
        value: "evidence_handle_1234567890",
        documentGeneration: 3,
        observationDigest: review.semanticDigest,
        expiresAt: "2026-08-12T12:05:00.000Z",
        maxBytes: 1_000_000,
      },
      descriptors: [{ id: "raw-annotations", kind: "raw-annotations", mediaType: "application/json" }],
    });
    const observation = createAtomicLiveContextObservation({
      observedAt: "2026-08-12T12:01:00.000Z",
      identity: {
        placekeeperSessionId: "placekeeper-session",
        documentGeneration: 3,
        source,
        reviewRevision: 1,
        stateDigest: review.semanticDigest,
      },
      saveStatus: {
        destination: { phase: "active", generation: 1, kind: "copy" },
        sync: { phase: "not-saved", desiredRevision: 1, savedRevision: 0, failure: "write-failed" },
      },
      reviewItems: diffReviewSnapshots({ current: review }),
      existingPdfAnnotations: { items: [existing], warnings: [] },
      evidence,
    });

    expect(observation.reviewItems.mode).toBe("full");
    if (observation.reviewItems.mode !== "full") throw new Error("Expected full Review Items");
    expect(observation.reviewItems.items.map(({ id }) => id)).toEqual([id(1)]);
    expect(observation.existingPdfAnnotations.items).toEqual([existing]);
    expect(observation.existingPdfAnnotations.semanticDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(observation.existingPdfAnnotations.items[0]).toMatchObject({ readOnly: true, origin: "source-pdf" });
    expect(JSON.parse(JSON.stringify(observation))).toEqual(observation);
    expect(JSON.stringify(observation)).not.toContain("/tmp/reviewed.pdf");
  });

  it("represents refresh failure without claiming cached state is current", () => {
    const last = snapshot("cursor-1", 1, [replaceItem(1, 0, 10, "replacement")]);
    const unavailable = createUnavailableLiveContextObservation({
      checkedAt: "2026-08-12T12:02:00.000Z",
      reason: "unavailable",
      lastVerified: {
        placekeeperSessionId: "placekeeper-session",
        documentGeneration: 1,
        source,
        reviewRevision: last.revision,
        stateDigest: last.semanticDigest,
      },
    });

    expect(unavailable).toMatchObject({ status: "unavailable", reason: "unavailable" });
    expect(unavailable).not.toHaveProperty("reviewItems");
  });

  it("rejects malformed and duplicate PDF evidence descriptors", () => {
    const handle = {
      schemaVersion: 1 as const,
      value: "evidence_handle_1234567890",
      documentGeneration: 1,
      observationDigest: "c".repeat(64),
      expiresAt: "2026-08-12T12:05:00.000Z",
      maxBytes: 4096,
    };

    expect(() => createPdfEvidenceCatalog({
      handle,
      descriptors: [
        { id: "page-1-text", kind: "page-text", mediaType: "text/plain", pages: { start: 0, end: 0 } },
        { id: "page-1-text", kind: "page-layout", mediaType: "application/json", pages: { start: 0, end: 0 } },
      ],
    })).toThrow(/unique/i);
    expect(() => createPdfEvidenceCatalog({
      handle,
      descriptors: [
        { id: "one", kind: "page-text", mediaType: "text/plain", pages: { start: 0, end: 0 } },
        { id: "two", kind: "page-text", mediaType: "text/plain", pages: { start: 0, end: 0 } },
      ],
    })).toThrow(/duplicate/i);
    expect(() => createPdfEvidenceCatalog({
      handle,
      descriptors: [
        { id: "bad-range", kind: "page-render", mediaType: "image/png", pages: { start: 2, end: 1 } },
      ],
    })).toThrow(/page range/i);
    expect(() => createPdfEvidenceCatalog({
      handle: { ...handle, value: "short" },
      descriptors: [],
    })).toThrow(/handle/i);
  });

  it("enforces manual precedence in reconciliation outcomes", () => {
    expect(createReconciliationOutcome({
      baselineItemId: id(1),
      classification: "conflict",
      action: "skip",
      authority: "manual",
      explanation: "The source changed manually at the same target.",
    })).toMatchObject({ classification: "conflict", authority: "manual" });

    expect(() => createReconciliationOutcome({
      baselineItemId: id(1),
      classification: "conflict",
      action: "apply",
      authority: "codex",
      explanation: "Overwrite the manual edit.",
    })).toThrow(/manual/i);
  });

  it("requires exactly one terminal disposition for every baseline item", () => {
    const captured = snapshot("baseline-cursor", 2, [
      replaceItem(2, 1, 20, "second"),
      replaceItem(1, 0, 10, "first"),
    ]);
    const baseline = createExecutionBaseline({
      executionId: "execution-1",
      capturedAt: "2026-08-12T12:00:00.000Z",
      identity: {
        placekeeperSessionId: "placekeeper-session",
        documentGeneration: 2,
        source,
        reviewRevision: captured.revision,
        stateDigest: captured.semanticDigest,
      },
      items: captured.items,
      sourceFingerprints: [
        { path: "paper.tex", sha256: "d".repeat(64), byteLength: 100 },
      ],
    });
    const later = replaceItem(3, 2, 30, "later");
    const complete = createCompleteDisposition({
      baseline,
      completedAt: "2026-08-12T12:10:00.000Z",
      items: [
        { itemId: id(1), status: "applied", explanation: "Changed source.", changedPaths: ["paper.tex"] },
        { itemId: id(2), status: "already-satisfied", explanation: "The manual edit was equivalent." },
      ],
      laterItems: [{ item: later, status: "preserved-unprocessed", explanation: "Added after baseline." }],
    });

    expect(complete.items.map(({ itemId }) => itemId)).toEqual([id(1), id(2)]);
    expect(complete.laterItems.map(({ item }) => item.id)).toEqual([later.id]);
    expect(() => createCompleteDisposition({
      baseline,
      completedAt: "2026-08-12T12:10:00.000Z",
      items: [{ itemId: id(1), status: "applied", explanation: "Only one item." }],
      laterItems: [],
    })).toThrow(/every baseline item/i);
    expect(() => createCompleteDisposition({
      baseline,
      completedAt: "2026-08-12T12:10:00.000Z",
      items: [
        { itemId: id(1), status: "applied", explanation: "Duplicate one." },
        { itemId: id(1), status: "already-satisfied", explanation: "Duplicate two." },
      ],
      laterItems: [],
    })).toThrow(/exactly once/i);
  });
});
