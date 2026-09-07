import type { CSSProperties } from 'react';
import { PdfZoomMode } from '@embedpdf/models';

import type { ExistingAnnotationsDiscovery } from '../../../apps/web/src/pdf/existing-annotations.js';
import type { PdfOutlineDiscovery } from '../../../apps/web/src/pdf/pdf-outline.js';
import {
  unavailableViewerControls,
  type ViewerControlsSnapshot,
} from '../../../apps/web/src/pdf/viewer-controls.js';
import type { ReviewItem, ReviewState } from '../../../packages/core/src/review-model.js';
import type {
  ReferenceReturnControlState,
  ReferenceWorkspaceTab,
} from '../../../apps/web/src/review/ReferenceWorkspace.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationState,
} from '../../../apps/web/src/review/reference-navigation-state.js';

const VISUAL_SCENE_NAMES = [
  'reading',
  'unavailable-controls',
  'contextual',
  'tray',
  'outline',
  'reference-layout',
  'peek',
  'page-note',
  'save-destination',
  'save-recovery',
  'save-failure',
  'exceptional',
] as const;

export type VisualSceneName = (typeof VISUAL_SCENE_NAMES)[number];

function isVisualSceneName(value: string): value is VisualSceneName {
  return VISUAL_SCENE_NAMES.some((name) => name === value);
}

export interface VisualScenario {
  readonly name: VisualSceneName;
  readonly documentTitle: string;
  readonly state: ReviewState;
  readonly listOpen: boolean;
  readonly correspondingItemId?: string;
  readonly pageMenuOpen: boolean;
  readonly existingAnnotations: ExistingAnnotationsDiscovery;
  readonly outlineDiscovery?: PdfOutlineDiscovery;
  readonly currentOutlineItemId?: string;
  readonly viewerState: ViewerControlsSnapshot;
  readonly referenceNavigation?: ReferenceNavigationState;
  readonly referenceTabs?: readonly ReferenceWorkspaceTab[];
  readonly referenceReturn?: ReferenceReturnControlState;
}

const timestamp = '2026-08-09T12:00:00.000Z';
const baseSource = { fileId: 'visual-source', digest: 'a'.repeat(64), byteLength: 482_193 };

function item(
  id: string,
  kind: ReviewItem['kind'],
  pageIndex: number,
  payload: ReviewItem['payload'],
): ReviewItem {
  return { id, kind, pageIndex, createdAt: timestamp, updatedAt: timestamp, payload };
}

const seededItems: readonly ReviewItem[] = [
  item('owned-highlight', 'highlight', 0, {
    quote: 'identifying variation is local to the comparison group',
    prefix: 'Our design compares outcomes within narrowly defined markets. The ',
    suffix: ', so aggregate shocks are absorbed before the coefficient is estimated.',
    comment: 'Clarify which comparison group identifies this coefficient and why the restriction is credible.',
    rect: { x: 88, y: 126, width: 318, height: 16 },
    segmentRects: [{ x: 88, y: 126, width: 318, height: 16 }],
    reliable: true,
  }),
  item('owned-replace', 'replace', 1, {
    quote: 'a unique equilibrium',
    prefix: 'Under the maintained assumptions, the model admits ',
    suffix: '. The appendix gives the regularity conditions.',
    proposedText: 'a locally unique equilibrium under the stated regularity conditions',
    rect: { x: 96, y: 204, width: 176, height: 16 },
    segmentRects: [{ x: 96, y: 204, width: 176, height: 16 }],
    reliable: true,
  }),
  item('owned-page-note', 'pageNote', 11, {
    position: { x: 438, y: 612, width: 18, height: 18 },
    comment: 'This conclusion is longer than the evidence presented above. Add the robustness result or narrow the claim.',
    nearbyText: 'Taken together, these estimates establish…',
  }),
];

const trayItems: readonly ReviewItem[] = [
  item('owned-highlight', 'highlight', 0, {
    quote: 'identifying variation is local to the comparison group',
    prefix: 'Our design compares outcomes within narrowly defined markets. The ',
    suffix: ', so aggregate shocks are absorbed before the coefficient is estimated.',
    comment: 'Clarify which comparison group identifies this coefficient, explain why the restriction is credible, and connect the local variation to the appendix robustness design. This deliberately overflowing comment keeps the complete reviewer-authored argument available in the full annotation reader.',
    rect: { x: 88, y: 126, width: 318, height: 16 },
    segmentRects: [{ x: 88, y: 126, width: 318, height: 16 }],
    reliable: true,
  }),
  item('owned-replace', 'replace', 1, {
    quote: 'a unique equilibrium',
    prefix: 'Under the maintained assumptions, the model admits ',
    suffix: '. The appendix gives the regularity conditions.',
    proposedText: 'a locally unique equilibrium',
    rect: { x: 96, y: 204, width: 176, height: 16 },
    segmentRects: [{ x: 96, y: 204, width: 176, height: 16 }],
    reliable: true,
  }),
  item('owned-page-note', 'pageNote', 11, {
    position: { x: 438, y: 612, width: 18, height: 18 },
    comment: 'This conclusion reaches beyond the evidence presented above. Add the leave-one-market-out result, state which specifications preserve the sign and magnitude, and narrow the causal language if the appendix cannot support the stronger interpretation.',
    nearbyText: 'Taken together, these estimates establish…',
  }),
];

function stateFor(items: readonly ReviewItem[]): ReviewState {
  return {
    schemaVersion: 1,
    sessionId: 'warm-neutral-visual',
    source: baseSource,
    sourceRootId: 'visual-source-root',
    revision: items.length,
    lifecycle: 'active',
    items,
    workflow: { schemaVersion: 1, mode: 'standard', documentRole: 'source-pdf', documentGeneration: 1, freshness: 'current', historyBoundary: 0 },
    pendingDrafts: [],
    discardAudit: [],
    history: [],
    historyCursor: 0,
  };
}

const readyAnnotations: ExistingAnnotationsDiscovery = {
  status: 'ready',
  generation: 1,
  items: [{
    id: 'source-highlight',
    subtype: 'Highlight',
    pageIndex: 3,
    rect: { x: 72, y: 92, width: 240, height: 14 },
    contents: 'Existing author note: reconcile this mechanism with the appendix specification.',
    author: 'A. Researcher',
    flags: ['Print'],
    appearanceModes: ['normal'],
    supportedAppearance: true,
  }],
};

const trayAnnotations: ExistingAnnotationsDiscovery = {
  status: 'ready',
  generation: 1,
  items: [{
    id: 'source-highlight-short',
    subtype: 'Highlight',
    pageIndex: 3,
    rect: { x: 72, y: 92, width: 180, height: 14 },
    contents: 'Check Table 4.',
    author: 'A. Researcher',
    flags: ['Print'],
    appearanceModes: ['normal'],
    supportedAppearance: true,
  }, {
    id: 'source-highlight-long',
    subtype: 'Highlight',
    pageIndex: 7,
    rect: { x: 84, y: 214, width: 260, height: 14 },
    contents: 'Reconcile this mechanism with the appendix specification, identify the maintained assumptions that differ across the two estimators, and explain whether the reported robustness checks isolate the same comparison group. This imported comment is intentionally long enough to require the read-only full annotation reader.',
    author: 'B. Collaborator',
    flags: ['Print'],
    appearanceModes: ['normal'],
    supportedAppearance: true,
  }],
};

const viewerState: ViewerControlsSnapshot = {
  ready: true,
  pageReady: true,
  zoomReady: true,
  currentPage: 4,
  totalPages: 128,
  zoomPercent: 112,
};

const visualReferences = [
  {
    identity: 'visual-reference-lemma',
    label: 'Lemma 2: Local identification under conditional independence',
    pageIndex: 17,
  },
  {
    identity: 'visual-reference-equation',
    label: 'Equation (14): Equilibrium response mapping',
    pageIndex: 26,
  },
  {
    identity: 'visual-reference-appendix',
    label: 'Appendix Figure A.12: Leave-one-market-out estimates',
    pageIndex: 63,
  },
] as const;

const visualReferenceTabs: readonly ReferenceWorkspaceTab[] = visualReferences.map((reference) => ({
  identity: reference.identity,
  label: reference.label,
  pageContext: `Page ${reference.pageIndex + 1}`,
  pageNumber: reference.pageIndex + 1,
}));

const visualReferenceLocation = (pageIndex: number) => ({
  pageIndex,
  anchor: { x: 72, y: 120 },
  alignment: { xPercent: 50, yPercent: 20 },
  zoom: 1.12,
});

function openVisualReference(
  state: ReferenceNavigationState,
  reference: (typeof visualReferences)[number],
): ReferenceNavigationState {
  return reduceReferenceNavigation(state, {
    type: 'open-reference',
    target: {
      documentGeneration: 0,
      pageIndex: reference.pageIndex,
      zoom: { mode: PdfZoomMode.XYZ, params: [72, 120, 1.12] },
      identity: reference.identity,
    },
    settledLocation: visualReferenceLocation(reference.pageIndex),
    label: reference.label,
    pageContext: `Page ${reference.pageIndex + 1}`,
  });
}

function createVisualReferenceNavigation(): ReferenceNavigationState {
  const state = visualReferences.reduce(openVisualReference, createReferenceNavigationState(0));
  return openVisualReference(state, visualReferences[0]);
}

const visualReferenceNavigation = createVisualReferenceNavigation();

const outlineTarget = (identity: string, pageIndex: number) => ({
  documentGeneration: 0,
  pageIndex,
  zoom: { mode: PdfZoomMode.FitPage, params: [] },
  identity,
});

const visualOutlineDiscovery: PdfOutlineDiscovery = {
  status: 'loaded-tree',
  documentGeneration: 0,
  items: [
    {
      id: 'outline-group',
      label: 'Empirical framework',
      pageContext: null,
      target: null,
      children: [{
        id: 'outline-targetable-branch',
        label: 'Identification strategy',
        pageContext: 'Page 10',
        target: outlineTarget('outline-identification', 9),
        children: [{
          id: 'outline-long-nested',
          label: 'Conditional comparison groups and identifying variation across narrowly defined local markets',
          pageContext: 'Page 18',
          target: outlineTarget('outline-conditional-comparison', 17),
          children: [{
            id: 'outline-targetable-leaf',
            label: 'Conditional comparison estimates',
            pageContext: 'Page 24',
            target: outlineTarget('outline-comparison-estimates', 23),
            children: [],
          }],
        }],
      }],
    },
    {
      id: 'outline-peer-branch',
      label: 'Robustness appendix',
      pageContext: 'Page 64',
      target: outlineTarget('outline-robustness', 63),
      children: [{
        id: 'outline-peer-leaf',
        label: 'Leave-one-market-out estimates',
        pageContext: 'Page 72',
        target: outlineTarget('outline-leave-one-market-out', 71),
        children: [],
      }],
    },
  ],
};

export function resolveVisualScenario(search: string): VisualScenario | null {
  const parameters = new URLSearchParams(search);
  const requested = parameters.get('visual');
  if (!requested || !isVisualSceneName(requested)) return null;
  const name = requested;
  const state = stateFor(name === 'contextual' || name === 'page-note'
    ? []
    : name === 'tray' ? trayItems : seededItems);
  const exception = parameters.get('exception');
  const exceptionalAnnotations: ExistingAnnotationsDiscovery = exception === 'loading'
    ? { status: 'loading', generation: 7 }
    : exception === 'empty'
      ? { status: 'empty', generation: 7, items: [] }
      : { status: 'error', generation: 7, message: 'The local annotation index could not be read. The PDF remains available and review changes are safe.' };
  const common = {
    name,
    documentTitle: 'Identification Strategy, Local Equilibria, and Robustness — Author Revision 2026-08-09.pdf',
    state,
    listOpen: name === 'tray' || name === 'outline' || name === 'exceptional' || name === 'save-failure',
    pageMenuOpen: name === 'page-note',
    existingAnnotations: name === 'exceptional'
      ? exceptionalAnnotations
      : name === 'tray' ? trayAnnotations : readyAnnotations,
    ...(name === 'tray' ? {
      outlineDiscovery: {
        status: 'loaded-tree' as const,
        documentGeneration: 0,
        items: [{
          id: 'outline-0',
          label: 'Identification strategy',
          pageContext: null,
          target: null,
          children: [],
        }],
      },
    } : {}),
    ...(name === 'outline' ? {
      outlineDiscovery: visualOutlineDiscovery,
      currentOutlineItemId: 'outline-long-nested',
    } : {}),
    viewerState: name === 'unavailable-controls' ? unavailableViewerControls() : viewerState,
    ...(name === 'reference-layout' ? {
      referenceNavigation: visualReferenceNavigation,
      referenceTabs: visualReferenceTabs,
      ...(parameters.get('referenceReturn') === 'visible' ? {
        referenceReturn: {
          tabIdentity: 'visual-reference-lemma',
          available: true,
          pending: false,
        },
      } : {}),
    } : {}),
  };
  return {
    ...common,
    ...(name === 'tray' ? { correspondingItemId: 'owned-highlight' } : {}),
  };
}

const canvasStyle: CSSProperties = {
  height: '100%',
  minHeight: 0,
  overflow: 'auto',
  display: 'grid',
  justifyItems: 'center',
  alignContent: 'start',
  padding: '42px 52px 80px',
};

const pageStyle: CSSProperties = {
  position: 'relative',
  boxSizing: 'border-box',
  width: 'min(660px, 100%)',
  minHeight: 780,
  padding: '72px 78px',
  background: 'var(--review-surface-panel)',
  border: '1px solid var(--review-border-subtle)',
  boxShadow: 'var(--review-shadow-page)',
  color: 'var(--review-ink-primary)',
  fontFamily: 'Georgia, Times New Roman, serif',
};

export function VisualDocument({
  items,
  onCorrespondenceChange,
}: {
  readonly items: readonly ReviewItem[];
  readonly onCorrespondenceChange: (id: string | undefined) => void;
}) {
  return (
    <div style={canvasStyle} role="application" aria-label="PDF review canvas" tabIndex={0} data-visual-document>
      <article style={pageStyle} aria-label="Rendered PDF page">
        <p style={{ margin: 0, font: '600 11px/1.4 ui-sans-serif, system-ui', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--review-ink-muted)' }}>Working paper · August 2026</p>
        <h1 style={{ margin: '18px 0 10px', fontSize: 27, lineHeight: 1.18, letterSpacing: '-0.02em' }}>Identification with Local Equilibria</h1>
        <p style={{ margin: '0 0 34px', color: 'var(--review-ink-muted)', fontSize: 14 }}>A. Researcher · B. Collaborator</p>
        <h2 style={{ margin: '0 0 14px', fontSize: 17 }}>3. Identification strategy</h2>
        <p style={{ fontSize: 15, lineHeight: 1.72 }}>Our design compares outcomes within narrowly defined markets. The identifying variation is local to the comparison group, so aggregate shocks are absorbed before the coefficient is estimated.</p>
        <p style={{ fontSize: 15, lineHeight: 1.72 }}>Under the maintained assumptions, the model admits a unique equilibrium. The appendix gives the regularity conditions and reports a set of leave-one-market-out checks.</p>
        <blockquote style={{ margin: '28px 0', padding: '15px 18px', borderLeft: '3px solid var(--review-selection-ink)', background: 'var(--review-surface-subtle)', fontSize: 14, lineHeight: 1.6 }}>Proposition 2. The local comparison identifies the response parameter when exposure is conditionally independent of the market-level innovation.</blockquote>
        <p style={{ fontSize: 15, lineHeight: 1.72 }}>Taken together, these estimates establish a stable mechanism across the preferred specifications and the principal robustness samples.</p>
        <div aria-label="Owned annotation overlays" data-owned-annotation-layer>
          {items.map((annotation, index) => (
            <button
              key={annotation.id}
              type="button"
              className="owned-mark-focus-proxy"
              data-owned-focus-id={annotation.id}
              aria-label={`${annotation.kind} annotation on page ${annotation.pageIndex + 1}`}
              onFocus={() => onCorrespondenceChange(annotation.id)}
              onBlur={() => onCorrespondenceChange(undefined)}
              onPointerEnter={() => onCorrespondenceChange(annotation.id)}
              onPointerLeave={() => onCorrespondenceChange(undefined)}
              style={{ position: 'absolute', right: 20, top: 180 + index * 145, width: 30, height: 30 }}
            ><span className="sr-only">Inspect annotation {index + 1}</span></button>
          ))}
        </div>
      </article>
    </div>
  );
}
