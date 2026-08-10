import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  controlledWorkspaceSurfaceAction,
  ReviewShell,
  workspaceIsVisible,
} from '../src/app/ReviewShell.js';
import { AnnotationList } from '../src/review/AnnotationList.js';
import { AnnotationPeek } from '../src/review/AnnotationPeek.js';
import { ReviewIcon } from '../src/review/ReviewIcon.js';
import { createReviewState, type ReviewItem } from '../../../packages/core/src/review-model.js';
import {
  INITIAL_REVIEW_SURFACE_STATE,
  reduceReviewSurface,
} from '../src/review/review-surface-state.js';

const state = createReviewState({
  sessionId: 'layout-test',
  source: { fileId: 'file', digest: 'a'.repeat(64), byteLength: 10 },
});

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
    expect(html).toContain('data-workspace-open="true"');
    expect(html).toContain('aria-label="Selection review actions"');
    expect(html).not.toContain('aria-label="Page actions"');
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
    expect(html).toContain('data-review-count');
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
    expect(html).toContain('aria-label="Workspace (0 annotations)"');
    expect(html).toContain('aria-controls="review-workspace"');
    expect(html).toContain('aria-label="Workspace modes"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/id="workspace-panel-references"[^>]*hidden=""[^>]*inert=""/u);
    expect(html).toMatch(/id="workspace-panel-annotations"[^>]*hidden=""[^>]*inert=""/u);
    expect(html).toContain('id="review-annotation-list"');
    expect(html).toContain('data-review-workspace');
    expect(html).toContain('data-annotation-drawer');
    expect(html).not.toContain('aria-label="Close annotations"');
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
});
