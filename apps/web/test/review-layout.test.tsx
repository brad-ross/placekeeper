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
  FullAnnotationReader,
  FullAnnotationReaderActions,
} from '../src/review/FullAnnotationReader.js';
import {
  ReviewChrome,
  resolveTopBarMenuRequest,
  resolveZoomDraft,
  validPageNumber,
  validZoomPercent,
  zoomEditorKeyAction,
} from '../src/review/ReviewChrome.js';
import { DocumentActionsMenu } from '../src/review/DocumentActionsMenu.js';
import {
  enabledMenuItems,
  menuRovingFocusIndex,
} from '../src/review/menu-focus.js';
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

const generatedState = createReviewState({
  sessionId: 'generated-layout-test',
  source: { fileId: 'generated-file', digest: 'b'.repeat(64), byteLength: 10 },
  workflowMode: 'generated-output',
  documentGeneration: 4,
});

const responsiveStyles = readFileSync(
  new URL('../src/app/review-layout-responsive.css', import.meta.url),
  'utf8',
);
const annotationStyles = readFileSync(
  new URL('../src/app/review-layout-annotations.css', import.meta.url),
  'utf8',
);
const foundationStyles = readFileSync(
  new URL('../src/app/review-layout-foundation.css', import.meta.url),
  'utf8',
);
const layoutStyles = readFileSync(
  new URL('../src/app/review-layout.css', import.meta.url),
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

const unresolvedAnnotation: ReviewItem = {
  id: 'unresolved-highlight',
  kind: 'highlight',
  pageIndex: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  payload: { comment: 'Reconnect this annotation after the rebuild.' },
  reconciliation: {
    schemaVersion: 1,
    ownerViewId: 'view-1',
    baseGeneration: 3,
    revision: 1,
    anchor: {
      kind: 'selection',
      pageIndex: 0,
      quote: 'previous source text',
      prefix: '',
      suffix: '',
      rect: { x: 10, y: 10, width: 20, height: 10 },
      segmentRects: [{ x: 10, y: 10, width: 20, height: 10 }],
    },
    disposition: { kind: 'missing', reason: 'not found after rebuild' },
    previousAnchors: [],
  },
};

describe('review shell layout and accessibility contract', () => {
  it('coordinates one active top-bar menu while pending export owns dismissal', () => {
    expect(resolveTopBarMenuRequest({
      activeMenu: 'navigation',
      requestedMenu: 'zoom',
      requestedOpen: true,
      documentMenuPending: false,
    })).toBe('zoom');
    expect(resolveTopBarMenuRequest({
      activeMenu: 'zoom',
      requestedMenu: 'history',
      requestedOpen: true,
      documentMenuPending: true,
    })).toBe('document');
    expect(resolveTopBarMenuRequest({
      activeMenu: 'document',
      requestedMenu: 'navigation',
      requestedOpen: true,
      documentMenuPending: true,
    })).toBe('document');
    expect(resolveTopBarMenuRequest({
      activeMenu: 'document',
      requestedMenu: 'document',
      requestedOpen: false,
      documentMenuPending: true,
    })).toBe('document');
    expect(resolveTopBarMenuRequest({
      activeMenu: 'document',
      requestedMenu: 'zoom',
      requestedOpen: true,
      documentMenuPending: false,
    })).toBe('zoom');
  });

  it('renders document actions through its controlled open seam', () => {
    const html = renderToStaticMarkup(
      <DocumentActionsMenu
        documentTitle="paper.pdf"
        savedLabel="Saved"
        open
        onOpenChange={() => undefined}
        presentation={{
          canExport: true,
          requiresStaleConfirmation: false,
          annotationBlocked: false,
          message: '',
        }}
        onExport={async () => undefined}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('role="menu"');
    expect(html).toContain('data-document-actions-open="true"');
  });

  it('includes inputs in menu focus order without roving editable key presses', () => {
    const action = { tagName: 'BUTTON' } as HTMLButtonElement;
    const input = { tagName: 'INPUT' } as HTMLInputElement;
    const surface = {
      querySelectorAll: (selector: string) => {
        expect(selector).toContain('input');
        expect(selector).toContain('[aria-disabled="true"]');
        return [action, input];
      },
    } as unknown as HTMLElement;

    expect(enabledMenuItems(surface)).toEqual([action, input]);
    expect(menuRovingFocusIndex({
      items: [action, input],
      activeElement: action,
      eventTarget: action,
      key: 'ArrowDown',
    })).toBe(1);
    expect(menuRovingFocusIndex({
      items: [action, input],
      activeElement: input,
      eventTarget: input,
      key: 'ArrowDown',
    })).toBeNull();
  });

  it('stacks generated-PDF status and command errors as top-left viewer toasts', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={generatedState}
        generationRefreshStatus="reconciling"
        locationRestoreStatus="restoring"
        toolError="Forward SyncTeX could not reveal this PDF location."
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => generatedState}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('data-review-toast-stack');
    expect(html).toContain('data-viewer-status');
    expect(html).toContain('data-generation-status="reconciling"');
    expect(html.indexOf('data-review-stage')).toBeLessThan(html.indexOf('data-review-toast-stack'));
    expect(html.indexOf('data-review-toast-stack')).toBeLessThan(html.indexOf('Document canvas'));
    expect(html).not.toContain('review-shell--generation-status');
    expect(foundationStyles).toMatch(
      /\.review-toast-stack\s*\{[^}]*position:\s*absolute;[^}]*top:\s*\.5rem;[^}]*left:\s*\.5rem;/u,
    );
    expect(foundationStyles).toMatch(
      /\.pdf-workspace__status\s*\{[^}]*left:\s*\.5rem;/u,
    );
    expect(foundationStyles).not.toMatch(/\.pdf-workspace__status\s*\{[^}]*right:/u);
    expect(responsiveStyles).toMatch(
      /\.review-toast\[data-generation-status="reconciling"\] \.review-icon\s*\{[^}]*animation:\s*none;/u,
    );
  });

  it('floats a reversible outline expansion toggle opposite the active workspace navbar', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        workspaceOpen
        navigationState={createReferenceNavigationState(0)}
        outlineDiscovery={{
          status: 'loaded-tree',
          documentGeneration: 0,
          items: [{
            id: 'intro',
            label: 'Introduction',
            pageContext: null,
            target: null,
            children: [{
              id: 'motivation',
              label: 'Motivation',
              pageContext: null,
              target: null,
              children: [],
            }],
          }],
        }}
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html.match(/data-outline-expansion-toggle/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Collapse all outline entries"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('lucide-chevrons-down-up');
    expect(html).toContain(
      'class="review-workspace__move review-workspace__move--activity review-workspace__move--header-action review-workspace__outline-toggle"',
    );
    expect(html).not.toContain('review-workspace__activity-strip--action');
    expect(annotationStyles).toMatch(
      /\.review-workspace__outline-toggle\s*\{[^}]*margin-left:\s*auto;/u,
    );
    expect(annotationStyles).not.toMatch(
      /\.review-workspace__outline-toggle\s*\{[^}]*(?:width|height|border|background|box-shadow):/u,
    );
  });

  it('renders full annotation content as a focused tray detail without source text', () => {
    const html = renderToStaticMarkup(
      <FullAnnotationReader
        onBack={() => undefined}
        record={{
          identity: { origin: 'owned', itemId: 'owned-highlight' },
          origin: 'owned',
          kind: 'highlight',
          typeLabel: 'Highlight',
          pageNumber: 4,
          sectionLabel: 'Identification',
          contentLabel: 'Comment',
          content: 'Clarify the identifying variation behind this claim.',
          mutable: true,
        }}
      />,
    );

    expect(html).toContain('data-full-annotation-reader="true"');
    expect(html).toContain('aria-label="Full Highlight annotation on page 4"');
    expect(html).not.toContain('Full annotation — Highlight, page 4');
    expect(html).toContain('Identification');
    expect(html).toContain('Comment');
    expect(html).toContain('Clarify the identifying variation behind this claim.');
    expect(html).not.toContain('Original text');
    expect(html).not.toContain('In the document');
  });

  it('keeps imported full annotations read-only while retaining available author metadata', () => {
    const html = renderToStaticMarkup(
      <FullAnnotationReader
        onBack={() => undefined}
        record={{
          identity: {
            origin: 'source',
            annotationKey: '1:source-highlight',
            documentGeneration: 0,
            discoveryGeneration: 1,
          },
          origin: 'source',
          kind: 'Highlight',
          typeLabel: 'Highlight',
          pageNumber: 2,
          author: 'Reviewer',
          contentLabel: 'Annotation contents',
          content: 'A source-owned comment.',
          mutable: false,
        }}
      />,
    );

    expect(html).toContain('Reviewer');
    expect(html).toContain('Read only');
    expect(html).not.toContain('>Edit<');
  });

  it('exposes Edit only for a mutable owned full annotation', () => {
    const html = renderToStaticMarkup(
      <FullAnnotationReaderActions
        onBack={() => undefined}
        onEdit={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Edit"');
    expect(html).not.toContain('>Back<');
    expect(html).not.toContain('>Edit<');
  });

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

  it('shows a blinking visual caret without exposing an insertion action', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        selectionUpdate={{ kind: 'cleared', generation: 1 }}
        caretAnchor={{
          pageIndex: 0,
          position: { x: 149, y: 89, width: 2, height: 16 },
          leftContext: 'Selectable p',
          rightContext: 'lacekeeper text',
          reliable: true,
        }}
        caretPlacement={{ left: 250, top: 180, width: 2, height: 16 }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('data-review-insertion-caret="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('left:250px;top:180px;width:2px;height:16px');
    expect(html).not.toContain('Insertion review action');
    expect(html).not.toContain('>Insert</button>');
    expect(foundationStyles).toMatch(
      /\.review-insertion-caret\s*\{[^}]*animation:\s*review-insertion-caret-blink/u,
    );
    expect(responsiveStyles).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.review-insertion-caret,[\s\S]*?animation:\s*none/u,
    );
  });

  it('keeps the insertion caret visible beside an open workspace', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        workspaceOpen
        selectionUpdate={{ kind: 'cleared', generation: 1 }}
        caretAnchor={{
          pageIndex: 0,
          position: { x: 149, y: 89, width: 2, height: 16 },
          leftContext: 'Selectable p',
          rightContext: 'lacekeeper text',
          reliable: true,
        }}
        caretPlacement={{ left: 250, top: 180, width: 2, height: 16 }}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('data-tools-workspace-open="true"');
    expect(html).toContain('data-review-insertion-caret="true"');
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

  it('groups compact edit history, document navigation, and zoom in task order before measurement', () => {
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
    const navigationGroup = html.indexOf('aria-label="Document navigation, current page 3 of 12"');
    const zoomGroup = html.indexOf('aria-label="PDF zoom, current zoom 100 percent"');

    expect(centerStart).toBeGreaterThanOrEqual(0);
    const orderedControls = [
      editGroup,
      navigationGroup,
      zoomGroup,
    ];
    for (const [index, control] of orderedControls.entries()) {
      expect(control).toBeGreaterThan(index === 0 ? centerStart : orderedControls[index - 1]!);
    }
    expect(html).not.toContain('aria-label="Actions"');
    expect(html).toContain('data-review-chrome-presentation="navigationCompact"');
  });

  it('starts with a compact measured presentation and an inert sizing rack', () => {
    const html = renderChrome(true, true);

    expect(html).toContain('data-review-chrome-presentation="navigationCompact"');
    expect(html).toMatch(/data-review-chrome-sizing-rack[^>]*aria-hidden="true"[^>]*inert=""/u);
    for (const presentation of ['expanded', 'zoomCompact', 'historyCompact', 'navigationCompact']) {
      expect(html).toContain(`data-review-chrome-candidate="${presentation}"`);
    }
    expect(html).toContain('aria-label="Document navigation, current page 3 of 12"');
    expect(html).toContain('aria-label="PDF zoom, current zoom 100 percent"');
    expect(html).toContain('aria-label="Edit history"');
  });

  it('measures every fixed identity and icon footprint in the sizing rack', () => {
    const html = renderToStaticMarkup(
      <ReviewChrome
        documentTitle="A very long paper title that must be allowed to truncate.pdf"
        savePendingDestination
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

    const rack = html.slice(html.indexOf('data-review-chrome-sizing-rack'));
    expect(rack.match(/Protected Recovery/gu)).toHaveLength(4);
    expect(rack).toContain('review-chrome__icon-control');
    expect(rack).toContain('review-chrome__link');
    expect(rack).toContain('review-chrome__save-recovery');
  });

  it('keeps responsive review chrome in one fixed-height row', () => {
    expect(foundationStyles).toMatch(
      /\.review-chrome\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) max-content max-content;[^}]*height:\s*var\(--review-chrome-height\);[^}]*overflow:\s*visible;/u,
    );
    expect(foundationStyles).toMatch(
      /\.review-chrome__identity\s*\{[^}]*min-width:\s*0;/u,
    );
    expect(foundationStyles).toMatch(/\.review-chrome__link\s*\{[^}]*flex:\s*none;/u);
    expect(foundationStyles).toMatch(
      /\.review-chrome__viewer-controls\s*\{[^}]*min-width:\s*max-content;[^}]*flex-wrap:\s*nowrap;/u,
    );
    expect(foundationStyles).toMatch(
      /\.review-chrome__sizing-candidate \.review-chrome__identity\s*\{[^}]*width:\s*max-content;/u,
    );
    expect(foundationStyles).toMatch(
      /\.review-chrome__sizing-candidate \.review-chrome__save-identity strong\s*\{[^}]*width:\s*var\(--review-document-title-cap\);[^}]*min-width:\s*var\(--review-document-title-cap\);[^}]*max-width:\s*var\(--review-document-title-cap\);[^}]*flex:\s*none;/u,
    );
    expect(foundationStyles).toMatch(/--review-document-title-cap:\s*9rem;/u);
    expect(layoutStyles).toMatch(
      /\.review-chrome__save-identity strong\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*var\(--review-document-title-cap\);[^}]*flex:\s*0 1 auto;/u,
    );
    expect(layoutStyles).toMatch(
      /\.review-chrome__identity \.document-actions__trigger\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;/u,
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.review-chrome__context\s*\{[^}]*display:\s*none;/u,
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width: 480px\)[\s\S]*?--review-document-title-cap:\s*6rem;/u,
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width: 360px\)[\s\S]*?--review-document-title-cap:\s*4\.5rem;/u,
    );
    expect(responsiveStyles).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.review-chrome__save-recovery\s*\{[^}]*display:\s*none;/u,
    );
    expect(responsiveStyles).not.toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.review-chrome\s*\{[^}]*height:\s*auto;/u,
    );
    expect(responsiveStyles).not.toMatch(
      /\.review-chrome__viewer-controls\s*\{[^}]*grid-row:\s*2;[^}]*flex-wrap:\s*wrap;/u,
    );
  });

  it('exposes annotation kind, ownership, and state hooks with a read-only peek', () => {
    const listHtml = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        activeId={ownedAnnotation.id}
        correspondingId={ownedAnnotation.id}
        onNavigate={() => undefined}
        onReadFull={() => undefined}
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
    expect(listHtml).toContain('<h2>Annotations</h2>');
    expect(listHtml).not.toContain('annotation-drawer__count');
    expect(listHtml).toContain('data-annotation-kind="highlight"');
    expect(listHtml).toContain('data-annotation-kind-icon="highlight"');
    expect(listHtml).toContain('data-annotation-state="active-corresponding"');
    expect(listHtml).toContain('<span class="annotation-item__separator">·</span><span class="annotation-item__page">4</span>');
    expect(listHtml).not.toContain('annotation-item__section');
    expect(listHtml).toContain('aria-label="Highlight · Page 4 · Clarify the identifying variation behind this claim."');
    expect(listHtml).toContain('data-read-full-annotation="true"');
    expect(listHtml).toContain('aria-label="Read full Highlight annotation on page 4"');
    expect(listHtml).toContain('title="Read full annotation"');
    expect(listHtml).toContain('hidden=""');
    expect(listHtml).toMatch(/annotation-item__navigation[\s\S]*<\/button>[\s\S]*annotation-item__more/u);
    expect(listHtml).not.toContain('>Page 4<');
    expect(unsectionedListHtml).not.toContain('annotation-item__section');
    expect(unsectionedListHtml.match(/annotation-item__separator/gu)).toHaveLength(1);
    expect(peekHtml).toContain('data-annotation-origin="owned"');
    expect(peekHtml).toContain('data-annotation-kind="highlight"');
    expect(peekHtml).toContain('Clarify the identifying variation behind this claim.');
    expect(peekHtml).not.toContain('Page 4');
    expect(peekHtml).not.toContain('<button');
    expect(listHtml).toContain('data-workspace-focus-token="annotations:section"');
    expect(listHtml).toContain('tabindex="-1"');
  });

  it('keeps the annotation Copy Link affordance mounted and right-most while durability is pending', () => {
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
    const pendingList = renderToStaticMarkup(
      <AnnotationList
        items={[ownedAnnotation]}
        copyLinkForItem={() => ({ ...copyLink, disabled: true })}
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
    expect(copyableList).toContain('annotation-item__title-row');
    expect(copyableList).toContain('annotation-item__title-actions');
    expect(copyableList).toContain('annotation-item__body-row');
    expect(copyableList.indexOf('data-annotation-action="edit"')).toBeLessThan(
      copyableList.indexOf('data-annotation-action="delete"'),
    );
    expect(copyableList.indexOf('data-annotation-action="delete"')).toBeLessThan(
      copyableList.indexOf('data-annotation-action="copy-link"'),
    );
    expect(copyablePeek).toContain('aria-label="Copy link to Highlight annotation on page 4"');
    expect(pendingList).toContain('data-item-copy-link="true"');
    expect(pendingList).toContain('title="Save annotation before copying its link"');
    expect(pendingList).toContain('disabled=""');
    expect(pageOnlyList).toContain('data-item-copy-link="false"');
    expect(pageOnlyList).not.toContain('data-annotation-action="copy-link"');
  });

  it('reveals mounted annotation actions only at mouse intent and keeps them visible for touch', () => {
    expect(annotationStyles).toMatch(
      /\.annotation-item__title-actions \.annotation-item__action,\s*\.pdf-search__clear\s*\{[^}]*width:\s*1\.4rem;[^}]*min-width:\s*1\.4rem;[^}]*max-width:\s*1\.4rem;[^}]*height:\s*1\.4rem;[^}]*min-height:\s*1\.4rem;[^}]*max-height:\s*1\.4rem;[^}]*border-radius:\s*var\(--review-radius-control\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.annotation-item__action\s*\{[^}]*opacity:\s*0;/u,
    );
    expect(annotationStyles).not.toMatch(
      /\.annotation-item__title-actions \.annotation-item__action\s*\{[^}]*opacity:\s*1;/u,
    );
    expect(annotationStyles).toMatch(
      /li:hover \.annotation-item__action,\s*:is\(\.review-workspace, \.review-tools-workspace\) li:focus-within \.annotation-item__action,\s*:is\(\.review-workspace, \.review-tools-workspace\) li\[data-active="true"\] \.annotation-item__action\s*\{[^}]*opacity:\s*1;/u,
    );
    const coarsePointerRules = responsiveStyles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(coarsePointerRules).toMatch(
      /\.annotation-item__action\s*\{[^}]*opacity:\s*1;/u,
    );
    expect(coarsePointerRules).toMatch(
      /\.annotation-item__title-actions \.annotation-item__action\s*\{[^}]*width:\s*var\(--review-control-touch\);[^}]*min-width:\s*var\(--review-control-touch\);[^}]*max-width:\s*var\(--review-control-touch\);[^}]*max-height:\s*var\(--review-control-touch\);/u,
    );
    expect(coarsePointerRules).not.toMatch(
      /\.annotation-item__title-actions\s*\{[^}]*(?:height|min-height|padding)/u,
    );
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
    expect(html).toContain('aria-label="Edit history"');
    expect(html).toContain('aria-label="Document navigation, page unavailable"');
    expect(html).toContain('aria-label="PDF zoom unavailable"');
    expect(html).not.toContain('aria-label="Workspace (0 annotations)"');
    expect(html).toContain('data-workspace-edge-rail="right"');
    expect(html).not.toContain('data-workspace-edge-rail="bottom"');
    expect(html).toContain('class="review-workspace__activity-strip"');
    expect(html).toContain('data-workspace-mode-count="3"');
    expect(html).not.toContain('data-workspace-mode-label="references"');
    expect(html).not.toContain('aria-label="Move References to right"');
    expect(html).not.toContain('id="workspace-panel-references"');
    expect(html).toContain('id="workspace-panel-annotations"');
    expect(html).toContain('id="review-annotation-list"');
    expect(html).toContain('data-review-workspace');
    expect(html).toContain('data-annotation-drawer');
    expect(html).not.toContain('aria-label="Close annotations"');
    expect(html).not.toContain('aria-label="Close workspace"');
    expect(html).toContain('class="annotation-drawer__header"');
    expect(html).toContain('aria-label="Owned annotations"');
    expect(html).toContain('aria-label="From this PDF"');
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
        referenceTabs={[{ identity: 'reference', label: 'Reference', pageContext: 'Page 2' }]}
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
      /\.review-workspace__header\s*\{[^}]*height:\s*var\(--review-workspace-header-height, 44px\);[^}]*align-items:\s*center;[^}]*padding:\s*8px 7\.5px 2px;/u,
    );
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
      /\.review-workspace__activity-strip--title\s*\{[^}]*padding:\s*0;[^}]*background:\s*transparent;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__activity-strip--title[\s\S]*\.review-workspace__mode-segment--compound::before\s*\{[^}]*content:\s*none;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__panel--references\[data-reference-tabs-orientation="vertical"\]\[data-reference-panel-layout="split"\][\s\S]*>\s*\.reference-panel\s*\{[^}]*border-top:\s*1px solid var\(--review-border-subtle\);[^}]*border-left:\s*1px solid var\(--review-border-subtle\);[^}]*border-radius:\s*var\(--review-radius-row\) 0 0;[^}]*box-shadow:\s*inset 6px 6px 14px/u,
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
      /\.review-workspace__move--header-action\s*\{[^}]*border-color:\s*transparent;[^}]*border-radius:\s*var\(--review-radius-control\);[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/u,
    );
    expect(annotationStyles).toMatch(
      /\.review-workspace__move--header-action:hover\s*\{[^}]*border-color:\s*var\(--review-border-strong\);[^}]*background:\s*var\(--review-surface-interactive\);/u,
    );
    expect(annotationStyles).toContain('height: var(--review-workspace-header-height, 44px)');
    expect(annotationStyles).toContain('margin-top: var(--review-workspace-header-height, 44px)');
    expect(annotationStyles).toContain(
      'transition: transform var(--review-motion-surface) ease-out',
    );
    expect(annotationStyles).toContain(
      'translateX(calc(-1 * var(--tools-right-width)))',
    );
    expect(annotationStyles).not.toContain(
      'translateY(calc(-50% + (var(--review-workspace-header-height, 44px) / 2) + 3px))',
    );
    expect(annotationStyles).toContain(
      'transform: translateY(calc(-1 * var(--reference-bottom-height)))',
    );
    expect(annotationStyles).toMatch(
      /\.review-tools-workspace\[data-workspace-presentation="bottom"\]\[data-tools-workspace-open="false"\]\s*\{[^}]*transform:\s*translateY\(102%\);/u,
    );
    expect(annotationStyles).not.toContain('[data-edge-rail-open="true"]::before');
    expect(annotationStyles).not.toContain('border-image');
    expect(annotationStyles).not.toContain('margin-top: 53px');
    expect(annotationStyles).not.toContain('review-workspace__tab-segment--compound');
    expect(annotationStyles).not.toContain('.existing-annotations__readonly');
  });

  it('keeps Search result actions on the workspace tray control rhythm', () => {
    expect(annotationStyles).toMatch(
      /\.pdf-search \.row-action-group\s*\{[^}]*align-self:\s*center;/u,
    );
    expect(annotationStyles).toMatch(
      /\.pdf-search \.row-action-group__action,\s*\.pdf-search \.copy-link-control__trigger--row,\s*\.pdf-search \.row-action-group__trigger\s*\{[^}]*height:\s*var\(--review-control-compact\);[^}]*min-height:\s*var\(--review-control-compact\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.pdf-search \.row-action-group__trigger\s*\{[^}]*width:\s*var\(--review-control-compact\);[^}]*min-width:\s*var\(--review-control-compact\);/u,
    );
    const coarsePointerRules = responsiveStyles.match(
      /@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/u,
    )?.[1];
    expect(coarsePointerRules).toMatch(
      /\.pdf-search \.row-action-group__action,\s*\.pdf-search \.copy-link-control__trigger--row,\s*\.pdf-search \.row-action-group__trigger\s*\{[^}]*height:\s*var\(--review-control-touch\);[^}]*min-height:\s*var\(--review-control-touch\);/u,
    );
    expect(coarsePointerRules).toMatch(
      /\.pdf-search \.row-action-group__trigger\s*\{[^}]*width:\s*var\(--review-control-touch\);[^}]*min-width:\s*var\(--review-control-touch\);/u,
    );
  });

  it('keeps Outline interaction rings separated across rows and branches', () => {
    expect(annotationStyles).toMatch(
      /\.outline-navigator\s*\{[^}]*--outline-tree-row-gap:\s*6px;[^}]*--outline-tree-branch-gap:\s*8px;/u,
    );
    expect(annotationStyles).toMatch(
      /\.outline-navigator ul\s*\{[^}]*gap:\s*var\(--outline-tree-row-gap\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.outline-navigator__children\s*\{[^}]*margin-top:\s*var\(--outline-tree-branch-gap\);/u,
    );
    expect(annotationStyles).toMatch(
      /\.outline-navigator li:has\(> \.outline-navigator__children:not\(\[hidden\]\)\) \+ li\s*\{[^}]*margin-top:\s*calc\(var\(--outline-tree-branch-gap\) - var\(--outline-tree-row-gap\)\);/u,
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

  it('keeps annotations task-first and source annotations explicitly read-only', () => {
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
        outlineDiscovery={{
          status: 'loaded-tree',
          documentGeneration: 0,
          items: [{
            id: 'outline-0',
            label: 'Representative review',
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
    expect(html).toContain('<h2>From this PDF</h2>');
    expect(html).toContain('data-annotation-origin="source"');
    expect(html).toContain('data-annotation-kind="Highlight"');
    expect(html).toContain('data-annotation-state="readonly"');
    expect(html).toContain('data-readonly="true"');
    const existingAnnotationsHtml = html.slice(
      html.indexOf('<section class="existing-annotations"'),
      html.indexOf('</section>', html.indexOf('<section class="existing-annotations"')),
    );
    expect(existingAnnotationsHtml).not.toContain('Representative review');
    expect(existingAnnotationsHtml).not.toContain('annotation-item__section');
    expect(html).toContain('aria-label="Highlight · Page 2 · Source-only comment"');
    expect(html).toContain('aria-label="Read full Highlight annotation on page 2"');
    expect(html).toContain('data-read-full-annotation="true"');
    expect(html).not.toContain('>Page 2<');
    expect(html).not.toContain('aria-label="Edit Highlight on page 2"');
    expect(html).not.toContain('aria-label="Delete Highlight on page 2"');
    expect(html).not.toContain('data-annotation-action=');
    expect(html).toContain('id="workspace-mode-annotations"');
  });

  it('orders attention, owned, and read-only populations without duplicating unresolved items', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={{ ...generatedState, items: [ownedAnnotation, unresolvedAnnotation] }}
        documentTitle="paper.pdf"
        selectionUpdate={{ kind: 'cleared', generation: 0 }}
        existingAnnotations={{
          status: 'ready',
          generation: 4,
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
        onCommand={async () => generatedState}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    const attention = html.indexOf('<h2>Needs attention</h2>');
    const owned = html.indexOf('<h2>Annotations</h2>');
    const existing = html.indexOf('<h2>From this PDF</h2>');
    expect(attention).toBeGreaterThan(-1);
    expect(owned).toBeGreaterThan(attention);
    expect(existing).toBeGreaterThan(owned);
    expect(html.match(/data-reconciliation-item="unresolved-highlight"/gu)).toHaveLength(1);
    expect(html).not.toContain('data-review-item="unresolved-highlight"');
    expect(html).toContain('data-review-item="owned-highlight"');
  });

  it('keeps Annotations as the stable empty core and omits optional sections', () => {
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

    expect(html).toContain('aria-label="Owned annotations"');
    expect(html).toContain('Select text in the PDF to add an annotation.');
    expect(html.match(/Select text in the PDF to add an annotation\./gu)).toHaveLength(1);
    expect(html).not.toContain('aria-label="From this PDF"');
    expect(html).not.toContain('data-existing-annotations-state');
    expect(html).not.toContain('No existing annotations.');
    expect(html).toContain('id="workspace-mode-annotations"');
    expect(html).toContain('id="workspace-panel-annotations"');
    expect(html).toMatch(/id="workspace-mode-annotations"[^>]*aria-selected="true"/u);
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
    expect(html).toContain('<h2>Annotations</h2>');
    expect(html).toContain('<h2>From this PDF</h2>');
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
    expect(html).toContain('aria-label="Document navigation, page unavailable"');
    expect(html).toContain('aria-label="PDF zoom unavailable"');
  });

  it('keeps unavailable page status noneditable with its existing description', () => {
    const html = renderChrome(false);

    expect(html).toContain('aria-label="Document navigation, page unavailable"');
    expect(html).toContain('>— / —</button>');
    expect(html).not.toContain('aria-label="Page number"');
    expect(html).toContain('Page controls become available when PDF navigation is ready.');
  });

  it('renders the ready current page as an activation control with numeric metadata and visible total', () => {
    const html = renderChrome(true);

    expect(html).toContain('aria-label="Document navigation, current page 3 of 12"');
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

  it('renders ready page and zoom context in compact triggers before measurement', () => {
    const html = renderChrome(true, true);

    expect(html).toContain('aria-label="PDF zoom, current zoom 100 percent"');
    expect(html).toContain('>100<span aria-hidden="true">%</span></button>');
    expect(html).not.toContain('aria-label="Zoom percentage"');
    expect(html).toContain('data-review-chrome-presentation="navigationCompact"');
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

    expect(html).toContain('aria-label="PDF zoom unavailable"');
    expect(html).toContain('>—%</button>');
    expect(html).not.toContain('aria-label="Zoom percentage"');
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
