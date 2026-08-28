import { renderToStaticMarkup } from "react-dom/server";
import { PdfZoomMode } from "@embedpdf/models";
import { describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import { createReviewStateSummary } from "../../../packages/core/src/live-context.js";
import {
  applyHostForwardSyncTex,
  initiallyPortableItemIds,
  canonicalStateSupersedes,
  firstUnresolvedReviewItemId,
  ProductionReviewApp,
  referenceReturnForActiveTab,
  visibleCodexContext,
} from "../src/app/ProductionReviewApp.js";
import { SaveDestinationDialog } from "../src/save/SaveDestinationDialog.js";
import {
  canDeriveAnnotationOutlineLabels,
  deriveAnnotationOutlineLabels,
} from "../src/review/annotation-outline-context.js";
import {
  buildReattachmentCommand,
  cancelledReattachmentPresentation,
  reconciliationCommandPresentation,
  reattachmentCandidateFor,
  reattachmentGenerationIsCurrent,
  reconciliationExportPresentation,
  ReconciliationWorkspace,
} from "../src/review/ReconciliationWorkspace.js";

describe("one production review tree", () => {
  it("centers a trusted forward SyncTeX point without changing the current zoom", async () => {
    const applyLocation = vi.fn(async () => true);
    const focusAtDestination = vi.fn(() => true);
    const navigation = {
      captureLocation: vi.fn(() => ({
        pageIndex: 0,
        anchor: { x: 0, y: 0 },
        alignment: { xPercent: 10, yPercent: 20 },
        zoom: 1.25,
      })),
      applyLocation,
      focusAtDestination,
    };

    await expect(applyHostForwardSyncTex(navigation, {
      pageIndex: 2,
      point: { x: 72, y: 144 },
    })).resolves.toBe(true);
    expect(applyLocation).toHaveBeenCalledWith({
      pageIndex: 2,
      anchor: { x: 72, y: 144 },
      alignment: { xPercent: 50, yPercent: 50 },
      zoom: 1.25,
    });
    expect(focusAtDestination).toHaveBeenCalledWith(2);
    await expect(applyHostForwardSyncTex(navigation, {
      pageIndex: -1,
      point: { x: 72, y: 144 },
    })).resolves.toBe(false);
  });

  it("routes the VS Code reattach command to the first canonical unresolved item", () => {
    const resolved = { id: "resolved", reconciliation: { disposition: { kind: "resolved" } } };
    const ambiguous = { id: "ambiguous", reconciliation: { disposition: { kind: "ambiguous" } } };
    const missing = { id: "missing", reconciliation: { disposition: { kind: "missing" } } };
    expect(firstUnresolvedReviewItemId([resolved, ambiguous, missing])).toBe("ambiguous");
    expect(firstUnresolvedReviewItemId([resolved])).toBeUndefined();
  });

  it("adopts same-generation canonical freshness without requiring a review revision", () => {
    const current = { revision: 2, workflow: { documentGeneration: 3, freshness: "current" as const } };
    const stale = { revision: 2, workflow: { documentGeneration: 3, freshness: "possibly-stale" as const } };
    expect(canonicalStateSupersedes(current, stale)).toBe(true);
    expect(canonicalStateSupersedes(stale, current)).toBe(false);
    expect(canonicalStateSupersedes(current, current)).toBe(false);
  });
  it("renders canonical unresolved work, frozen drafts, freshness, and export gates", () => {
    const base = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000071",
      source: { fileId: "00000000-0000-4000-8000-000000000072", digest: "d".repeat(64), byteLength: 10 },
      workflowMode: "generated-output",
      documentGeneration: 4,
    });
    const anchor = {
      kind: "selection" as const,
      pageIndex: 0,
      quote: "old sentence",
      prefix: "before ",
      suffix: " after",
      rect: { x: 1, y: 2, width: 30, height: 8 },
      segmentRects: [{ x: 1, y: 2, width: 30, height: 8 }],
    };
    const state = {
      ...base,
      workflow: { ...base.workflow, freshness: "possibly-stale" as const },
      items: [{
        id: "00000000-0000-4000-8000-000000000073",
        kind: "replace" as const,
        pageIndex: 0,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        payload: { ...anchor, reliable: true, proposedText: "new sentence" },
        reconciliation: {
          schemaVersion: 1 as const,
          ownerViewId: "view-1",
          baseGeneration: 3,
          revision: 2,
          anchor,
          disposition: { kind: "ambiguous" as const, reason: "two matching passages" },
          previousAnchors: [],
        },
      }],
      pendingDrafts: [{
        id: "00000000-0000-4000-8000-000000000074",
        ownerViewId: "view-1",
        baseGeneration: 3,
        revision: 1,
        kind: "replace" as const,
        pageIndex: 0,
        text: "unfinished wording",
        anchor,
        disposition: { kind: "missing" as const, reason: "draft-frozen-on-predecessor-generation" },
        status: "frozen" as const,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }],
    };

    const html = renderToStaticMarkup(<ReconciliationWorkspace
      state={state}
      selectionUpdate={{ kind: "cleared", generation: 1 }}
      caretAnchor={null}
      refreshStatus="idle"
      onCommand={vi.fn()}
      onExport={vi.fn()}
    />);

    expect(html).toContain('data-reconciliation-workspace');
    expect(html).toContain("old sentence");
    expect(html).toContain("two matching passages");
    expect(html).toContain("unfinished wording");
    expect(html).toContain("Frozen draft");
    expect(html).not.toContain(">Apply</button>");
    expect(html).toContain("possibly stale");
    expect(html).toContain("Resolve 1 Review Item and 1 pending draft before export");
  });

  it("builds revision-fenced reattachment commands without changing semantic identity", () => {
    const anchor = {
      kind: "selection" as const,
      pageIndex: 2,
      quote: "replacement target",
      prefix: "left",
      suffix: "right",
      rect: { x: 2, y: 3, width: 40, height: 9 },
      segmentRects: [{ x: 2, y: 3, width: 40, height: 9 }],
    };
    expect(buildReattachmentCommand({
      target: { kind: "item", id: "item-1", revision: 5, ownerViewId: "view-1" },
      stateRevision: 9,
      documentGeneration: 7,
      anchor,
      updatedAt: "2026-08-27T01:00:00.000Z",
    })).toMatchObject({
      type: "reattach",
      expectedRevision: 9,
      id: "item-1",
      expectedReconciliationRevision: 5,
      ownerViewId: "view-1",
      anchor,
    });

    const draft = {
      id: "draft-1",
      ownerViewId: "view-1",
      baseGeneration: 6,
      revision: 3,
      kind: "replace" as const,
      pageIndex: 0,
      text: "do not lose this text",
      anchor,
      disposition: { kind: "missing" as const, reason: "predecessor" },
      status: "frozen" as const,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    expect(buildReattachmentCommand({
      target: { kind: "draft", draft },
      stateRevision: 9,
      documentGeneration: 7,
      anchor,
      updatedAt: "2026-08-27T01:00:00.000Z",
    })).toMatchObject({
      type: "put-draft",
      expectedRevision: 9,
      expectedDraftRevision: 3,
      draft: {
        id: "draft-1",
        text: "do not lose this text",
        baseGeneration: 7,
        status: "protected",
        disposition: { kind: "resolved", generation: 7 },
      },
    });
    expect(reattachmentGenerationIsCurrent(7, 8)).toBe(false);
  });

  it("keeps invalid or ambiguous replacement evidence unconfirmable", () => {
    expect(reattachmentCandidateFor("selection", {
      kind: "unreliable",
      generation: 4,
      userMessage: "The selection matches more than one passage.",
      diagnostic: "selection-quote-not-unique",
    }, null)).toEqual({
      anchor: null,
      message: "The selection matches more than one passage.",
    });
    expect(reattachmentCandidateFor("caret", { kind: "cleared", generation: 4 }, null).anchor).toBeNull();
    expect(cancelledReattachmentPresentation()).toEqual({
      unresolved: true,
      message: "Reattachment cancelled. The item remains unresolved.",
    });
    expect(reconciliationCommandPresentation({
      accepted: false,
      message: "Another review window changed this draft.",
    }, "Reattachment saved.")).toEqual({
      accepted: false,
      message: "Another review window changed this draft.",
    });
    expect(reconciliationCommandPresentation({}, "Reattachment saved.")).toEqual({
      accepted: true,
      message: "Reattachment saved.",
    });
  });

  it("explains reconciling, unresolved, stale-confirmation, and eligible export states", () => {
    const summary = (unresolvedItems: number, pendingDrafts: number, freshness: "current" | "possibly-stale") => ({
      ...createReviewStateSummary({
        ...createReviewState({
          sessionId: "00000000-0000-4000-8000-000000000099",
          source: { fileId: "00000000-0000-4000-8000-000000000098", digest: "f".repeat(64), byteLength: 1 },
          workflowMode: "generated-output",
          documentGeneration: 1,
        }),
        workflow: {
          ...createReviewState({
            sessionId: "00000000-0000-4000-8000-000000000099",
            source: { fileId: "00000000-0000-4000-8000-000000000098", digest: "f".repeat(64), byteLength: 1 },
            workflowMode: "generated-output",
            documentGeneration: 1,
          }).workflow,
          freshness,
        },
      }),
      reconciliation: {
        complete: unresolvedItems === 0 && pendingDrafts === 0,
        dispositionDigest: "0".repeat(64),
        unresolvedItemIds: Array.from({ length: unresolvedItems }, (_, index) => `item-${index}`),
        pendingDraftIds: Array.from({ length: pendingDrafts }, (_, index) => `draft-${index}`),
      },
      export: unresolvedItems > 0 || pendingDrafts > 0
        ? { eligible: false as const, requiresStaleConfirmation: false as const, reasons: [unresolvedItems > 0 ? "unresolved-items" as const : "pending-drafts" as const] }
        : freshness === "possibly-stale"
          ? { eligible: false as const, requiresStaleConfirmation: true as const, reasons: ["possibly-stale" as const] }
          : { eligible: true as const, requiresStaleConfirmation: false as const },
    });
    expect(reconciliationExportPresentation({
      refreshStatus: "reconciling",
      summary: summary(0, 0, "current"),
    }).message).toContain("reconciliation finishes");
    expect(reconciliationExportPresentation({
      refreshStatus: "idle",
      summary: summary(2, 0, "current"),
    }).message).toContain("Resolve 2 Review Items");
    expect(reconciliationExportPresentation({
      refreshStatus: "idle",
      summary: summary(0, 0, "possibly-stale"),
    })).toMatchObject({ canExport: true, requiresStaleConfirmation: true });
    expect(reconciliationExportPresentation({
      refreshStatus: "idle",
      summary: summary(0, 0, "current"),
    })).toMatchObject({ canExport: true, requiresStaleConfirmation: false });
  });

  it("integrates generated-output reconciliation and export without automatic-save controls", () => {
    const state = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000081",
      source: { fileId: "00000000-0000-4000-8000-000000000082", digest: "e".repeat(64), byteLength: 20 },
      workflowMode: "generated-output",
      documentGeneration: 8,
    });
    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId }}
      initialState={state}
      scope={{ documentTitle: "paper.pdf", launchSurface: "vscode" }}
      api={{
        command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        exportReviewedCopy: vi.fn(), scope: vi.fn(),
      }}
      viewer={<div>Generation 8 viewer</div>}
    />);

    expect(html).toContain("Generation 8 viewer");
    expect(html).toContain('data-reconciliation-workspace');
    expect(html).toContain('data-export-eligibility="eligible"');
    expect(html).toContain("Protected review state");
    expect(html).not.toContain("Open automatic save options");
    expect(html).not.toContain('aria-haspopup="dialog"');
  });

  it("exposes Reference return state only for the current tab and document generation", () => {
    const presentation = {
      tabIdentity: "reference-a",
      documentGeneration: 4,
      available: true,
      pending: true,
    } as const;
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 4,
    }, presentation)).toBe(presentation);
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-b",
      documentGeneration: 4,
    }, presentation)).toBeNull();
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 5,
    }, presentation)).toBeNull();
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 4,
    }, null)).toBeNull();
    expect(referenceReturnForActiveTab({
      activeTabIdentity: "reference-a",
      documentGeneration: 4,
    }, { ...presentation, available: false })).toBeNull();
  });

  it("keeps clean imported review items portable without an active save destination", () => {
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000031",
        source: { fileId: "00000000-0000-4000-8000-000000000032", digest: "a".repeat(64), byteLength: 12 },
      }),
      revision: 1,
      items: [{
        id: "00000000-0000-4000-8000-000000000033",
        kind: "pageNote" as const,
        pageIndex: 0,
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Imported" },
      }],
    };
    expect(initiallyPortableItemIds(state, {
      destination: { phase: "none", generation: 0 },
      sync: { phase: "clean", desiredRevision: 1, savedRevision: 1 },
    })).toEqual(new Set(["00000000-0000-4000-8000-000000000033"]));
  });

  it("derives owned and source subsection labels from safe document geometry", () => {
    const outlineTarget = {
      documentGeneration: 4,
      pageIndex: 0,
      zoom: { mode: PdfZoomMode.XYZ, params: [172, 1500, 1] },
      identity: JSON.stringify([4, 0, PdfZoomMode.XYZ, 172, 1500, 1]),
    };
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: 4,
      outline: {
        status: "loaded-tree",
        documentGeneration: 4,
        items: [{
          id: "outline-methods",
          label: "Methods and data",
          pageContext: "Page 1",
          target: outlineTarget,
          children: [],
        }],
      },
      pages: [{
        size: { width: 600, height: 800 },
        crop: { left: 100, top: 200, bottom: 1000 },
      }],
      owned: [{
        id: "owned-note",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: 172, y: 600, width: 10, height: 10 }, comment: "Check" },
      }],
      source: [{
        id: "source-note",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: 172, y: 320, width: 10, height: 10 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.get("owned-note")).toBe("Methods and data");
    expect(labels.source.get("0:source-note")).toBe("Methods and data");
  });

  it.each([
    [{ status: "loading" as const, documentGeneration: 4 }, 4],
    [{ status: "loaded-empty" as const, documentGeneration: 4 }, 4],
    [{ status: "unavailable" as const, documentGeneration: 4 }, 4],
    [{
      status: "loaded-tree" as const,
      documentGeneration: 3,
      items: [{
        id: "stale-outline",
        label: "Stale outline",
        pageContext: "Page 1",
        target: {
          documentGeneration: 4,
          pageIndex: 0,
          zoom: { mode: PdfZoomMode.FitPage, params: [] },
          identity: "otherwise-safe-target",
        },
        children: [],
      }],
    }, 4],
  ])("omits subsection labels for incomplete or stale outline discovery", (outline, generation) => {
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: generation,
      outline,
      pages: [{ size: { width: 600, height: 800 }, crop: { left: 0, top: 0, bottom: 0 } }],
      owned: [{
        id: "valid-owned",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: 10, y: 100, width: 1, height: 1 }, comment: "Check" },
      }],
      source: [{
        id: "valid-source",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: 10, y: 100, width: 1, height: 1 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.size).toBe(0);
    expect(labels.source.size).toBe(0);
  });

  it("fails closed for unsafe outline evidence with otherwise valid annotations", () => {
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: 4,
      outline: {
        status: "loaded-tree",
        documentGeneration: 4,
        items: [{
          id: "unsafe",
          label: "Unsafe",
          pageContext: "Page 1",
          target: {
            documentGeneration: 3,
            pageIndex: 0,
            zoom: { mode: PdfZoomMode.FitPage, params: [] },
            identity: "stale-target",
          },
          children: [],
        }],
      },
      pages: [{ size: { width: 600, height: 800 }, crop: { left: 0, top: 0, bottom: 0 } }],
      owned: [{
        id: "valid-owned",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: 10, y: 100, width: 1, height: 1 }, comment: "Check" },
      }],
      source: [{
        id: "valid-source",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: 10, y: 100, width: 1, height: 1 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.size).toBe(0);
    expect(labels.source.size).toBe(0);
  });

  it("omits labels for invalid annotation geometry with a safe outline", () => {
    const labels = deriveAnnotationOutlineLabels({
      documentGeneration: 4,
      outline: {
        status: "loaded-tree",
        documentGeneration: 4,
        items: [{
          id: "safe",
          label: "Safe",
          pageContext: "Page 1",
          target: {
            documentGeneration: 4,
            pageIndex: 0,
            zoom: { mode: PdfZoomMode.FitPage, params: [] },
            identity: "safe-target",
          },
          children: [],
        }],
      },
      pages: [{ size: { width: 600, height: 800 }, crop: { left: 0, top: 0, bottom: 0 } }],
      owned: [{
        id: "invalid-owned",
        kind: "pageNote",
        pageIndex: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
        updatedAt: "2026-08-11T00:00:00.000Z",
        payload: { position: { x: Number.NaN, y: 1, width: 1, height: 1 }, comment: "Check" },
      }],
      source: [{
        id: "invalid-source",
        subtype: "Highlight",
        pageIndex: 0,
        rect: { x: Number.NaN, y: 1, width: 1, height: 1 },
        contents: "Source",
        author: "Reviewer",
        flags: [],
        appearanceModes: [],
        supportedAppearance: true,
      }],
    });

    expect(labels.owned.size).toBe(0);
    expect(labels.source.size).toBe(0);
  });

  it("suppresses labels until source identity and navigation generation are current", () => {
    const current = {
      sourceIdentity: "new-source",
      activeSourceIdentity: "new-source",
      navigationGeneration: 5,
      outlineGeneration: 5,
    };
    expect(canDeriveAnnotationOutlineLabels(current)).toBe(true);
    expect(canDeriveAnnotationOutlineLabels({
      ...current,
      activeSourceIdentity: "old-source",
    })).toBe(false);
    expect(canDeriveAnnotationOutlineLabels({
      ...current,
      navigationGeneration: 4,
    })).toBe(false);
  });

  it("keeps the ordinary-browser review free of Codex controls or ambient status", () => {
    const state = {
      ...createReviewState({
        sessionId: "00000000-0000-4000-8000-000000000001",
        source: { fileId: "00000000-0000-4000-8000-000000000002", digest: "a".repeat(64), byteLength: 12 },
        sourceRootId: "00000000-0000-4000-8000-000000000003",
      }),
      revision: 1,
      items: [{
        id: "00000000-0000-4000-8000-000000000004", kind: "pageNote" as const, pageIndex: 0,
        createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Fix" },
      }],
    };
    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{ documentTitle: "paper.pdf", sourceRootPath: "/tmp/source" }}
      api={{
        command: vi.fn(),
        saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        scope: vi.fn(),
      }}
      viewer={<div role="application">Real shared PDF viewer</div>}
    />);
    expect(html).toContain("Real shared PDF viewer");
    expect(html).not.toContain("aria-label=\"Actions\"");
    expect(html).toContain('aria-label="Back in document history"');
    expect(html).toContain('aria-label="Forward in document history"');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('aria-label="Redo"');
    expect(html).toContain("paper.pdf, not saved. Open automatic save options");
    expect(html).toContain('data-save-phase="not-saved"');
    expect(html).toContain("Not saved");
    expect(html).not.toContain("Codex");
    expect(html).not.toContain('data-codex-context');
    expect(html).toContain('data-review-item="00000000-0000-4000-8000-000000000004"');
    expect(html).not.toContain("Finish review");
    expect(html).not.toContain("Discard review");
    expect(html).not.toContain("Human delivery");
    expect(html).toContain('data-annotation-drawer');
    expect(html).toContain('Existing annotations are loading');
    expect(html).toContain('data-reference-layout="wide-closed"');
    expect(html).toContain('data-workspace-edge-rail="right"');
    expect(html).not.toContain('data-workspace-edge-rail="bottom"');
    expect(html).toContain('data-workspace-mode="search"');
    expect(html).toContain('aria-label="Search this PDF"');
    expect(html).not.toContain('>Workspace</button>');
    expect(html).not.toContain("delivery-layout");
    expect(html.match(/Real shared PDF viewer/g)).toHaveLength(1);
    expect(html).not.toContain("Submit task");
    expect(html).not.toContain('aria-modal="true" aria-labelledby="finish-review-heading"');
  });

  it("shows passive status only for a trusted Codex launch scope", () => {
    const state = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000011",
      source: { fileId: "00000000-0000-4000-8000-000000000012", digest: "a".repeat(64), byteLength: 12 },
    });
    const api = {
      command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
      chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
      scope: vi.fn(),
    };
    const codex = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{
        documentTitle: "paper.pdf",
        launchSurface: "codex",
        codexContext: { status: "refreshing", placekeeperSessionId: state.sessionId, documentGeneration: 1 },
      }}
      api={api}
      viewer={<div>Viewer</div>}
    />);
    const finder = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: state.sessionId, credential: "secret" }}
      initialState={state}
      scope={{ documentTitle: "paper.pdf", launchSurface: "finder" }}
      api={api}
      viewer={<div>Viewer</div>}
    />);

    expect(codex).toContain('data-codex-context="connecting"');
    expect(codex).toContain("lucide-bot");
    expect(codex).toContain("Agent context updating");
    expect(codex).not.toContain("button>Codex");
    expect(finder).not.toContain('data-codex-context');
    expect(finder).not.toContain("Codex");
  });

  it("renders a previously current Codex identity as refreshing as soon as local review state advances", () => {
    const initial = createReviewState({
      sessionId: "00000000-0000-4000-8000-000000000021",
      source: { fileId: "00000000-0000-4000-8000-000000000022", digest: "a".repeat(64), byteLength: 12 },
    });
    const advanced = { ...initial, revision: 1 };
    const current = {
      status: "current" as const,
      identity: {
        placekeeperSessionId: initial.sessionId,
        documentGeneration: 1,
        source: initial.source,
        reviewRevision: 0,
        stateDigest: "b".repeat(64),
      },
      leaseExpiresAt: "2026-08-12T13:00:00.000Z",
    };
    expect(visibleCodexContext(current, advanced)).toMatchObject({
      status: "refreshing",
      lastVerified: { reviewRevision: 0 },
    });

    const html = renderToStaticMarkup(<ProductionReviewApp
      session={{ sessionId: advanced.sessionId, credential: "secret" }}
      initialState={advanced}
      scope={{ documentTitle: "paper.pdf", launchSurface: "codex", codexContext: current }}
      api={{
        command: vi.fn(), saveStatus: vi.fn(), saveProposal: vi.fn(), chooseCopy: vi.fn(),
        chooseFolder: vi.fn(), chooseOriginal: vi.fn(), retrySave: vi.fn(), locateSave: vi.fn(),
        scope: vi.fn(),
      }}
      viewer={<div>Viewer</div>}
    />);
    expect(html).toContain('data-codex-context="connecting"');
    expect(html).not.toContain('data-codex-context="current"');
  });

  it("uses one clear automatic-save choice surface with the original first", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ filename: "paper-annotated.pdf", folder: "/tmp" }}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("Choose Where to Save Annotations");
    expect(html).toContain('class="save-destination-dialog compact-editorial-modal"');
    expect(html).toContain('compact-editorial-modal__header');
    expect(html).toContain('compact-editorial-modal__body');
    expect(html).toContain('compact-editorial-modal__footer');
    expect(html.indexOf("Modify the original PDF")).toBeLessThan(html.indexOf("Save to a new copy"));
    expect(html).toContain("Confirm");
    expect(html).toContain('class="lucide lucide-x review-icon"');
    expect(html).toContain('class="lucide lucide-check review-icon"');
    expect(html).toContain("You can change this later by clicking the filename.");
    expect(html).not.toContain("Keep annotations in the file you opened.");
    expect(html).not.toContain("Keep the original unchanged.");
  });

  it("keeps recovery actions in the same automatic-save surface", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ filename: "paper-annotated.pdf", folder: "/tmp" }}
      recoveryTarget="paper-annotated.pdf"
      onRetry={vi.fn()}
      onLocate={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("This PDF isn’t up to date");
    expect(html).toContain("Your latest annotations are protected.");
    expect(html).toContain(">Retry</span>");
    expect(html).toContain("Locate PDF…");
    expect(html).toContain('class="lucide lucide-redo2 lucide-redo-2 review-icon"');
    expect(html).toContain('class="lucide lucide-locate-fixed review-icon"');
  });

  it("routes invalid geometry back to annotation correction instead of generic retry", () => {
    const html = renderToStaticMarkup(<SaveDestinationDialog
      open
      proposal={{ filename: "paper-annotated.pdf", folder: "/tmp" }}
      recoveryTarget="paper-annotated.pdf"
      recoveryFailure="invalid-annotation-geometry"
      onRetry={vi.fn()}
      onLocate={vi.fn()}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />);

    expect(html).toContain("An annotation is outside the page");
    expect(html).toContain("Return to annotations");
    expect(html).toContain('class="lucide lucide-arrow-left review-icon"');
    expect(html).not.toContain(">Retry</button>");
  });
});
