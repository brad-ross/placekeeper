import { renderToStaticMarkup } from "react-dom/server";
import { PdfZoomMode } from "@embedpdf/models";
import { describe, expect, it, vi } from "vitest";

import { createReviewState } from "../../../packages/core/src/review-model.js";
import {
  ProductionReviewApp,
  visibleCodexContext,
} from "../src/app/ProductionReviewApp.js";
import { SaveDestinationDialog } from "../src/save/SaveDestinationDialog.js";
import {
  canDeriveAnnotationOutlineLabels,
  deriveAnnotationOutlineLabels,
} from "../src/review/annotation-outline-context.js";

describe("one production review tree", () => {
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
    expect(html).toContain('data-workspace-edge-rail="bottom"');
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
        codexContext: { status: "refreshing", proofreaderSessionId: state.sessionId, documentGeneration: 1 },
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
    expect(codex).toContain("Context connecting");
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
        proofreaderSessionId: initial.sessionId,
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

    expect(html).toContain("Choose where to save annotations");
    expect(html.indexOf("Modify the original PDF")).toBeLessThan(html.indexOf("Save to a new copy"));
    expect(html).toContain("Confirm");
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
    expect(html).toContain(">Retry</button>");
    expect(html).toContain("Locate PDF…");
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
    expect(html).not.toContain(">Retry</button>");
  });
});
