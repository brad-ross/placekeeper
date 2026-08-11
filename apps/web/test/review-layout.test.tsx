import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  controlledWorkspaceSurfaceAction,
  ReviewShell,
  workspaceIsVisible,
} from '../src/app/ReviewShell.js';
import { AnnotationList } from '../src/review/AnnotationList.js';
import { AnnotationPeek } from '../src/review/AnnotationPeek.js';
import { ReviewChrome, validPageNumber } from '../src/review/ReviewChrome.js';
import { ReviewIcon } from '../src/review/ReviewIcon.js';
import type { ViewerControls } from '../src/pdf/viewer-controls.js';
import { createReviewState, type ReviewItem } from '../../../packages/core/src/review-model.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
} from '../src/review/review-surface-state.js';
import {
  createReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
} from '../src/review/reference-workspace-layout.js';

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
  it('synchronizes externally controlled workspace open and hide without disturbing Finish', () => {
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
    expect(controlledWorkspaceSurfaceAction({
      open: true,
      baseSurface: 'finish',
      transientSurface: 'none',
      mode: 'references',
    })).toBeNull();
    expect(workspaceIsVisible(true, 'finish')).toBe(false);
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
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };

  const renderChrome = (pageReady: boolean) => renderToStaticMarkup(
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
      canUndo={false}
      canRedo={false}
      finishOpen={false}
      onUndo={vi.fn()}
      onRedo={vi.fn()}
      onFinish={vi.fn()}
    />,
  );

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

  it('groups document history and edit history in the centered controls with distinct icons', () => {
    const html = renderToStaticMarkup(
      <ReviewChrome
        documentTitle="paper.pdf"
        controls={viewerControls}
        viewerState={viewerControls.snapshot()}
        canUndo
        canRedo
        canNavigateBack
        canNavigateForward
        finishOpen={false}
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        onNavigateBack={vi.fn()}
        onNavigateForward={vi.fn()}
        onFinish={vi.fn()}
      />,
    );
    const centerStart = html.indexOf('aria-label="PDF navigation, zoom, and history"');
    const actionsStart = html.indexOf('aria-label="Review views"');

    expect(centerStart).toBeGreaterThanOrEqual(0);
    for (const label of [
      'Back in document history',
      'Forward in document history',
      'Undo',
      'Redo',
    ]) {
      const control = html.indexOf(`aria-label="${label}"`);
      expect(control).toBeGreaterThan(centerStart);
      expect(control).toBeLessThan(actionsStart);
    }
    expect(html).toMatch(/aria-label="Previous page"[^>]*>.*lucide-chevron-left/u);
    expect(html).toMatch(/data-main-history="back"[^>]*>.*lucide-arrow-left/u);
    expect(html).toMatch(/aria-label="Next page"[^>]*>.*lucide-chevron-right/u);
    expect(html).toMatch(/data-main-history="forward"[^>]*>.*lucide-arrow-right/u);
  });

  it('exposes annotation kind, ownership, and state hooks with a read-only peek', () => {
    const listHtml = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        activeId={ownedAnnotation.id}
        correspondingId={ownedAnnotation.id}
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
    expect(peekHtml).toContain('data-annotation-origin="owned"');
    expect(peekHtml).toContain('data-annotation-kind="highlight"');
    expect(peekHtml).toContain('Clarify the identifying variation behind this claim.');
    expect(peekHtml).not.toContain('Page 4');
    expect(peekHtml).not.toContain('<button');
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
    expect(html).toContain('aria-label="All annotations"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-workspace-open="false"');
    expect(html).toContain('data-review-chrome');
    expect(html).toContain('data-review-file-badge');
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
    expect(html).toContain('Finish');
    expect(html).toContain('aria-label="Undo"');
    expect(html).toContain('aria-label="Redo"');
    expect(html).toMatch(/data-main-history="back"[^>]*aria-label="Back in document history"[^>]*disabled=""/u);
    expect(html).toMatch(/data-main-history="forward"[^>]*aria-label="Forward in document history"[^>]*disabled=""/u);
    expect(html.match(/data-main-history=/g)).toHaveLength(2);
    expect(html).not.toContain('aria-label="Workspace (0 annotations)"');
    expect(html).toContain('data-workspace-edge-rail="right"');
    expect(html).toContain('data-workspace-edge-rail="bottom"');
    expect(html).toContain('class="review-workspace__title">References</strong>');
    expect(html).toContain('aria-label="Move References to right"');
    expect(html).toMatch(/id="workspace-panel-references"[^>]*role="tabpanel"/u);
    expect(html).toMatch(/id="workspace-panel-annotations"[^>]*hidden=""[^>]*inert=""/u);
    expect(html).toContain('id="review-annotation-list"');
    expect(html).toContain('data-review-workspace');
    expect(html).toContain('data-annotation-drawer');
    expect(html).not.toContain('aria-label="Close annotations"');
    expect(html).not.toContain('aria-label="Close workspace"');
    expect(html).toContain('class="annotation-drawer__header"');
    expect(html).toContain('aria-label="Owned annotations"');
    expect(html).toContain('aria-label="Existing PDF annotations"');
    expect(html).toContain('data-existing-annotations-state="loading"');
    expect(html).toContain('data-annotation-status="loading"');
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
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      ><div>Document canvas</div></ReviewShell>,
    );
    expect(html).toContain('data-reference-layout="wide-split"');
    expect(html).toContain('aria-label="Outline, search, and annotations"');
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

  it('uses only the right rail and controls the combined surface when References is right-docked', () => {
    let layout = createReferenceWorkspaceLayout({ width: 1440, height: 900 });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'show-references' });
    layout = reduceReferenceWorkspaceLayout(layout, { type: 'move-references-right' });
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        referenceLayoutState={layout}
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
    expect(html).not.toContain('aria-label="Edit Highlight on page 2"');
    expect(html).not.toContain('aria-label="Delete Highlight on page 2"');
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

  it('matches the page editor to coarse-pointer control height', () => {
    const coarsePointerRules = responsiveStyles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/u,
    )?.[1];

    expect(coarsePointerRules).toMatch(
      /\.review-chrome__page-editor \{\s*min-height: var\(--review-control-touch\);\s*\}/u,
    );
    expect(coarsePointerRules).toMatch(
      /\.review-chrome__page-input \{\s*height: var\(--review-control-touch\);\s*\}/u,
    );
  });
});
