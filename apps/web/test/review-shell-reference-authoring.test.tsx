import { PdfZoomMode } from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { createReviewState, type ReviewItem, type ReviewState } from '../../../packages/core/src/review-model.js';
import { ReviewShell } from '../src/app/ReviewShell.js';
import { acceptedAuthoringCommandRequiresPersistence } from '../src/app/ProductionReviewApp.js';
import {
  activeAnnotationShouldDismissForClick,
  referenceAccessAvailable,
  referenceInspectionFocusSelector,
  referenceInspectionShouldDismissForClick,
  referenceInspectionShouldDismissForKey,
  mainAnnotationPeekCanOpen,
  takeReferenceInspectionForAuthoring,
  workspaceCloseAllowsMainPeek,
  shouldShowRightWorkspaceRail,
} from '../src/app/ReviewShell.js';
import {
  authoringSessionInvalidReason,
  authoringCommandDisposition,
  authoringPersistenceCanClose,
  authoringPersistencePendingFor,
  staleAuthoringSessionToken,
  ownedAnnotationFragmentSelector,
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
  it('preserves the selected Main annotation when its workspace close control is clicked', () => {
    const target = (matchedSelector: string | null) => ({
      closest: (selector: string) => matchedSelector !== null && selector.includes(matchedSelector)
        ? {} : null,
    }) as unknown as Pick<Element, 'closest'>;

    expect(activeAnnotationShouldDismissForClick(target('.review-workspace__close'))).toBe(false);
    expect(activeAnnotationShouldDismissForClick(target('[data-review-item]'))).toBe(false);
    expect(activeAnnotationShouldDismissForClick(target(null))).toBe(true);
  });

  it('holds a selected Main card until the closing workspace geometry is current', async () => {
    expect(mainAnnotationPeekCanOpen({
      workspaceOpen: false,
      workspaceClosePending: true,
      activeItemId: 'note-1',
    })).toBe(false);
    expect(mainAnnotationPeekCanOpen({
      workspaceOpen: false,
      workspaceClosePending: false,
      activeItemId: 'note-1',
    })).toBe(true);
    expect(mainAnnotationPeekCanOpen({
      workspaceOpen: true,
      workspaceClosePending: false,
      activeItemId: 'note-1',
    })).toBe(false);

    const signal = new AbortController().signal;
    expect(await workspaceCloseAllowsMainPeek(async () => ({
      revision: 4,
      isCurrent: () => true,
    }), signal)).toBe(true);
    let settlementAttempt = 0;
    expect(await workspaceCloseAllowsMainPeek(async () => ({
      revision: ++settlementAttempt,
      isCurrent: () => settlementAttempt > 1,
    }), signal)).toBe(true);
    expect(settlementAttempt).toBe(2);
    expect(await workspaceCloseAllowsMainPeek(async () => null, signal)).toBe(false);
  });

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

  it('token-guards a late stale Save response so the current editor remains recoverable', () => {
    expect(staleAuthoringSessionToken(session, session.token)).toBe(session.token);
    expect(staleAuthoringSessionToken(session, session.token + 1)).toBeNull();
    expect(staleAuthoringSessionToken(null, session.token)).toBeNull();
  });

  it('token-guards a late stale put-draft response so it cannot invalidate a replacement editor', () => {
    const replacement = { ...session, token: session.token + 1 };

    expect(staleAuthoringSessionToken(replacement, session.token)).toBeNull();
    expect(staleAuthoringSessionToken(replacement, replacement.token)).toBe(replacement.token);
  });

  it('retains one accepted authoring mutation until its PDF revision is persisted', () => {
    const next = { ...reviewState, revision: 1 };
    const unsettled = {
      destination: { phase: 'active' as const, generation: 1, kind: 'copy' as const, targetPath: '/tmp/review.pdf' },
      sync: { phase: 'not-saved' as const, desiredRevision: 1, savedRevision: 0 },
    };

    expect(acceptedAuthoringCommandRequiresPersistence(next, unsettled, true)).toBe(true);
    expect(acceptedAuthoringCommandRequiresPersistence(next, {
      ...unsettled,
      sync: { phase: 'clean', desiredRevision: 1, savedRevision: 1 },
    }, true)).toBe(false);
    expect(acceptedAuthoringCommandRequiresPersistence(next, unsettled, false)).toBe(false);
    expect(authoringCommandDisposition({
      accepted: false,
      state: next,
      message: 'The annotation is waiting to be saved to the PDF.',
      reason: 'persistence-pending',
    })).toBe('persistence-pending');
    const pending = { token: session.token, revision: 1 };
    expect(authoringPersistencePendingFor(session, pending)).toBe(true);
    expect(authoringPersistenceCanClose({
      session,
      pending,
      currentAuthority: session.authority,
      items: reviewState.items,
      forcedInvalidToken: null,
      persistedRevision: 1,
    })).toBe(true);
    expect(authoringPersistenceCanClose({
      session,
      pending,
      currentAuthority: { ...session.authority, documentGeneration: 9 },
      items: reviewState.items,
      forcedInvalidToken: null,
      persistedRevision: 9,
    })).toBe(false);
    expect(authoringPersistenceCanClose({
      session,
      pending,
      currentAuthority: session.authority,
      items: reviewState.items,
      forcedInvalidToken: session.token,
      persistedRevision: 1,
    })).toBe(false);
  });

  it('scopes duplicate mark and scrollport lookup to the originating Reference tab', () => {
    expect(ownedAnnotationFragmentSelector('note-1')).toBe(
      ':is([data-owned-mark], [data-source-reader-mark], [data-owned-native-geometry])[data-review-id="note-1"]',
    );
    expect(referenceAnnotationTargetSelector('tab-1', 'note-1')).toBe(
      '[data-annotation-surface="reference"][data-reference-tab-identity="tab-1"] :is([data-owned-mark], [data-source-reader-mark], [data-owned-native-geometry])[data-review-id="note-1"]',
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

  it('dismisses Reference inspection only for background clicks inside its PDF tab', () => {
    const target = (insideReference: boolean, insideProtectedTarget: boolean) => ({
      closest: (selector: string) => selector === '[data-annotation-surface="reference"]'
        ? insideReference ? {} : null
        : insideProtectedTarget ? {} : null,
    }) as unknown as Pick<Element, 'closest'>;

    expect(referenceInspectionShouldDismissForClick(target(true, false))).toBe(true);
    expect(referenceInspectionShouldDismissForClick(target(true, true))).toBe(false);
    expect(referenceInspectionShouldDismissForClick(target(false, false))).toBe(false);
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

  it('renders Reference inspection with the same compact peek card as Main', () => {
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
    expect(html).toMatch(
      /data-reference-annotation-inspection="7"[^>]*style="visibility:hidden;pointer-events:none"/u,
    );
    expect(html).toContain('data-annotation-peek="note-1"');
    expect(html).toContain('data-peek-selected="true"');
    expect(html).toContain('Frozen draft text');
    expect(html).not.toMatch(/data-reference-annotation-inspection="7"[^>]*aria-label="Identification strategy, Page 5"/u);
    expect(html).not.toContain('reference-inspection__context');
    expect(html).not.toContain('data-full-annotation-reader="true"');
    expect(html).not.toContain('aria-label="Back"');
    expect(html).toMatch(/id="workspace-mode-references"[^>]*aria-selected="true"/u);
    expect(html).toMatch(/id="workspace-mode-annotations"[^>]*aria-selected="false"/u);
  });

  it('starts reader editing with recovery frozen from the inspected Reference surface', () => {
    const recovery = session.origin.referenceRecovery!;
    const inspection = {
      token: 7,
      identity: { origin: 'owned', itemId: item.id },
      surface: { kind: 'reference', documentGeneration: 8, tabIdentity: 'tab-1' },
      pageIndex: 4,
      placement: { left: 120, top: 160 },
      referenceRecovery: recovery,
    } as const;
    const dismiss = vi.fn();
    const origin = takeReferenceInspectionForAuthoring(inspection, dismiss);

    expect(origin).toEqual({
      surface: { kind: 'reference', documentGeneration: 8, tabIdentity: 'tab-1' },
      referenceRecovery: recovery,
    });
    expect(dismiss).toHaveBeenCalledWith(7, false);
  });

  it('shows page actions only for the current Reference surface while its workspace is open', () => {
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
    const renderPageMenu = (surface: { kind: 'main'; documentGeneration: number } | {
      kind: 'reference'; documentGeneration: number; tabIdentity: string;
    }) => renderToStaticMarkup(<ReviewShell
      state={reviewState}
      save={{}}
      selection={{ selectionUpdate: { kind: 'cleared', generation: 0 } }}
      authoring={{
        pageMenu: {
          invocationId: 'reference-page-menu',
          placement: { left: 120, top: 160 },
          pageIndex: 4,
          position: { x: 10, y: 20, width: 4, height: 4 },
          surface,
        },
        onCommand: async () => reviewState,
      }}
      viewer={{}}
      workspace={{ workspaceOpen: true, navigationState }}
    ><div data-annotation-surface="main">Main document</div></ReviewShell>);

    expect(renderPageMenu({
      kind: 'reference', documentGeneration: 8, tabIdentity: 'tab-1',
    })).toContain('aria-label="Add Page Note"');
    expect(renderPageMenu({
      kind: 'reference', documentGeneration: 8, tabIdentity: 'other-tab',
    })).not.toContain('aria-label="Add Page Note"');
    expect(renderPageMenu({
      kind: 'main', documentGeneration: 8,
    })).not.toContain('aria-label="Add Page Note"');
  });
});
