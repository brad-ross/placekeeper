import { readFileSync } from 'node:fs';

import { PdfZoomMode } from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  controlledWorkspaceSurfaceAction,
  ReviewShell,
  workspaceIsVisible,
} from '../src/app/ReviewShell.js';
import { AnnotationList } from '../src/review/AnnotationList.js';
import { AnnotationPeek } from '../src/review/AnnotationPeek.js';
import {
  ReviewChrome,
  resolveZoomDraft,
  validPageNumber,
  validZoomPercent,
  zoomEditorKeyAction,
} from '../src/review/ReviewChrome.js';
import { ReviewIcon } from '../src/review/ReviewIcon.js';
import {
  ROW_ACTION_CONTAINER_NAME,
  ROW_ACTION_DIRECT_BREAKPOINT_PX,
} from '../src/review/RowActionGroup.js';
import {
  VIEWER_ZOOM_MAX_PERCENT,
  VIEWER_ZOOM_MIN_PERCENT,
  type ViewerControls,
} from '../src/pdf/viewer-controls.js';
import { createReviewState, type ReviewItem } from '../../../packages/core/src/review-model.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
} from '../src/review/review-surface-state.js';
import {
  createReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
} from '../src/review/reference-workspace-layout.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
} from '../src/review/reference-navigation-state.js';

const state = createReviewState({
  sessionId: 'layout-test',
  source: { fileId: 'file', digest: 'a'.repeat(64), byteLength: 10 },
});

const responsiveStyles = readFileSync(
  new URL('../src/app/review-layout-responsive.css', import.meta.url),
  'utf8',
);
const annotationStyles = readFileSync(
  new URL('../src/app/review-layout-annotations.css', import.meta.url),
  'utf8',
);

const ownedAnnotation: ReviewItem = {
  id: 'owned-highlight',
  kind: 'highlight',
  pageIndex: 3,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  payload: { comment: 'Clarify the identifying variation behind this claim.' },
};

describe('review shell layout and accessibility contract', () => {
  it('switches row actions at one shared geometry-derived container boundary', () => {
    const below = ROW_ACTION_DIRECT_BREAKPOINT_PX - 1;
    const above = ROW_ACTION_DIRECT_BREAKPOINT_PX + 1;

    expect(below).toBe(271);
    expect(above).toBe(273);
    expect(annotationStyles).toContain(`container-name: ${ROW_ACTION_CONTAINER_NAME}`);
    expect(annotationStyles).toContain(
      `@container ${ROW_ACTION_CONTAINER_NAME} (max-width: ${ROW_ACTION_DIRECT_BREAKPOINT_PX}px)`,
    );
    expect(annotationStyles).toMatch(
      /@container row-actions \(max-width: 272px\) \{[\s\S]*?\.row-action-group__direct\s*\{[^}]*display:\s*none;[\s\S]*?\.row-action-group__secondary\s*\{[^}]*display:\s*block;/u,
    );
    const coarsePointerRules = responsiveStyles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*)\n\}/u,
    )?.[1] ?? '';
    expect(coarsePointerRules).toMatch(/\.row-action-group__direct\s*\{[^}]*display:\s*none;/u);
    expect(coarsePointerRules).toMatch(/\.row-action-group__secondary\s*\{[^}]*display:\s*block;/u);
    expect(annotationStyles).toMatch(
      /\.row-action-group__trigger\s*\{[^}]*width:\s*var\(--review-control-touch\);[^}]*min-height:\s*var\(--review-control-touch\);/u,
    );
  });

  it('synchronizes externally controlled workspace open and hide', () => {
    const openedAction = controlledWorkspaceSurfaceAction({
      open: true,
      baseSurface: 'reading',
      transientSurface: 'page-menu',
      mode: 'references',
    });
    expect(openedAction).toEqual({ type: 'open-workspace', mode: 'references' });
    const opened = reduceReviewSurface(INITIAL_REVIEW_SURFACE_STATE, openedAction!);
    expect(opened).toMatchObject({ baseSurface: 'workspace', transientSurface: 'none' });

    const hiddenAction = controlledWorkspaceSurfaceAction({
      open: false,
      baseSurface: opened.baseSurface,
      transientSurface: opened.transientSurface,
      mode: 'references',
    });
    expect(reduceReviewSurface(opened, hiddenAction!)).toMatchObject({
      baseSurface: 'reading',
      transientSurface: 'none',
    });
    expect(workspaceIsVisible(true, 'workspace')).toBe(true);
  });

  it('keeps selection actions available beside an externally opened workspace', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        workspaceOpen
        selectionUpdate={{
          kind: 'reliable', generation: 1,
          anchor: {
            pageIndex: 0, quote: 'text', prefix: '', suffix: '', reliable: true,
            rect: { x: 1, y: 1, width: 2, height: 2 },
            segmentRects: [{ x: 1, y: 1, width: 2, height: 2 }],
          },
        }}
        selectionPlacement={{ left: 10, top: 10 }}
        pageMenu={{
          invocationId: 'menu', placement: { left: 10, top: 10 }, pageIndex: 0,
          position: { x: 1, y: 1, width: 2, height: 2 },
        }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );
    expect(html).toContain('data-tools-workspace-open="true"');
    expect(html).toContain('aria-label="Selection review actions"');
    expect(html).not.toContain('aria-label="Page actions"');
  });

  it('yields the modal layer to save options without unmounting nested review state', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        saveOptionsOpen
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toMatch(/data-review-nested-host="true" hidden="" inert=""/u);
  });
  const viewerControls: ViewerControls = {
    snapshot: () => ({
      ready: true,
      pageReady: true,
      zoomReady: true,
      currentPage: 3,
      totalPages: 12,
      zoomPercent: 100,
    }),
    previousPage: vi.fn(),
    nextPage: vi.fn(),
    goToPage: vi.fn(),
    zoomOut: vi.fn(),
    zoomIn: vi.fn(),
    zoomToPercent: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };

  const renderChrome = (pageReady: boolean, fitWidthReady = false) => renderToStaticMarkup(
    <ReviewChrome
      documentTitle="paper.pdf"
      controls={viewerControls}
      viewerState={pageReady ? viewerControls.snapshot() : {
        ready: false,
        pageReady: false,
        zoomReady: false,
        currentPage: 0,
        totalPages: 0,
        zoomPercent: 0,
        pageUnavailableReason: 'Page controls become available when PDF navigation is ready.',
        zoomUnavailableReason: 'Zoom controls become available when PDF zoom is ready.',
      }}
      fitWidthReady={fitWidthReady}
      canUndo={false}
      canRedo={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
    />,
  );

  it('places the document Copy Link control beside the file title', () => {
    const html = renderToStaticMarkup(
      <ReviewChrome
        documentTitle="paper.pdf"
        controls={viewerControls}
        viewerState={viewerControls.snapshot()}
        copyLink={{
          getLink: () => 'placekeeper:///tmp/paper.pdf#v=1&page=1',
          writeText: async () => undefined,
        }}
        canUndo={false}
        canRedo={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
      />,
    );
    const identityStart = html.indexOf('class="review-chrome__identity"');
    const copyLink = html.indexOf('data-review-copy-link');
    const viewerControlsIndex = html.indexOf('class="review-chrome__viewer-controls"');
    const trailingActions = html.indexOf('class="review-chrome__actions"');

    expect(identityStart).toBeGreaterThanOrEqual(0);
    expect(copyLink).toBeGreaterThan(identityStart);
    expect(copyLink).toBeLessThan(viewerControlsIndex);
    expect(trailingActions).toBeGreaterThan(viewerControlsIndex);
    expect(html.slice(trailingActions)).not.toContain('data-review-copy-link');
  });

  it('keeps review icons decorative and button labels authoritative', () => {
    const html = renderToStaticMarkup(
      <button type="button" aria-label="Previous page">
        <ReviewIcon name="chevron-left" />
      </button>,
    );

    expect(html).toContain('aria-label="Previous page"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('focusable="false"');
    expect(html).toMatch(/class="[^"]*review-icon[^"]*"/);
  });

  it('groups edit history, document navigation, and zoom in task order', () => {
    const html = renderToStaticMarkup(
      <ReviewChrome
        documentTitle="paper.pdf"
        controls={viewerControls}
        viewerState={viewerControls.snapshot()}
        canUndo
        canRedo
        canNavigateBack
        canNavigateForward
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onNavigateBack={vi.fn()}
        onNavigateForward={vi.fn()}
      />,
    );
    const centerStart = html.indexOf('aria-label="PDF editing, navigation, and zoom"');
    const editGroup = html.indexOf('aria-label="Edit history"');
    const navigationGroup = html.indexOf('aria-label="Document navigation"');
    const zoomGroup = html.indexOf('aria-label="PDF zoom"');

    expect(centerStart).toBeGreaterThanOrEqual(0);
    const orderedControls = [
      editGroup,
      html.indexOf('aria-label="Undo"'),
      html.indexOf('aria-label="Redo"'),
      navigationGroup,
      html.indexOf('aria-label="Back in document history"'),
      html.indexOf('aria-label="Forward in document history"'),
      html.indexOf('aria-label="Previous page"'),
      html.indexOf('aria-label="Current page 3 of 12. Enter a page number"'),
      html.indexOf('aria-label="Next page"'),
      zoomGroup,
      html.indexOf('aria-label="Zoom out"'),
      html.indexOf('aria-label="Zoom in"'),
      html.indexOf('aria-label="Zoom level"'),
      html.indexOf('aria-label="Fit PDF to available width"'),
    ];
    for (const [index, control] of orderedControls.entries()) {
      expect(control).toBeGreaterThan(index === 0 ? centerStart : orderedControls[index - 1]!);
    }
    expect(html).not.toContain('aria-label="Actions"');
    expect(html).toMatch(/aria-label="Previous page"[^>]*>.*lucide-chevron-left/u);
    expect(html).toMatch(/data-main-history="back"[^>]*>.*lucide-arrow-left/u);
    expect(html).toMatch(/aria-label="Next page"[^>]*>.*lucide-chevron-right/u);
    expect(html).toMatch(/data-main-history="forward"[^>]*>.*lucide-arrow-right/u);
  });

  it('exposes annotation kind, ownership, and state hooks with a read-only peek', () => {
    const listHtml = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        sectionLabels={new Map([[ownedAnnotation.id, 'Methods and data']])}
        activeId={ownedAnnotation.id}
        correspondingId={ownedAnnotation.id}
        onNavigate={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const unsectionedListHtml = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        onNavigate={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const peekHtml = renderToStaticMarkup(
      <AnnotationPeek
        item={ownedAnnotation}
        onHoldChange={() => undefined}
      />,
    );

    expect(listHtml).toContain('data-annotation-origin="owned"');
    expect(listHtml).toContain('data-annotation-kind="highlight"');
    expect(listHtml).toContain('data-annotation-state="active-corresponding"');
    expect(listHtml).toContain('<span class="annotation-item__separator">·</span><span class="annotation-item__page">4</span>');
    expect(listHtml).toContain('class="annotation-item__section" title="Methods and data">Methods and data</span>');
    expect(listHtml).toContain('aria-label="Highlight · Page 4 · Methods and data · Clarify the identifying variation behind this claim."');
    expect(listHtml).not.toContain('>Page 4<');
    expect(unsectionedListHtml).not.toContain('annotation-item__section');
    expect(unsectionedListHtml.match(/annotation-item__separator/gu)).toHaveLength(1);
    expect(peekHtml).toContain('data-annotation-origin="owned"');
    expect(peekHtml).toContain('data-annotation-kind="highlight"');
    expect(peekHtml).toContain('Clarify the identifying variation behind this claim.');
    expect(peekHtml).not.toContain('Page 4');
    expect(peekHtml).not.toContain('<button');
  });

  it('offers an exact-item Copy Link action only for a portable saved annotation', () => {
    const copyLink = {
      getLink: () => 'placekeeper:///tmp/Paper.pdf#v=1&page=4&item=00000000-0000-4000-8000-000000000004',
      writeText: async () => undefined,
    };
    const copyableList = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        copyLinkForItem={() => copyLink}
        onNavigate={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const pageOnlyList = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        onNavigate={() => undefined}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    );
    const copyablePeek = renderToStaticMarkup(
      <AnnotationPeek item={ownedAnnotation} copyLink={copyLink} onHoldChange={() => undefined} />,
    );

    expect(copyableList).toContain('data-item-copy-link="true"');
    expect(copyableList).toContain('aria-label="Copy link to Highlight annotation on page 4"');
    expect(copyablePeek).toContain('aria-label="Copy link to Highlight annotation on page 4"');
    expect(pageOnlyList).toContain('data-item-copy-link="false"');
    expect(pageOnlyList).not.toContain('data-annotation-action="copy-link"');
  });

  it('exposes keyboard-equivalent controls, live status, and state-preserving drawer semantics', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        documentTitle="paper.pdf"
        selectionUpdate={{
          kind: 'reliable',
          generation: 0,
          anchor: {
            pageIndex: 0,
            quote: 'text',
            prefix: '',
            suffix: '',
            rect: { x: 10, y: 10, width: 20, height: 10 },
            segmentRects: [{ x: 10, y: 10, width: 20, height: 10 }],
            reliable: true,
          },
        }}
        selectionPlacement={{ left: 20, top: 30, suggestTop: true }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Selection review actions"');
    expect(html).toContain('aria-keyshortcuts="Alt+Shift+H"');
    expect(html).not.toContain('aria-label="All annotations"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-workspace-open="false"');
    expect(html).toContain('data-review-chrome');
    expect(html).toContain('review-chrome__save-identity');
    expect(html).toContain('data-review-saved-status');
    expect(html).toContain('data-review-stat');
    expect(html).not.toContain('data-review-count');
    expect(html).toContain('paper.pdf');
    expect(html).toContain('data-review-contextual-host');
    expect(html).toContain('data-review-drawer-host');
    expect(html).toContain('data-workspace-presentation="right"');
    expect(html).toContain('--workspace-side-width:0px');
    expect(html).toContain('data-review-nested-host');
    expect(html.match(/Document canvas/g)).toHaveLength(1);
    expect(html).not.toContain('Codex');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('aria-label="Redo"');
    expect(html).toMatch(/data-main-history="back"[^>]*aria-label="Back in document history"[^>]*disabled=""/u);
    expect(html).toMatch(/data-main-history="forward"[^>]*aria-label="Forward in document history"[^>]*disabled=""/u);
    expect(html.match(/data-main-history=/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="Workspace (0 annotations)"');
    expect(html).toContain('data-workspace-edge-rail="right"');
    expect(html).not.toContain('data-workspace-edge-rail="bottom"');
    expect(html).toContain('class="review-workspace__activity-strip"');
    expect(html).toContain('data-workspace-mode-count="2"');
    expect(html).not.toContain('data-workspace-mode-label="references"');
    expect(html).not.toContain('aria-label="Move References to right"');
    expect(html).not.toContain('id="workspace-panel-references"');
    expect(html).not.toContain('id="workspace-panel-annotations"');
    expect(html).not.toContain('id="review-annotation-list"');
    expect(html).toContain('data-review-workspace');
    expect(html).toContain('data-annotation-drawer');
    expect(html).not.toContain('aria-label="Close annotations"');
    expect(html).not.toContain('aria-label="Close workspace"');
    expect(html).not.toContain('class="annotation-drawer__header"');
    expect(html).not.toContain('aria-label="Owned annotations"');
    expect(html).not.toContain('aria-label="External Annotations (read only)"');
    expect(html).not.toContain('data-existing-annotations-state="loading"');
    expect(html).not.toContain('data-annotation-status="loading"');
    for (const tool of ['Replace', 'Delete', 'Highlight']) {
      expect(html).toContain(`aria-label="${tool}"`);
      expect(html).toContain(`title="${tool}"`);
    }
    expect(html.match(/review-action-button--icon/g)).toHaveLength(3);
    expect(html).not.toMatch(/<\/svg>(?:Replace|Delete|Highlight)<\/button>/u);
    expect(html.match(/class="[^"]*review-action-button[^"]*"/g)).toHaveLength(3);
    expect(html).not.toMatch(/>(?:‹|›|−|\+|↶|↷)<\/button>/u);
    expect(html).not.toContain('>Insert</button>');
    expect(html).not.toContain('>Page Note</button>');
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('Proofread mode');
  });

  it('tiles wide tools above one independent References surface', () => {
    let layout = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'show-references' });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'show-right-workspace' });
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        referenceLayoutState={layout}
        referenceTabs={[{ identity: 'reference', label: 'Reference', pageContext: 'Page 2' }]}
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      ><div>Document canvas</div></ReviewShell>,
    );
    expect(html).toContain('data-reference-layout="wide-split"');
    expect(html).toContain('aria-label="Outline and search"');
    expect(html).toContain('aria-label="References"');
    expect(html.match(/data-reference-viewport-host/g)).toHaveLength(1);
    expect(html.match(/id="workspace-panel-references"/g)).toHaveLength(1);
  });

  it('uses the effective clamped bottom boundary without erasing the remembered height', () => {
    let layout = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    layout = reduceReferenceWorkspaceLayout(layout, {
      type: 'resize-bottom-references', size: 510,
    });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'show-references' });
    layout = reduceReferenceWorkspaceLayout(layout, {
      type: 'set-stage-size', width: 1440, height: 500,
    });

    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        referenceLayoutState={layout}
        referenceTabs={[{ identity: 'reference', label: 'Reference', pageContext: 'Page 2' }]}
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      ><div>Document canvas</div></ReviewShell>,
    );

    expect(layout.bottomReferenceHeight).toBe(510);
    expect(html).toContain('--reference-bottom-height:308px');
    expect(html).not.toContain('--reference-bottom-height:510px');
  });

  it('lets full-state bottom References panels occupy both vertical-grid columns', () => {
    expect(annotationStyles).toMatch(
      /\[data-reference-panel-layout="full"\]\s*>\s*\.reference-panel\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/u,
    );
  });

  it('threads the active Reference return control through the shell without changing viewer layout', () => {
    const originalTarget = {
      documentGeneration: 4,
      pageIndex: 17,
      zoom: { mode: PdfZoomMode.XYZ, params: [12, 700, 1] },
      identity: 'lemma-origin',
    };
    const settledLocation = {
      pageIndex: 18,
      anchor: { x: 12, y: 640 },
      alignment: { xPercent: 50, yPercent: 35 },
      zoom: 1,
    };
    const navigationState = reduceReferenceNavigation(
      createReferenceNavigationState(4),
      { type: 'open-reference', target: originalTarget, settledLocation },
    );
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        workspaceOpen
        navigationState={navigationState}
        referenceReturn={{ tabIdentity: 'lemma-origin', available: true, pending: false }}
        onReferenceReturn={() => undefined}
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      ><div>Document canvas</div></ReviewShell>,
    );

    expect(html.match(/data-reference-return=/g)).toHaveLength(1);
    expect(html).toMatch(/data-reference-return="lemma-origin"[\s\S]*data-reference-viewport-host/u);
    expect(html.match(/data-reference-viewport-host/g)).toHaveLength(1);
  });

  it('keeps the Reference return overlay out of grid sizing and enlarges only its coarse target', () => {
    expect(annotationStyles).toMatch(
      /\.reference-panel\s*\{[^}]*position:\s*relative;[^}]*isolation:\s*isolate;/u,
    );
    expect(annotationStyles).toMatch(
      /\.reference-panel__return\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*2;[^}]*top:\s*12px;[^}]*left:\s*12px;[^}]*inline-size:\s*var\(--review-control-compact\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.reference-panel__return:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--review-focus\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.reference-panel__return:hover:not\(\[aria-disabled="true"\]\)/u,
    );
    expect(annotationStyles).toMatch(
      /\.reference-panel__return\[aria-disabled="true"\]\s*\{[^}]*cursor:\s*wait;/u,
    );
    expect(annotationStyles).not.toMatch(
      /\.reference-panel__return\s*\{[^}]*(?:grid-area|margin-bottom|height:\s*100%)/u,
    );
    const coarsePointerRules = responsiveStyles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(coarsePointerRules).toMatch(
      /\.reference-panel__return\s*\{[^}]*inline-size:\s*var\(--review-control-touch\);[^}]*min-height:\s*var\(--review-control-touch\);/u,
    );
  });

  it('shares simple annotation section headers and keeps the activity strip intrinsic', () => {
    expect(annotationStyles).toMatch(
      /\.annotation-drawer__header h2,\s*\.existing-annotations__header h2\s*\{[^}]*font-size:\s*15px;[^}]*font-weight:\s*760;/u,
    );
    expect(annotationStyles).toMatch(
      /\.annotation-drawer__header,\s*\.existing-annotations__header\s*\{[^}]*margin-bottom:\s*10px;/u,
    );
    expect(annotationStyles).not.toContain('--annotation-drawer-header-height');
    expect(annotationStyles).not.toMatch(/\.annotation-drawer__header\s*\{[^}]*position:\s*sticky;/u);
    expect(annotationStyles).not.toContain('grid-auto-columns');
    expect(annotationStyles).not.toContain('grid-auto-flow');
    expect(annotationStyles).not.toContain('.review-tools-workspace .review-workspace__tabs');
    expect(annotationStyles).toMatch(
      /\.review-workspace__activity-strip\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__mode-tab\s*\{[^}]*width:\s*var\(--review-control-compact\);[^}]*flex:\s*0 0 var\(--review-control-compact\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__mode-label\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__mode-segment--compound::before\s*\{[^}]*border:\s*1px\s+solid\s+var\(--review-border\);[^}]*border-radius:\s*var\(--review-radius-control\);[^}]*background:\s*var\(--review-surface-panel\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__mode-segment--compound\s*>\s*\.review-workspace__mode-tab\[aria-selected="true"\]\s*\{[^}]*padding-right:\s*2px;[^}]*border-color:\s*transparent;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__activity-strip--compound\s*>\s*\.review-workspace__move--activity\s*\{[^}]*border-color:\s*transparent;[^}]*border-radius:\s*var\(--review-radius-control\);[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__activity-strip--compound\s*>\s*\.review-workspace__move--activity:hover\s*\{[^}]*border-color:\s*var\(--review-border-strong\);[^}]*background:\s*var\(--review-surface-interactive\);/u,
    );
    expect(annotationStyles).toContain('height: var(--review-workspace-header-height, 44px)');
    expect(annotationStyles).toContain('margin-top: var(--review-workspace-header-height, 44px)');
    expect(annotationStyles).toContain(
      'top: calc(var(--review-workspace-header-height, 44px) / 2)',
    );
    expect(annotationStyles).not.toContain('margin-top: 53px');
    expect(annotationStyles).not.toContain('review-workspace__tab-segment--compound');
    expect(annotationStyles).not.toContain('.existing-annotations__readonly');
  });

  it('uses only the right rail and controls the combined surface when References is right-docked', () => {
    let layout = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'show-references' });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'move-references-right' });
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        referenceLayoutState={layout}
        referenceTabs={[{ identity: 'reference', label: 'Reference', pageContext: 'Page 2' }]}
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      ><div>Document canvas</div></ReviewShell>,
    );

    expect(html).toContain('data-reference-layout="wide-right"');
    expect(html.match(/data-workspace-edge-rail="right"/g)).toHaveLength(1);
    expect(html).not.toContain('data-workspace-edge-rail="bottom"');
    expect(html).toContain('aria-controls="review-workspace review-tools-workspace"');
  });

  it('keeps source annotations explicitly read-only and distinct from owned rows', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        documentTitle="paper.pdf"
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        existingAnnotations={{
          status: 'ready',
          generation: 1,
          items: [{
            id: 'source-highlight',
            subtype: 'Highlight',
            pageIndex: 1,
            rect: { x: 1, y: 2, width: 3, height: 4 },
            contents: 'Source-only comment',
            author: 'Reviewer',
            flags: [],
            appearanceModes: ['normal'],
            supportedAppearance: true,
          }],
        }}
        annotationOutlineLabels={{
          owned: new Map(),
          source: new Map([['1:source-highlight', 'Methods and data']]),
        }}
        outlineDiscovery={{
          status: 'loaded-tree',
          documentGeneration: 0,
          items: [{
            id: 'outline-0',
            label: 'Methods and data',
            pageContext: null,
            target: null,
            children: [],
          }],
        }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('data-existing-annotations-state="ready"');
    expect(html).toContain('data-annotation-origin="source"');
    expect(html).toContain('data-annotation-kind="Highlight"');
    expect(html).toContain('data-annotation-state="readonly"');
    expect(html).toContain('data-readonly="true"');
    expect(html).toContain('class="annotation-item__section" title="Methods and data">Methods and data</span>');
    expect(html).toContain('aria-label="Highlight · Page 2 · Methods and data · Source-only comment"');
    expect(html).not.toContain('>Page 2<');
    expect(html).not.toContain('aria-label="Edit Highlight on page 2"');
    expect(html).not.toContain('aria-label="Delete Highlight on page 2"');
    expect(html).toContain('id="workspace-mode-annotations"');
  });

  it('omits the Annotations mode and panel when owned and source annotations are empty', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        documentTitle="paper.pdf"
        workspaceOpen
        outlineDiscovery={{ status: 'loaded-empty', documentGeneration: 0 }}
        rightWorkspaceMode="annotations"
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        existingAnnotations={{ status: 'empty', generation: 1, items: [] }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).not.toContain('aria-label="Owned annotations"');
    expect(html).not.toContain('aria-label="External Annotations (read only)"');
    expect(html).not.toContain('data-existing-annotations-state');
    expect(html).not.toContain('No existing annotations.');
    expect(html).not.toContain('id="workspace-mode-annotations"');
    expect(html).not.toContain('id="workspace-panel-annotations"');
    expect(html).toMatch(/id="workspace-mode-search"[^>]*aria-selected="true"/u);
  });

  it('keeps populated Annotations available and suppresses injected outline context for an empty outline', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={{ ...state, items: [ownedAnnotation] }}
        workspaceOpen
        outlineDiscovery={{ status: 'loaded-empty', documentGeneration: 0 }}
        rightWorkspaceMode="outline"
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        existingAnnotations={{
          status: 'ready',
          generation: 1,
          items: [{
            id: 'source-highlight',
            subtype: 'Highlight',
            pageIndex: 1,
            rect: { x: 1, y: 2, width: 3, height: 4 },
            contents: 'Source-only comment',
            author: 'Reviewer',
            flags: [],
            appearanceModes: ['normal'],
            supportedAppearance: true,
          }],
        }}
        annotationOutlineLabels={{
          owned: new Map([['owned-highlight', 'Methods and data']]),
          source: new Map([['1:source-highlight', 'Methods and data']]),
        }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).not.toContain('id="workspace-mode-outline"');
    expect(html).not.toContain('id="workspace-panel-outline"');
    expect(html).toContain('id="workspace-mode-annotations"');
    expect(html).toMatch(/id="workspace-mode-search"[^>]*aria-selected="true"/u);
    expect(html).not.toContain('Methods and data');
    expect(html).toContain('<h2>Annotations ');
    expect(html).toContain('<h2>External Annotations (read only)</h2>');
    expect(html).not.toContain('Review comments');
    expect(html).not.toContain('Source PDF');
    expect(html).not.toContain('existing-annotations__readonly');
  });

  it('does not hide Outline for a stale empty result from another document generation', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        workspaceOpen
        outlineDiscovery={{ status: 'loaded-empty', documentGeneration: -1 }}
        annotationOutlineLabels={{
          owned: new Map([['owned-highlight', 'Stale section']]),
          source: new Map(),
        }}
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('id="workspace-mode-outline"');
    expect(html).toContain('id="workspace-panel-outline"');
    expect(html).not.toContain('Stale section');
  });

  it('fails viewer controls safely when capabilities are absent', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        documentTitle="paper.pdf"
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('Page controls become available when PDF navigation is ready.');
    expect(html).toContain('Zoom controls become available when PDF zoom is ready.');
    expect(html).toMatch(/aria-label="Previous page"[^>]*disabled=""/);
    expect(html).toMatch(/aria-label="Zoom in"[^>]*disabled=""/);
  });

  it('keeps unavailable page status noneditable with its existing description', () => {
    const html = renderChrome(false);

    expect(html).toContain('aria-label="Current page"');
    expect(html).toContain('>— / —</span>');
    expect(html).not.toContain('aria-label="Page number"');
    expect(html).not.toContain('review-chrome__page-trigger');
    expect(html).toContain('Page controls become available when PDF navigation is ready.');
  });

  it('renders the ready current page as an activation control with numeric metadata and visible total', () => {
    const html = renderChrome(true);

    expect(html).toContain('class="review-chrome__page-trigger review-chrome__stat"');
    expect(html).toContain('aria-label="Current page 3 of 12. Enter a page number"');
    expect(html).toContain('>3<span aria-hidden="true"> / 12</span></button>');
    expect(html).not.toContain('aria-label="Page number"');
  });

  it('accepts only whole one-based page numbers within the latest total', () => {
    expect(validPageNumber('1', 12)).toBe(1);
    expect(validPageNumber(' 12 ', 12)).toBe(12);
    expect(validPageNumber('0', 12)).toBeUndefined();
    expect(validPageNumber('13', 12)).toBeUndefined();
    expect(validPageNumber('1.5', 12)).toBeUndefined();
    expect(validPageNumber('1e1', 12)).toBeUndefined();
    expect(validPageNumber('', 12)).toBeUndefined();
  });

  it('renders ready zoom as an editable percentage beside a semantic Fit Width action', () => {
    const html = renderChrome(true, true);

    const zoomOutIndex = html.indexOf('aria-label="Zoom out"');
    const zoomInIndex = html.indexOf('aria-label="Zoom in"');
    const zoomLevelIndex = html.indexOf('aria-label="Zoom level"');
    const fitWidthIndex = html.indexOf('aria-label="Fit PDF to available width"');

    expect(html).toContain('class="review-chrome__zoom-trigger review-chrome__stat"');
    expect(html).toContain('class="review-chrome__zoom-control" data-review-stat="true" aria-label="Zoom level"');
    expect(html).toContain('aria-label="Current zoom 100 percent. Enter a zoom percentage"');
    expect(html).toContain('>100<span aria-hidden="true">%</span></button>');
    expect(html).not.toContain('aria-label="Zoom percentage"');
    expect(html).toMatch(
      /aria-label="Fit PDF to available width"[^>]*>.*lucide-move-horizontal/u,
    );
    expect(html).not.toMatch(/aria-label="Fit PDF to available width"[^>]*disabled=""/u);
    expect(html.match(/data-review-zoom-action=/g)).toHaveLength(3);
    expect(zoomOutIndex).toBeLessThan(zoomInIndex);
    expect(zoomInIndex).toBeLessThan(zoomLevelIndex);
    expect(zoomLevelIndex).toBeLessThan(fitWidthIndex);
  });

  it('accepts only whole zoom percentages within the configured viewer limits', () => {
    expect(validZoomPercent(String(VIEWER_ZOOM_MIN_PERCENT))).toBe(VIEWER_ZOOM_MIN_PERCENT);
    expect(validZoomPercent(' 125 ')).toBe(125);
    expect(validZoomPercent(String(VIEWER_ZOOM_MAX_PERCENT))).toBe(VIEWER_ZOOM_MAX_PERCENT);
    expect(validZoomPercent(String(VIEWER_ZOOM_MIN_PERCENT - 1))).toBeUndefined();
    expect(validZoomPercent(String(VIEWER_ZOOM_MAX_PERCENT + 1))).toBeUndefined();
    expect(validZoomPercent('125.5')).toBeUndefined();
    expect(validZoomPercent('1e2')).toBeUndefined();
    expect(validZoomPercent('Infinity')).toBeUndefined();
    expect(validZoomPercent('')).toBeUndefined();
  });

  it('resolves changed drafts without turning an unchanged rounded display into a request', () => {
    expect(resolveZoomDraft('125', 100)).toEqual({ valid: true, request: 125 });
    expect(resolveZoomDraft('100', 100)).toEqual({ valid: true });
    expect(resolveZoomDraft('100.5', 100)).toEqual({ valid: false });
  });

  it('ignores editor shortcuts during IME composition', () => {
    expect(zoomEditorKeyAction('Enter', false)).toBe('submit');
    expect(zoomEditorKeyAction('Escape', false)).toBe('cancel');
    expect(zoomEditorKeyAction('Enter', true)).toBeUndefined();
    expect(zoomEditorKeyAction('Escape', true)).toBeUndefined();
    expect(zoomEditorKeyAction('ArrowUp', false)).toBeUndefined();
  });

  it('keeps unavailable zoom noneditable and disables every zoom action with one explanation', () => {
    const html = renderChrome(false);

    expect(html).toContain('aria-label="Zoom level">—%</span>');
    expect(html).not.toContain('review-chrome__zoom-trigger');
    expect(html).not.toContain('aria-label="Zoom percentage"');
    for (const label of ['Zoom out', 'Zoom in', 'Fit PDF to available width']) {
      expect(html).toMatch(
        new RegExp(`aria-label="${label}"[^>]*aria-describedby="viewer-zoom-controls-readiness"[^>]*disabled=""`),
      );
    }
    expect(html).toContain('Zoom controls become available when PDF zoom is ready.');
  });

  it('matches the page editor to coarse-pointer control height', () => {
    const coarsePointerRules = responsiveStyles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/u,
    )?.[1];

    expect(coarsePointerRules).toMatch(
      /\.review-chrome__page-editor,\s*\.review-chrome__zoom-editor \{\s*min-height: var\(--review-control-touch\);\s*\}/u,
    );
    expect(coarsePointerRules).toMatch(
      /\.review-chrome__page-input,\s*\.review-chrome__zoom-input \{\s*height: var\(--review-control-touch\);\s*\}/u,
    );
  });
});
