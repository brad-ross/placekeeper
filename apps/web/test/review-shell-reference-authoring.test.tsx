import { PdfZoomMode } from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createReviewState, type ReviewItem, type ReviewState } from '../../../packages/core/src/review-model.js';
import { ReviewShell } from '../src/app/ReviewShell.js';
import {
  referenceAccessAvailable,
  referenceInspectionFocusSelector,
  referenceInspectionShouldDismissForKey,
  shouldShowRightWorkspaceRail,
} from '../src/app/ReviewShell.js';
import {
  authoringSessionInvalidReason,
  referenceAnnotationTargetSelector,
  referenceAnnotationScrollportSelector,
} from '../src/review/use-authoring-session.js';
import { createAuthoringSession } from '../src/review/authoring-session.js';
import { ReferenceWorkspace } from '../src/review/ReferenceWorkspace.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
} from '../src/review/reference-navigation-state.js';

const item: ReviewItem = {
  id: 'note-1',
  kind: 'pageNote',
  pageIndex: 4,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  payload: { comment: 'Frozen draft text' },
};
const reviewState: ReviewState = {
  ...createReviewState({
    sessionId: 'reference-authoring',
    source: { fileId: 'paper', digest: 'a'.repeat(64), byteLength: 10 },
  }),
  items: [item],
};

const session = createAuthoringSession({
  token: 1,
  authority: { sourceIdentity: JSON.stringify(['reference-authoring', 'paper', 'a'.repeat(64)]), documentGeneration: 8 },
  source: { kind: 'edit', item },
  origin: {
    kind: 'reader-edit',
    trigger: null,
    surface: { kind: 'reference', documentGeneration: 8, tabIdentity: 'tab-1' },
    referenceRecovery: {
      target: {
        documentGeneration: 8,
        pageIndex: 4,
        zoom: { mode: PdfZoomMode.FitPage, params: [] },
        identity: 'page:4',
      },
      tabIdentity: 'tab-1',
      label: 'Identification strategy',
      pageContext: 'Page 5',
    },
  },
  workspace: { open: true, mode: 'references', annotationScrollTop: 0 },
});

describe('Reference authoring continuity', () => {
  it('keeps Reference controls interactive while one editor owns authoring', () => {
    const html = renderToStaticMarkup(<ReferenceWorkspace
      open
      authoringTakeover
      mode="references"
      presentation="right"
      tabs={[{ identity: 'tab-1', label: 'Identification strategy', pageContext: 'Page 5' }]}
      activeTabIdentity="tab-1"
      onModeChange={vi.fn()}
      onReferenceTabActivate={vi.fn()}
      onReferenceTabClose={vi.fn()}
      onSendToMain={vi.fn()}
      onRetryReference={vi.fn()}
      onReferenceViewportHost={vi.fn()}
    />);

    expect(html).toContain('data-authoring-takeover="true"');
    expect(html).not.toMatch(/<aside[^>]*\sinert/u);
    expect(html).toContain('data-reference-tab="tab-1"');
    expect(html).toContain('data-reference-tab-action="close"');
  });

  it('retains a stale document or deleted edit as an invalid recoverable draft', () => {
    expect(authoringSessionInvalidReason(session, session.authority, [item])).toBeNull();
    expect(authoringSessionInvalidReason(session, {
      ...session.authority,
      documentGeneration: 9,
    }, [item])).toBe('document');
    expect(authoringSessionInvalidReason(session, session.authority, [])).toBe('edit-target');
  });

  it('scopes duplicate mark and scrollport lookup to the originating Reference tab', () => {
    expect(referenceAnnotationTargetSelector('tab-1', 'note-1')).toBe(
      '[data-annotation-surface="reference"][data-reference-tab-identity="tab-1"] [data-owned-mark][data-review-id="note-1"]',
    );
    expect(referenceAnnotationScrollportSelector('tab-1')).toBe(
      '[data-reference-pdf-viewport][data-reference-tab-identity="tab-1"] [data-viewer-framing-viewport]',
    );
    expect(referenceInspectionFocusSelector(
      { origin: 'owned', itemId: 'note-1' },
      'tab-1',
    )).toBe(
      '[data-annotation-surface="reference"][data-reference-tab-identity="tab-1"] [data-owned-focus-id="note-1"]',
    );
  });

  it('dismisses passive Reference inspection on an uncomposed Escape only', () => {
    expect(referenceInspectionShouldDismissForKey('Escape', false)).toBe(true);
    expect(referenceInspectionShouldDismissForKey('Escape', true)).toBe(false);
    expect(referenceInspectionShouldDismissForKey('Enter', false)).toBe(false);
  });

  it('keeps only Reference access available when a draft hides its docked workspace', () => {
    expect(referenceAccessAvailable({
      referencesAvailable: true,
      nestedLayerOpen: true,
      authoringActive: true,
    })).toBe(true);
    expect(referenceAccessAvailable({
      referencesAvailable: true,
      nestedLayerOpen: true,
      authoringActive: false,
    })).toBe(false);
    expect(shouldShowRightWorkspaceRail({
      rightSurfaceOpen: false,
      authoringActive: true,
      referencesAvailable: true,
      referenceDock: 'right',
    })).toBe(true);
    expect(shouldShowRightWorkspaceRail({
      rightSurfaceOpen: false,
      authoringActive: true,
      referencesAvailable: true,
      referenceDock: 'bottom',
    })).toBe(false);
  });

  it('renders Reference inspection without selecting the annotation list workspace', () => {
    const target = session.origin.referenceRecovery!.target;
    const navigationState = reduceReferenceNavigation(
      createReferenceNavigationState(8),
      {
        type: 'open-reference',
        target,
        settledLocation: {
          pageIndex: 4,
          anchor: { x: 0, y: 0 },
          alignment: { xPercent: 50, yPercent: 50 },
          zoom: 1,
        },
        tabIdentity: 'tab-1',
        label: 'Identification strategy',
        pageContext: 'Page 5',
      },
    );
    const html = renderToStaticMarkup(<ReviewShell
      state={reviewState}
      save={{}}
      selection={{ selectionUpdate: { kind: 'cleared', generation: 0 } }}
      authoring={{ onCommand: async () => reviewState }}
      viewer={{}}
      workspace={{ workspaceOpen: true, navigationState }}
      referenceInspection={{
        token: 7,
        identity: { origin: 'owned', itemId: item.id },
        surface: { kind: 'reference', documentGeneration: 8, tabIdentity: 'tab-1' },
        pageIndex: 4,
        placement: { left: 120, top: 160 },
      }}
    ><div data-annotation-surface="main">Main document</div></ReviewShell>);

    expect(html).toContain('data-reference-annotation-inspection="7"');
    expect(html).toContain('Frozen draft text');
    expect(html).toContain('Identification strategy, Page 5');
    expect(html).toMatch(/id="workspace-mode-references"[^>]*aria-selected="true"/u);
    expect(html).toMatch(/id="workspace-mode-annotations"[^>]*aria-selected="false"/u);
  });
});
