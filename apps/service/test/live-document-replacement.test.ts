import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionBroker as RawSessionBroker } from "../src/sessions/session-broker.js";
import type { SessionBrokerOptions } from "../src/sessions/session-broker.js";
import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import { reviewSemanticDigest } from "../../../packages/core/src/live-context.js";
import {
  anchorEvidenceFromReviewItem,
  createReviewState,
  reviewSelectionPayload,
} from "../../../packages/core/src/review-model.js";
import {
  assertReviewItem,
  reduceReview,
} from "../../../packages/core/src/review-reducer.js";
import { projectReviewItemProjections } from "../../../packages/core/src/annotation-projection.js";
import { DraftSnapshotStore } from "../src/recovery/draft-snapshot.js";
import { PdfEvidenceService } from "../src/context/pdf-evidence-service.js";
import {
  reconcilePdfAnchor,
  reconcilePdfAnchorState,
} from "../src/reconciliation/pdf-anchor-reconciler.js";
import { SessionControlRegistry } from "../src/sessions/control-socket.js";
import { prepareReplacementReview } from "../src/sessions/document-replacement-preparation.js";

const temporaryDirectories: string[] = [];
const activeBrokers = new Set<RawSessionBroker>();
class SessionBroker extends RawSessionBroker {
  constructor(options: ConstructorParameters<typeof RawSessionBroker>[0]) {
    super(options);
    activeBrokers.add(this);
  }
}
const ITEM_IDS = {
  stable: "00000000-0000-4000-8000-000000000001",
  ambiguous: "00000000-0000-4000-8000-000000000002",
  missing: "00000000-0000-4000-8000-000000000003",
  protected: "00000000-0000-4000-8000-000000000004",
  racing: "00000000-0000-4000-8000-000000000005",
  retained: "00000000-0000-4000-8000-000000000006",
} as const;

afterEach(async () => {
  await Promise.allSettled([...activeBrokers].map((broker) => broker.quiesceForShutdown()));
  activeBrokers.clear();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(
  options: Partial<SessionBrokerOptions> = {},
  workflowMode: "generated-output" | "standard" = "generated-output",
) {
  const directory = await mkdtemp(join(tmpdir(), "placekeeper-live-replacement-"));
  temporaryDirectories.push(directory);
  const pdfPath = join(directory, "paper.pdf");
  const pdf = async (text: string) => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage([320, 240]).drawText(text, { x: 24, y: 180, font, size: 12 });
    return Buffer.from(await document.save({ useObjectStreams: false }));
  };
  const original = await pdf("Original generated output");
  const successor = await pdf("Validated successor output");
  await writeFile(pdfPath, original);
  const broker = new SessionBroker({ recoveryRoot: join(directory, "recovery"), ...options });
  const opened = await broker.openReview({
    pdfPath,
    surface: "vscode",
    workflowMode,
  });
  if (opened.kind !== "opened") throw new Error("Expected a new generated-output review");
  return { broker, directory, pdfPath, original, successor, launch: opened.launch };
}

function selectionItem(id: string, quote: string, prefix = "", suffix = ""): ReviewItem {
  return {
    id,
    kind: "highlight",
    pageIndex: 0,
    createdAt: "2026-08-27T12:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
    payload: {
      quote,
      prefix,
      suffix,
      reliable: true,
      rect: { x: 10, y: 20, width: 30, height: 8 },
      segmentRects: [{ x: 10, y: 20, width: 30, height: 8 }],
      comment: "",
    },
  };
}

describe("atomic live document replacement", () => {
  it("adopts verified successor native geometry while preserving authored comments and tombstones", () => {
    const native = (id: string, pageIndex: number, x: number, comment: string): ReviewItem => ({
      id,
      kind: "pdfAnnotation",
      pageIndex,
      createdAt: "2026-09-15T12:00:00.000Z",
      updatedAt: "2026-09-15T12:05:00.000Z",
      payload: {
        position: { x, y: 20, width: 18, height: 18 },
        comment,
        author: "External reviewer",
        subtype: "text",
        identityProvenance: "verified",
      },
    });
    const retainedId = "00000000-0000-4000-8000-000000000020";
    const deletedId = "00000000-0000-4000-8000-000000000021";
    const initial = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000022",
      source: { fileId: "00000000-0000-4000-8000-000000000023", digest: "a".repeat(64), byteLength: 10 },
    });
    const state = { ...initial, items: [
      native(retainedId, 0, 10, "Authored in session"),
      native(deletedId, 0, 30, "Deleted in session"),
    ] };
    const successor = prepareReplacementReview(
      state,
      2,
      state.source.fileId,
      { digest: "b".repeat(64), byteLength: 20 },
      [],
      [
        native(retainedId, 1, 110, "External stale comment"),
        native(deletedId, 1, 130, "Stale embedded deletion"),
      ],
      new Set([deletedId]),
    );
    expect(successor.items).toHaveLength(1);
    expect(successor.items[0]).toMatchObject({
      id: retainedId,
      pageIndex: 1,
      payload: { position: { x: 110 }, comment: "Authored in session" },
    });
  });

  it("does not transfer edits or deletion between independently promoted ordinal objects", () => {
    const predecessorId = "00000000-0000-4000-8000-000000000024";
    const candidateId = "00000000-0000-4000-8000-000000000025";
    const item = (id: string, comment: string): ReviewItem => ({
      id, kind: "pdfAnnotation", pageIndex: 0,
      createdAt: "2026-09-15T12:00:00.000Z", updatedAt: "2026-09-15T12:00:00.000Z",
      payload: {
        position: { x: 10, y: 20, width: 18, height: 18 }, comment,
        author: "External reviewer", subtype: "text", identityProvenance: "verified",
        sourceObjectPageIndex: 0, sourceObjectAnnotationIndex: 0,
      },
    });
    const base = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000026",
      source: { fileId: "00000000-0000-4000-8000-000000000027", digest: "a".repeat(64), byteLength: 10 },
    });
    const successor = prepareReplacementReview(
      { ...base, items: [item(predecessorId, "Prior authored edit")] },
      2, base.source.fileId, { digest: "b".repeat(64), byteLength: 20 }, [],
      [item(candidateId, "Independent candidate")], new Set([predecessorId]),
    );
    expect(successor.items).toEqual([item(candidateId, "Independent candidate")]);
  });

  it("reconciles one full cross-page passage after repagination without matching synthetic separators", () => {
    const page = (pageIndex: number, text: string) => ({
      pageIndex,
      text,
      geometry: [{
        charStart: 0,
        glyphs: Array.from(text, (_, index) => ({ x: 10 + index * 4, y: 20, width: 4, height: 8 })),
      }],
    });
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "alpha end\nnext beta",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 1, width: 8, height: 8 },
      segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }],
      pages: [
        {
          pageIndex: 0, quote: "alpha end", prefix: "before ", suffix: "",
          rect: { x: 1, y: 1, width: 8, height: 8 },
          segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }],
        },
        {
          pageIndex: 1, quote: "next beta", prefix: "", suffix: " after",
          rect: { x: 1, y: 1, width: 8, height: 8 },
          segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }],
        },
      ],
      pageBoundaries: [{ afterPageIndex: 0, separator: "\n" }],
    };

    const repaginatedPages = [
      page(0, "before alpha"),
      page(1, " endnext "),
      page(2, "beta after"),
    ];
    const result = reconcilePdfAnchor(anchor, repaginatedPages, 2);

    expect(result).toMatchObject({
      disposition: { kind: "resolved", generation: 2 },
      anchor: {
        kind: "selection",
        pageIndex: 0,
        quote: "alpha\n endnext \nbeta",
        pages: [
          { pageIndex: 0, quote: "alpha" },
          { pageIndex: 1, quote: " endnext " },
          { pageIndex: 2, quote: "beta" },
        ],
        pageBoundaries: [
          { afterPageIndex: 0, separator: "\n" },
          { afterPageIndex: 1, separator: "\n" },
        ],
      },
    });

    const item: ReviewItem = {
      ...selectionItem(ITEM_IDS.stable, anchor.quote, anchor.prefix, anchor.suffix),
      payload: { ...reviewSelectionPayload(anchor, { canonical: true }), comment: "Keep this" },
      reconciliation: {
        schemaVersion: 1,
        ownerViewId: "panel-a",
        baseGeneration: 1,
        revision: 1,
        anchor,
        disposition: { kind: "missing", reason: "not-yet-reconciled-to-generation" },
        previousAnchors: [],
      },
    };
    const reconciled = reconcilePdfAnchorState({
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000100",
        source: { fileId: "source", digest: "a".repeat(64), byteLength: 1 },
        workflowMode: "generated-output",
        documentGeneration: 2,
      }),
      items: [item],
    }, { pages: repaginatedPages, generation: 2 });
    const reconciledItem = reconciled.items[0]!;

    expect(reconciledItem.payload).toMatchObject({
      quote: "alpha\n endnext \nbeta",
      comment: "Keep this",
      pages: [
        { pageIndex: 0, quote: "alpha" },
        { pageIndex: 1, quote: " endnext " },
        { pageIndex: 2, quote: "beta" },
      ],
    });
    expect(() => assertReviewItem(reconciledItem)).not.toThrow();
    expect(projectReviewItemProjections(reconciledItem)).toHaveLength(3);
  });

  it("keeps a rebuilt cross-page anchor unsupported when it would skip a blank page", () => {
    const page = (pageIndex: number, text: string) => ({
      pageIndex,
      text,
      geometry: text.length === 0 ? [] : [{
        charStart: 0,
        glyphs: Array.from(text, (_, index) => ({ x: 10 + index * 4, y: 20, width: 4, height: 8 })),
      }],
    });
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "alpha\nbeta",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 1, width: 8, height: 8 },
      segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }],
      pages: [
        { pageIndex: 0, quote: "alpha", prefix: "before ", suffix: "", rect: { x: 1, y: 1, width: 8, height: 8 }, segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }] },
        { pageIndex: 1, quote: "beta", prefix: "", suffix: " after", rect: { x: 1, y: 1, width: 8, height: 8 }, segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }] },
      ],
      pageBoundaries: [{ afterPageIndex: 0, separator: "\n" }],
    };

    expect(reconcilePdfAnchor(anchor, [
      page(0, "before alpha"),
      page(1, ""),
      page(2, "beta after"),
    ], 2)).toEqual({
      anchor,
      disposition: {
        kind: "unsupported",
        reason: "reconciled-selection-violates-canonical-invariants",
      },
    });
  });

  it("keeps a rebuilt cross-page anchor unsupported when repagination exceeds the page limit", () => {
    const rect = { x: 1, y: 1, width: 8, height: 8 };
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "abcdef\nghijklm",
      prefix: "before ",
      suffix: " after",
      rect,
      segmentRects: [rect],
      pages: [
        { pageIndex: 0, quote: "abcdef", prefix: "before ", suffix: "", rect, segmentRects: [rect] },
        { pageIndex: 1, quote: "ghijklm", prefix: "", suffix: " after", rect, segmentRects: [rect] },
      ],
      pageBoundaries: [{ afterPageIndex: 0, separator: "\n" }],
    };
    const letters = Array.from("abcdefghijklm");
    const pages = letters.map((letter, pageIndex) => {
      const text = `${pageIndex === 0 ? "before " : ""}${letter}${pageIndex === 12 ? " after" : ""}`;
      return {
        pageIndex,
        text,
        geometry: [{
          charStart: 0,
          glyphs: Array.from(text, (_, index) => ({ x: 10 + index * 4, y: 20, width: 4, height: 8 })),
        }],
      };
    });

    expect(reconcilePdfAnchor(anchor, pages, 2)).toEqual({
      anchor,
      disposition: {
        kind: "unsupported",
        reason: "reconciled-selection-violates-canonical-invariants",
      },
    });
  });

  it("keeps a cross-page item wholly unresolved when only its fragments match", () => {
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "alpha\nbeta",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 1, width: 8, height: 8 },
      segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }],
      pages: [
        { pageIndex: 0, quote: "alpha", prefix: "before ", suffix: "", rect: { x: 1, y: 1, width: 8, height: 8 }, segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }] },
        { pageIndex: 1, quote: "beta", prefix: "", suffix: " after", rect: { x: 1, y: 1, width: 8, height: 8 }, segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }] },
      ],
      pageBoundaries: [{ afterPageIndex: 0, separator: "\n" }],
    };

    expect(reconcilePdfAnchor(anchor, [
      { pageIndex: 0, text: "before alpha unrelated" },
      { pageIndex: 1, text: "unrelated beta after" },
    ], 2)).toEqual({
      anchor,
      disposition: { kind: "missing", reason: "semantic-anchor-not-found" },
    });
  });

  it("keeps a cross-page passage wholly ambiguous when the complete text matches twice", () => {
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "alpha\nbeta",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 1, width: 8, height: 8 },
      segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }],
      pages: [
        { pageIndex: 0, quote: "alpha", prefix: "before ", suffix: "", rect: { x: 1, y: 1, width: 8, height: 8 }, segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }] },
        { pageIndex: 1, quote: "beta", prefix: "", suffix: " after", rect: { x: 1, y: 1, width: 8, height: 8 }, segmentRects: [{ x: 1, y: 1, width: 8, height: 8 }] },
      ],
      pageBoundaries: [{ afterPageIndex: 0, separator: "\n" }],
    };

    expect(reconcilePdfAnchor(anchor, [{
      pageIndex: 0,
      text: "before alphabeta after and before alphabeta after",
    }], 2)).toEqual({
      anchor,
      disposition: { kind: "ambiguous", reason: "semantic-anchor-matched-more-than-once" },
    });
  });

  it("keeps overlapping semantic matches ambiguous", () => {
    const resolved = reconcilePdfAnchor({
      kind: "selection",
      pageIndex: 0,
      quote: "ana",
      prefix: "",
      suffix: "",
      rect: { x: 1, y: 1, width: 1, height: 1 },
      segmentRects: [{ x: 1, y: 1, width: 1, height: 1 }],
    }, [{ pageIndex: 0, text: "banana" }], 2);

    expect(resolved.disposition).toEqual({
      kind: "ambiguous",
      reason: "semantic-anchor-matched-more-than-once",
    });
  });

  it("shares one canonical lineage across concurrent opens", async () => {
    const directory = await mkdtemp(join(tmpdir(), "placekeeper-concurrent-open-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "paper.pdf");
    await writeFile(pdfPath, "%PDF-1.7\ngenerated\n%%EOF");
    const broker = new SessionBroker({
      recoveryRoot: join(directory, "recovery"),
      portableReader: async () => [],
      rewriteAssessor: async () => ({ eligible: true }),
    });

    const [first, second] = await Promise.all([
      broker.openReview({ pdfPath, surface: "vscode", workflowMode: "generated-output" }),
      broker.openReview({ pdfPath, surface: "browser", workflowMode: "generated-output" }),
    ]);

    if (first.kind === "recovery-offered" || second.kind === "recovery-offered") {
      throw new Error("Concurrent clean opens must not offer recovery");
    }
    expect(new Set([first.launch.sessionId, second.launch.sessionId]).size).toBe(1);
    expect([first.kind, second.kind].toSorted()).toEqual(["focused", "opened"]);
  });

  it("marks a bound source save possibly stale without replacing the last successful PDF", async () => {
    const controls = new SessionControlRegistry({ heartbeat: false });
    const invalidated = vi.spyOn(controls, "publishStateInvalidation");
    const value = await fixture({ controls });
    await expect(value.broker.markLiveDocumentPossiblyStale(value.launch.sessionId))
      .resolves.toMatchObject({ status: "possibly-stale", documentGeneration: 1 });
    expect(value.broker.state(value.launch.sessionId)?.workflow.freshness).toBe("possibly-stale");
    expect(value.broker.state(value.launch.sessionId)?.revision).toBe(0);
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    expect(invalidated).toHaveBeenCalledWith(value.launch.sessionId, {
      documentGeneration: 1,
      reviewRevision: 0,
      reason: "freshness",
    });
  });

  it("restores current freshness when a rebuild validates identical PDF bytes", async () => {
    const controls = new SessionControlRegistry({ heartbeat: false });
    const invalidated = vi.spyOn(controls, "publishStateInvalidation");
    const value = await fixture({ controls });
    await value.broker.markLiveDocumentPossiblyStale(value.launch.sessionId, 1);

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 2,
    })).resolves.toMatchObject({ status: "same-digest", documentGeneration: 1 });

    expect(value.broker.state(value.launch.sessionId)?.workflow.freshness).toBe("current");
    expect(invalidated).toHaveBeenLastCalledWith(value.launch.sessionId, {
      documentGeneration: 1,
      reviewRevision: 0,
      reason: "freshness",
    });
  });

  it("advances an automatically reconciled draft so Apply accepts it", () => {
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "unique claim",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 1, width: 20, height: 8 },
      segmentRects: [{ x: 1, y: 1, width: 20, height: 8 }],
    };
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000100",
        source: { fileId: "00000000-0000-4000-8000-000000000101", digest: "a".repeat(64), byteLength: 1 },
        workflowMode: "generated-output",
        documentGeneration: 2,
      }),
      pendingDrafts: [{
        id: "00000000-0000-4000-8000-000000000102",
        ownerViewId: "view-1",
        baseGeneration: 1,
        revision: 0,
        kind: "highlight" as const,
        pageIndex: 0,
        text: "keep this",
        anchor,
        disposition: { kind: "resolved" as const, generation: 1 },
        status: "protected" as const,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z",
      }],
    };
    const text = "before unique claim after";
    const reconciled = reconcilePdfAnchorState(state, {
      generation: 2,
      pages: [{
        pageIndex: 0,
        text,
        geometry: [{
          charStart: 0,
          glyphs: Array.from(text, (_, index) => ({ x: index * 5, y: 10, width: 5, height: 8 })),
        }],
      }],
    });

    expect(reconciled.pendingDrafts[0]).toMatchObject({
      baseGeneration: 2,
      status: "protected",
      disposition: { kind: "resolved", generation: 2 },
    });
    expect(() => reduceReview(reconciled, {
      type: "apply-draft",
      expectedRevision: reconciled.revision,
      id: reconciled.pendingDrafts[0]!.id,
      expectedDraftRevision: 0,
      ownerViewId: "view-1",
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).not.toThrow();
  });

  it("lets a newer source-save epoch supersede an older rebuild candidate", async () => {
    const inspection = Promise.withResolvers<{
      pageCount: number;
      pages: readonly { pageIndex: number; text: string }[];
    }>();
    const inspectGeneration = vi.fn(() => inspection.promise);
    const value = await fixture({ inspectGeneration });
    await writeFile(value.pdfPath, value.successor);

    const replacement = value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });
    await vi.waitFor(() => expect(inspectGeneration).toHaveBeenCalledOnce());
    await value.broker.markLiveDocumentPossiblyStale(value.launch.sessionId, 2);
    inspection.resolve({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] });

    await expect(replacement).resolves.toMatchObject({ status: "superseded" });
    expect(value.broker.state(value.launch.sessionId)?.workflow).toMatchObject({
      documentGeneration: 1,
      freshness: "possibly-stale",
    });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
  });

  it("publishes a bounded same-generation revision invalidation after a human review command", async () => {
    const controls = new SessionControlRegistry({ heartbeat: false });
    const invalidated = vi.spyOn(controls, "publishStateInvalidation");
    const value = await fixture({ controls });

    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.stable, "Original generated output"),
    }, { expectedGeneration: 1 });

    expect(invalidated).toHaveBeenCalledWith(value.launch.sessionId, {
      documentGeneration: 1,
      reviewRevision: 1,
      reason: "revision",
    });
  });

  it("advances the existing output-path lineage instead of reopening by digest", async () => {
    const value = await fixture();
    await writeFile(value.pdfPath, value.successor);

    const transition = await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });

    expect(transition).toMatchObject({
      status: "committed",
      sessionId: value.launch.sessionId,
      previousGeneration: 1,
      documentGeneration: 2,
    });
    const joined = await value.broker.openReview({ pdfPath: value.pdfPath, surface: "browser" });
    expect(joined).toMatchObject({
      kind: "focused",
      launch: { sessionId: value.launch.sessionId, documentGeneration: 2 },
    });
    expect(value.broker.exchangeBootstrap(
      value.launch.sessionId,
      value.launch.fragment.slice("#cap=".length),
    )).toBeUndefined();
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.successor);
    await expect(value.broker.documentBytes(value.launch.sessionId, 1)).resolves.toEqual(value.original);
    await expect(value.broker.documentBytes(value.launch.sessionId, 2)).resolves.toEqual(value.successor);
    await expect(value.broker.documentBytes(value.launch.sessionId, 3)).resolves.toBeUndefined();
    await expect(readFile(value.pdfPath)).resolves.toEqual(value.successor);
  });

  it("advances an active copy destination without rebasing its independent fingerprint", async () => {
    const value = await fixture({}, "standard");
    const copy = join(value.directory, "reviewed-copy.pdf");
    await writeFile(copy, "%PDF-1.7\ncopy baseline\n%%EOF");
    const copyDigest = createHash("sha256").update(await readFile(copy)).digest("hex");
    const capability = await value.broker.capabilities.preauthorizeDestination(copy);
    await value.broker.capabilities.refreshDestination(capability.id, copyDigest);
    await value.broker.establishSaveDestination(value.launch.sessionId, {
      kind: "copy",
      targetPath: copy,
      capabilityId: capability.id,
      fingerprint: copyDigest,
    });
    const before = value.broker.saveStatus(value.launch.sessionId)!.destination;
    if (before.phase !== "active") throw new Error("Expected active copy destination");

    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });

    expect(value.broker.saveStatus(value.launch.sessionId)).toMatchObject({
      destination: {
        phase: "active",
        kind: "copy",
        generation: before.generation + 1,
        targetPath: copy,
        fingerprint: copyDigest,
      },
      sync: { phase: "saving" },
    });
  });

  it("reconciles every item without changing identity or silently retargeting uncertain anchors", async () => {
    const value = await fixture({
      inspectGeneration: async () => ({
        pageCount: 2,
        pages: [
          {
            pageIndex: 0,
            text: "before stable claim after; repeated claim repeated claim",
            geometry: [{
              charStart: 0,
              glyphs: Array.from(
                "before stable claim after; repeated claim repeated claim",
                (_, index) => ({ x: 40 + index * 5, y: 72, width: 5, height: 9 }),
              ),
            }],
          },
          {
            pageIndex: 1,
            text: "other content",
            geometry: [{
              charStart: 0,
              glyphs: Array.from(
                "other content",
                (_, index) => ({ x: 40 + index * 5, y: 72, width: 5, height: 9 }),
              ),
            }],
          },
        ],
      }),
    });
    let revision = 0;
    for (const item of [
      selectionItem(ITEM_IDS.stable, "stable claim", "before ", " after"),
      selectionItem(ITEM_IDS.ambiguous, "repeated claim"),
      selectionItem(ITEM_IDS.missing, "removed claim"),
    ]) {
      const state = await value.broker.acceptMutation(value.launch.sessionId, {
        type: "add",
        expectedRevision: revision,
        item,
        authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
      });
      revision = state.revision;
    }
    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });

    const items = value.broker.state(value.launch.sessionId)!.items;
    expect(items.map(({ id }) => id)).toEqual([ITEM_IDS.stable, ITEM_IDS.ambiguous, ITEM_IDS.missing]);
    expect(items.map((item) => item.reconciliation?.disposition.kind)).toEqual([
      "resolved", "ambiguous", "missing",
    ]);
    expect(items[0]?.reconciliation).toMatchObject({
      disposition: { kind: "resolved", generation: 2 },
      anchor: {
        rect: { x: 75, y: 72, width: 60, height: 9 },
        segmentRects: [{ x: 75, y: 72, width: 60, height: 9 }],
      },
      previousAnchors: [{ generation: 1, disposition: { kind: "resolved", generation: 1 } }],
    });
    expect(items[0]?.payload).toMatchObject({
      rect: { x: 75, y: 72, width: 60, height: 9 },
      segmentRects: [{ x: 75, y: 72, width: 60, height: 9 }],
    });
    expect(items[1]?.reconciliation?.anchor).toMatchObject({ quote: "repeated claim", pageIndex: 0 });
    expect(items[2]?.reconciliation?.anchor).toMatchObject({ quote: "removed claim", pageIndex: 0 });
  });

  it("retains the last successful generation and protected state for an invalid candidate", async () => {
    const value = await fixture({ inspectGeneration: async () => { throw new Error("truncated PDF"); } });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.protected, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, "%PDF-1.7\ntruncated");

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "invalid", documentGeneration: 1 });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    expect(value.broker.state(value.launch.sessionId)).toMatchObject({
      workflow: { documentGeneration: 1, freshness: "possibly-stale" },
      items: [{ id: ITEM_IDS.protected }],
    });
  });

  it("lets only the newest rapid candidate publish and fences a racing review mutation", async () => {
    const firstInspection = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let inspections = 0;
    const value = await fixture({
      inspectGeneration: async () => {
        inspections += 1;
        if (inspections === 1) {
          firstInspection.resolve();
          await releaseFirst.promise;
        }
        return { pageCount: 1, pages: [{ pageIndex: 0, text: "successor" }] };
      },
    });
    await writeFile(value.pdfPath, value.successor);
    const older = value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });
    await firstInspection.promise;

    const newerBytes = Buffer.concat([value.successor, Buffer.from("\n% newer stable candidate")]);
    await writeFile(value.pdfPath, newerBytes);
    const newer = await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 2,
    });
    releaseFirst.resolve();
    await expect(older).resolves.toMatchObject({ status: "superseded", documentGeneration: 2 });
    expect(newer).toMatchObject({ status: "committed", documentGeneration: 2 });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(newerBytes);

    const thirdBytes = Buffer.concat([newerBytes, Buffer.from("\n% third candidate")]);
    await writeFile(value.pdfPath, thirdBytes);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const guarded = await fixture({
      inspectGeneration: async () => {
        entered.resolve();
        await release.promise;
        return { pageCount: 1, pages: [{ pageIndex: 0, text: "late" }] };
      },
    });
    await writeFile(guarded.pdfPath, guarded.successor);
    const candidate = guarded.broker.replaceLiveDocument({
      sessionId: guarded.launch.sessionId,
      outputPath: guarded.pdfPath,
      observationEpoch: 1,
    });
    await entered.promise;
    await guarded.broker.acceptMutation(guarded.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.racing, "late"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    release.resolve();
    await expect(candidate).resolves.toMatchObject({
      status: "committed",
      documentGeneration: 2,
      reviewRevision: 2,
    });
    expect(guarded.broker.state(guarded.launch.sessionId)).toMatchObject({
      workflow: { documentGeneration: 2 }, items: [{ id: ITEM_IDS.racing }],
    });
    expect(guarded.broker.state(guarded.launch.sessionId)?.items.filter(
      ({ id }) => id === ITEM_IDS.racing,
    )).toHaveLength(1);
  });

  it("publishes an ordinary local review through the shared replacement transaction", async () => {
    const value = await fixture({
      inspectGeneration: async () => {
        const text = "Original generated output";
        return {
          pageCount: 1,
          pages: [{
            pageIndex: 0,
            text,
            geometry: [{
              charStart: 0,
              glyphs: Array.from(text, (_, index) => ({
                x: 10 + index * 5, y: 20, width: 5, height: 8,
              })),
            }],
          }],
        };
      },
    }, "standard");
    const withItem = await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add",
      expectedRevision: 0,
      item: selectionItem(ITEM_IDS.stable, "Original generated output"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "put-draft",
      expectedRevision: withItem.revision,
      expectedDraftRevision: -1,
      draft: {
        id: "00000000-0000-4000-8000-000000000007",
        ownerViewId: "panel-a",
        baseGeneration: 1,
        revision: 0,
        kind: "highlight",
        pageIndex: 0,
        text: "protected ordinary draft",
        anchor: anchorEvidenceFromReviewItem(withItem.items[0]!),
        disposition: { kind: "resolved", generation: 1 },
        status: "protected",
        createdAt: "2026-09-15T12:00:00.000Z",
        updatedAt: "2026-09-15T12:00:00.000Z",
      },
    });
    await writeFile(value.pdfPath, value.successor);

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    expect(value.broker.state(value.launch.sessionId)).toMatchObject({
      workflow: { mode: "standard", documentRole: "source-pdf", documentGeneration: 2 },
      items: [{ id: ITEM_IDS.stable, reconciliation: { baseGeneration: 1 } }],
      pendingDrafts: [{ baseGeneration: 2, status: "protected" }],
    });

    await value.broker.quiesceForShutdown();
    const restarted = new SessionBroker({ recoveryRoot: join(value.directory, "recovery") });
    const offered = await restarted.openReview({ pdfPath: value.pdfPath, workflowMode: "standard" });
    if (offered.kind !== "recovery-offered") throw new Error("Expected ordinary successor recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: value.pdfPath,
      workflowMode: "standard",
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected ordinary successor recovery");
    const resumedState = restarted.state(resumed.launch.sessionId)!;
    expect(resumedState).toMatchObject({
      workflow: { mode: "standard", documentGeneration: 2, historyBoundary: 2 },
      items: [{ id: ITEM_IDS.stable }],
      pendingDrafts: [{ baseGeneration: 2, status: "protected", text: "protected ordinary draft" }],
    });
    await expect(restarted.acceptMutation(resumed.launch.sessionId, {
      type: "undo", expectedRevision: resumedState.revision,
    })).rejects.toThrow(/cannot cross the rebuild history boundary/iu);
  });

  it("rejects a verified symlink retarget without expanding source authority", async () => {
    const value = await fixture();
    const retarget = join(value.directory, "retarget.pdf");
    await writeFile(retarget, value.successor);
    await rm(value.pdfPath);
    await symlink(retarget, value.pdfPath);

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).rejects.toThrow(/cannot retarget/iu);
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    expect(value.broker.state(value.launch.sessionId)?.workflow.documentGeneration).toBe(1);
  });

  it("rejects a candidate whose source identity changes while inspection is pending", async () => {
    const inspection = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const value = await fixture({
      inspectGeneration: async () => {
        inspection.resolve();
        await release.promise;
        return { pageCount: 1, pages: [{ pageIndex: 0, text: "staged" }] };
      },
    });
    await writeFile(value.pdfPath, value.successor);
    const replacement = value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    });
    await inspection.promise;
    await writeFile(value.pdfPath, Buffer.concat([value.successor, Buffer.from("\n% changed during inspection")]));
    release.resolve();

    await expect(replacement).resolves.toMatchObject({ status: "invalid", documentGeneration: 1 });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
  });

  it("preserves predecessor state and retryability while the canonical path is temporarily missing", async () => {
    const value = await fixture({
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    const codex = await value.broker.openReview({ pdfPath: value.pdfPath, surface: "codex" });
    if (codex.kind !== "focused" || codex.launch.bindProof === undefined) {
      throw new Error("Expected Codex binding proof");
    }
    const browserCapability = codex.launch.fragment.slice("#cap=".length);
    expect(value.broker.taskBindings.claim({
      bindProof: codex.launch.bindProof,
      taskSessionId: "task-missing",
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 1,
    }).status).toBe("pending");
    expect(value.broker.exchangeBootstrap(value.launch.sessionId, browserCapability)).toBeTypeOf("string");
    expect(value.broker.taskBindings.bindingForTask("task-missing")).toMatchObject({
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 1,
    });
    await rm(value.pdfPath);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    })).resolves.toMatchObject({ status: "invalid", reason: "candidate-path-is-temporarily-unavailable" });
    expect(value.broker.state(value.launch.sessionId)).toMatchObject({
      workflow: { documentGeneration: 1, freshness: "possibly-stale" },
      items: [{ id: ITEM_IDS.retained }],
    });
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    expect(value.broker.taskBindings.bindingForTask("task-missing")).toMatchObject({
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 1,
    });

    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 2,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
  });

  it("keeps an ordinary local review retryable when its candidate path is temporarily missing", async () => {
    const value = await fixture({}, "standard");
    await rm(value.pdfPath);

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({
      status: "invalid",
      documentGeneration: 1,
      reason: "candidate-path-is-temporarily-unavailable",
    });
    expect(value.broker.state(value.launch.sessionId)?.workflow).toMatchObject({
      mode: "standard",
      documentGeneration: 1,
      freshness: "current",
    });
  });

  it("rejects an over-budget successor without evicting the referenced predecessor and recovers it", async () => {
    const value = await fixture({
      maxGenerationCount: 1,
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "retention-rejected", documentGeneration: 1 });
    await value.broker.quiesceForShutdown();

    const restarted = new SessionBroker({ recoveryRoot: join(value.directory, "recovery") });
    const offered = await restarted.openReview({
      pdfPath: value.pdfPath,
      workflowMode: "generated-output",
    });
    expect(offered).toMatchObject({ kind: "recovery-offered", recoverySessionId: value.launch.sessionId });
  });

  it("recovers wholly old when the atomic recovery rename fails and wholly new after commit", async () => {
    let failRename = false;
    const value = await fixture({
      snapshotHooks: {
        beforeFinalRename: () => {
          if (failRename) {
            failRename = false;
            throw new Error("simulated crash before recovery rename");
          }
        },
      },
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, value.successor);
    failRename = true;
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    })).resolves.toMatchObject({ status: "invalid", documentGeneration: 1 });
    expect((await new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover())?.state.workflow.documentGeneration).toBe(1);

    const newer = Buffer.concat([value.successor, Buffer.from("\n% committed after retry")]);
    await writeFile(value.pdfPath, newer);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 2,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    expect((await new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover())?.state.workflow.documentGeneration).toBe(2);
  });

  it("keeps committed successor bytes when persistence throws after the recovery rename", async () => {
    let failAfterRename = false;
    const value = await fixture({
      snapshotHooks: {
        afterFinalRename: () => {
          if (failAfterRename) {
            failAfterRename = false;
            throw new Error("simulated uncertain return after recovery rename");
          }
        },
      },
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, value.successor);
    failAfterRename = true;

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    const recovered = await new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover();
    expect(recovered?.state.workflow.documentGeneration).toBe(2);
    if (recovered?.source.disposition !== "local") throw new Error("Expected local recovery ownership");
    await expect(readFile(recovered.source.sourceSnapshotPath)).resolves.toEqual(value.successor);
    await expect(value.broker.documentBytes(value.launch.sessionId, 1)).resolves.toEqual(value.original);
    await expect(value.broker.documentBytes(value.launch.sessionId, 2)).resolves.toEqual(value.successor);
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.successor);
  });

  it("retains both snapshots when an uncertain persistence outcome cannot be inspected immediately", async () => {
    let failAfterRename = false;
    let failRecoveryInspection = false;
    const value = await fixture({
      snapshotHooks: {
        afterFinalRename: () => {
          if (failAfterRename) {
            failAfterRename = false;
            failRecoveryInspection = true;
            throw new Error("simulated uncertain return after recovery rename");
          }
        },
        beforeRecover: () => {
          if (failRecoveryInspection) throw new Error("simulated recovery inspection failure");
        },
      },
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    await value.broker.acceptMutation(value.launch.sessionId, {
      type: "add", expectedRevision: 0, item: selectionItem(ITEM_IDS.retained, "Original"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    });
    await writeFile(value.pdfPath, value.successor);
    failAfterRename = true;

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    })).resolves.toMatchObject({
      status: "invalid",
      documentGeneration: 1,
      reason: "generation-commit-outcome-is-uncertain",
    });
    expect(value.broker.replacementCommitPending(value.launch.sessionId)).toBe(true);
    await expect(value.broker.documentBytes(value.launch.sessionId)).resolves.toEqual(value.original);
    await expect(value.broker.acceptMutation(value.launch.sessionId, {
      type: "add",
      expectedRevision: 1,
      item: selectionItem("00000000-0000-4000-8000-000000000008", "blocked"),
      authoring: { ownerViewId: "panel-a", baseGeneration: 1 },
    })).rejects.toThrow(/commit outcome remains uncertain/iu);
    const physicalSave = vi.fn(async () => "f".repeat(64));
    await expect(value.broker.commitSaveCandidate({
      sessionId: value.launch.sessionId,
      generation: 0,
      documentGeneration: 1,
      sourceDigest: value.broker.state(value.launch.sessionId)!.source.digest,
      revision: 1,
      stateDigest: "a".repeat(64),
      commit: physicalSave,
    })).rejects.toThrow(/commit outcome remains uncertain/iu);
    expect(physicalSave).not.toHaveBeenCalled();
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 2,
    })).rejects.toThrow(/commit outcome remains uncertain/iu);

    failRecoveryInspection = false;
    await expect(value.broker.resolveReplacementCommit(value.launch.sessionId)).resolves.toBe("settled");
    expect(value.broker.replacementCommitPending(value.launch.sessionId)).toBe(false);
    expect(value.broker.state(value.launch.sessionId)?.workflow.documentGeneration).toBe(2);
    const recovered = await new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover();
    expect(recovered?.state.workflow.documentGeneration).toBe(2);
    if (recovered?.source.disposition !== "local") throw new Error("Expected local recovery ownership");
    await expect(readFile(recovered.source.sourceSnapshotPath)).resolves.toEqual(value.successor);

    await value.broker.quiesceForShutdown();
    const restarted = new SessionBroker({ recoveryRoot: join(value.directory, "recovery") });
    const offered = await restarted.openReview({
      pdfPath: value.pdfPath,
      workflowMode: "generated-output",
    });
    if (offered.kind !== "recovery-offered") throw new Error("Expected successor recovery offer");
    const resumed = await restarted.openReview({
      pdfPath: value.pdfPath,
      workflowMode: "generated-output",
      recoveryDecision: "resume",
      recoveryOffer: offered.recoveryOffer,
      recoveryOperationId: randomUUID(),
    });
    if (resumed.kind !== "opened") throw new Error("Expected successor recovery");
    expect(restarted.state(resumed.launch.sessionId)?.workflow.documentGeneration).toBe(2);
    await expect(restarted.documentBytes(resumed.launch.sessionId)).resolves.toEqual(value.successor);
  });

  it("migrates only the exact active same-output task lease and revokes authority on retarget", async () => {
    const value = await fixture({
      inspectGeneration: async () => ({ pageCount: 1, pages: [{ pageIndex: 0, text: "new" }] }),
    });
    const codex = await value.broker.openReview({ pdfPath: value.pdfPath, surface: "codex" });
    if (codex.kind !== "focused" || codex.launch.bindProof === undefined) throw new Error("Expected Codex focus");
    const capability = codex.launch.fragment.slice("#cap=".length);
    expect(value.broker.taskBindings.claim({
      bindProof: codex.launch.bindProof,
      taskSessionId: "task-a",
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 1,
    }).status).toBe("pending");
    const credential = value.broker.exchangeBootstrap(value.launch.sessionId, capability);
    expect(credential).toBeTypeOf("string");
    const before = value.broker.state(value.launch.sessionId)!;
    expect(value.broker.taskBindings.markVerified("task-a", {
      placekeeperSessionId: value.launch.sessionId,
      documentGeneration: 1,
      source: before.source,
      reviewRevision: before.revision,
      stateDigest: reviewSemanticDigest(before.items),
    })).toBe(true);
    const evidence = new PdfEvidenceService({
      bindings: value.broker.taskBindings,
      loadSource: async () => undefined,
    });
    const oldHandle = evidence.mint({
      taskSessionId: "task-a",
      identity: {
        placekeeperSessionId: value.launch.sessionId,
        documentGeneration: 1,
        source: before.source,
        reviewRevision: before.revision,
        stateDigest: reviewSemanticDigest(before.items),
      },
      pageCount: 1,
      sourceByteLength: before.source.byteLength,
      existingAnnotations: [],
      reviewItems: [],
    }).handle.value;
    await writeFile(value.pdfPath, value.successor);
    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: value.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", migratedTaskSessionId: "task-a" });
    expect(value.broker.taskBindings.bindingForTask("task-a")).toMatchObject({
      reviewSessionId: value.launch.sessionId,
      documentGeneration: 2,
    });
    expect(value.broker.taskBindings.bindingForTask("task-a")?.lastVerified).toBeUndefined();
    expect(evidence.authorizeHandle(oldHandle)).toMatchObject({ status: "unavailable" });
    expect(value.broker.authenticate(value.launch.sessionId, credential!)).toBe(true);
    await expect(new DraftSnapshotStore(
      join(value.directory, "recovery", value.launch.sessionId),
    ).recover()).resolves.toMatchObject({
      sourceWorkInterruptions: [{
        taskSessionId: "task-a",
        previousGeneration: 1,
        successorGeneration: 2,
        disposition: "interrupted-by-generation",
      }],
    });

    await expect(value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId,
      outputPath: join(value.directory, "other.pdf"),
      observationEpoch: 2,
    })).rejects.toThrow(/cannot retarget/iu);
    expect(value.broker.taskBindings.bindingForTask("task-a")).toBeUndefined();
  });
});
