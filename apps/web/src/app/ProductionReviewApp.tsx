import { pdfNavigationTargetFromPlacekeeperLocation } from '../pdf/pdf-navigation-target.js';
import { useContext, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { PluginRegistry } from "@embedpdf/core";
import type { PdfDocumentObject, PdfEngine } from '@embedpdf/models';
import { SelectionPlugin } from "@embedpdf/plugin-selection";

import { useAnnotationExport } from '../save/use-annotation-export.js';
import { ExportAnnotationDialog } from '../save/ExportAnnotationDialog.js';
import { useSaveDestination } from '../save/use-save-destination.js';
import { usePdfSearch } from '../pdf/use-pdf-search.js';
import { useHostSyncTex } from '../host/use-host-synctex.js';
import { useCodexContext, UNAVAILABLE_CODEX_CONTEXT } from '../host/use-codex-context.js';
import { initiallyPortableItemIds, saveStatusIsCleanCurrent } from "../save/portable-checkpoint.js";
import {
  referenceFocusRailSurface,
  referencePdfIsVisible,
  referenceReturnForActiveTab,
} from "../review/reference-presentation.js";
import { firstUnresolvedReviewItemId, canonicalStateSupersedes } from "../review/canonical-state.js";
import {
  viewerAssetUrlsEqual,
  viewerResourcePoliciesEqual,
} from "../host/viewer-resource-equivalence.js";
import { visibleCodexContext } from "../host/context-projection.js";
import type { ReviewItem, ReviewState } from "../../../../packages/core/src/review-model.js";
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import {
  sanitizeReviewRuntimeDisplayString,
} from "../../../../packages/core/src/review-runtime-protocol.js";
import type { CaretAnchor } from "../pdf/selection-anchor.js";
import {
  existingAnnotationKey,
  type ExistingAnnotation,
  type ExistingAnnotationsDiscovery,
} from "../pdf/existing-annotations.js";
import {
  isCurrentPdfAnnotationSurface,
  mainPdfAnnotationSurface,
  samePdfAnnotationSurface,
  type PdfAnnotationSurface,
} from '../pdf/annotation-surface.js';
import {
  MAIN_PDF_DOCUMENT_ID,
  REFERENCE_PDF_DOCUMENT_ID,
} from '../pdf/viewer-document-ids.js';
import { createEngineAnchorPageReader } from '../pdf/viewer-selection-adapter.js';
import {
  captureReadingLocation,
  fallbackReadingLocation,
  readingCaptureIsCurrent,
  readingLocationRequest,
  resolvedReadingLocation,
  type CapturedReadingLocation,
} from '../pdf/reading-location.js';
import {
  acceptCopySelectionUpdate,
  acceptSelectionUpdate,
  applyPdfCopyCommand,
  INITIAL_SELECTION_UPDATE,
  nativeCopyHasPrecedence,
  resolvePdfCopyCommand,
  type CopySelectionUpdate,
  type PdfCopyOwner,
  type PdfCopySnapshots,
  type SelectionUpdate,
} from "../pdf/selection-state.js";
import { PDF_SELECTION_PAGE_LIMIT_MESSAGE } from '../pdf/selection-page-limit.js';
import {
  NativePdfSelectionBridge,
  nativeSelectionBelongsToPdfBridge,
} from '../pdf/NativePdfSelectionBridge.js';
import { isEditableTarget } from '../review/input-controller.js';
import { App } from "./App.js";
import { ReferenceManualScrollObserver } from '../pdf/reference-manual-scroll.js';
import { WorkspaceInitialReferenceDock, WorkspaceModeAvailability, WorkspacePresentation } from '../review/WorkspaceModeStrip.js';
import { ReviewShell } from "./ReviewShell.js";
import type {
  ProductionSession,
  ProductionScope,
  ProductionSessionApi,
  ReverseSyncTexRequest,
  HostForwardSyncTexRequest,
} from "../host/session-contracts.js";
import { projectReviewItems } from "../../../../packages/core/src/annotation-projection.js";
import {
  createViewerControls,
  unavailableViewerControls,
  type InitializedViewerControls,
  type ViewerControlsSnapshot,
} from "../pdf/viewer-controls.js";
import type { ViewerFramingControls } from "../pdf/viewer-framing.js";
import type { PdfViewerNavigation } from "../pdf/viewer-navigation-adapter.js";
import {
  createPdfOutlineTargetOrderLocation,
  type PdfDocumentOrderPage,
} from '../pdf/document-order-location.js';
import {
  naturalAnchorToPdfBottomOriginPoint,
  type PdfTargetVisibility,
  type PdfViewportQuery,
} from '../pdf/viewer-navigation.js';
import {
  pdfDocumentTitleForSource,
  resolvePdfMetadataTitle,
  type PdfMetadataPageTitle,
} from '../pdf/pdf-document-title.js';
import type { ReferenceDocumentController } from "../pdf/reference-document.js";
import type { PdfOutlineDiscovery } from "../pdf/pdf-outline.js";
import type { PdfSearchResult } from '../pdf/pdf-search-model.js';
import { pdfSearchResultTarget } from '../pdf/pdf-search-navigation.js';
import type {
  ViewerClientPlacement,
  ViewerInteractionEvent,
  ViewerPageMenuInvocation,
  ViewerPdfLinkInvocation,
} from "../pdf/viewer-interaction-events.js";
import { annotationReaderIdentityMatches, type AnnotationReaderIdentity } from '../review/annotation-reader.js';
import { PageNotePlacementAuthority } from "../review/review-surface-state.js";
import type { ContextPlacement } from '../review/ContextActionPalette.js';
import {
  createOutlineContainmentResolver,
  NavigationCoordinator,
  type DestinationBand,
  type DestinationBandPresentationState,
  type LinkActionBusyState,
  type LinkDescriptionPresentationState,
  type OutlineContainmentResolver,
  type ReferenceReturnPresentationState,
} from "../review/navigation-coordinator.js";
import {
  createDestinationDescriptionResolver,
  createEngineDestinationPageReader,
  type DestinationDescriptionResolver,
} from '../pdf/destination-description.js';
import {
  createEngineDestinationSnippetRenderer,
  type DestinationSnippetRenderer,
} from '../pdf/destination-snippet.js';
import {
  BrowserReviewLocationHistory,
  type ReviewLocationHistoryEnvironment,
  type ReviewLocationHistoryPort,
  type ReviewLocationHistorySnapshot,
} from '../review/review-location-history.js';
import { buildPlacekeeperCopyLink } from '../review/CopyLinkControl.js';
import {
  createReferenceNavigationState,
  reduceReferenceNavigation,
  type ReferenceNavigationAction,
  type ReferenceTab,
} from "../review/reference-navigation-state.js";
import type { PendingReferencePanel } from "../review/ReferenceWorkspace.js";
import { PdfSearchWorkspace } from '../review/PdfSearchWorkspace.js';
import {
  createOutlineRowCopyLink,
  createPdfTargetCopyLink,
  createSearchResultRowCopyLink,
  type PdfTargetCopyLinkContext,
} from '../review/row-link-actions.js';
import {
  createTrailingTaskScheduler,
  waitForReviewNavigationReady,
} from "../review/main-location-refresh.js";
import {
  reviewItemNavigationTarget,
} from "../review/annotation-outline-context.js";
import {
  BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN,
  RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
  createReferenceWorkspaceLayout,
  deriveReferenceWorkspaceLayout,
  reduceReferenceWorkspaceLayout,
  type ReferenceWorkspaceLayoutAction,
  type RightWorkspaceMode,
} from "../review/reference-workspace-layout.js";
import { SaveDestinationDialog } from "../save/SaveDestinationDialog.js";
import {
  gateReviewCommand,
  pollSaveStatusUntilSettled,
} from "../save/save-state-controller.js";
import {
  authoringAuthorityFor,
  authoringAuthorityMatches,
  type AuthoringAuthority,
  attachmentOrderedInteractionTransport,
  type AuthoringAnchorSnapshot,
  type AuthoringReferenceRecovery,
} from '../review/authoring-session.js';
import type { ViewerAssetUrls, ViewerResourcePolicy } from '../pdf/embedpdf-viewer.js';
import type { GenerationRefreshStatus, LocationRestoreStatus } from '../generation-status.js';
import type {
  ReviewCommandInvocation,
  ReviewCommandSurfaceSnapshot,
} from '../review/review-command-surface.js';
import type { AccessibilityTransitionEffect } from './accessibility-transitions.js';
import { renderedPdfPageIsUsable } from './document-readiness.js';

interface AuthoringAnchorNavigationState {
  readonly token: number;
  readonly visibility: PdfTargetVisibility;
  readonly pending: boolean;
}

type ProductionPageMenuInvocation = ViewerPageMenuInvocation & {
  readonly surface: PdfAnnotationSurface;
  readonly referenceRecovery?: AuthoringReferenceRecovery;
};

interface ProductionReferenceInspection {
  readonly token: number;
  readonly identity: AnnotationReaderIdentity;
  readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  readonly referenceRecovery?: AuthoringReferenceRecovery;
  readonly pageIndex: number;
  readonly placement?: ViewerClientPlacement;
  readonly selected: boolean;
}

interface OwnedMarkCorrespondence {
  readonly id: string;
  readonly surface: PdfAnnotationSurface;
}

interface DeferredReferenceOwnedHover {
  readonly id: string;
  readonly pageIndex?: number;
  readonly placement?: ViewerClientPlacement;
  readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  readonly itemWasPresent: boolean;
}

export function pinReferenceInspection<T extends {
  readonly token: number;
  readonly selected: boolean;
}>(inspection: T, token: number): T {
  if (inspection.token !== token || inspection.selected) return inspection;
  return { ...inspection, selected: true };
}

export function selectedReferenceInspectionCorrespondence(
  inspection: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  },
): OwnedMarkCorrespondence | undefined {
  return inspection.identity.origin === 'owned'
    ? { id: inspection.identity.itemId, surface: inspection.surface }
    : undefined;
}

export function referenceInspectionPresentationForPhase(
  phase: 'enter' | 'leave' | 'focus' | 'blur' | 'activate',
): 'preview' | 'selected' | 'dismiss' {
  if (phase === 'activate') return 'selected';
  if (phase === 'enter' || phase === 'focus') return 'preview';
  return 'dismiss';
}

export function referenceInspectionMatches(
  inspection: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  } | null,
  identity: AnnotationReaderIdentity,
  surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>,
): boolean {
  return inspection !== null
    && annotationReaderIdentityMatches(inspection.identity, identity)
    && samePdfAnnotationSurface(inspection.surface, surface);
}

export function referenceInspectionCorrespondenceAuthority(
  inspection: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  } | null,
  itemId: string,
  surface: PdfAnnotationSurface,
): OwnedMarkCorrespondence | undefined {
  if (surface.kind !== 'reference') return undefined;
  const identity = { origin: 'owned', itemId } as const;
  return referenceInspectionMatches(inspection, identity, surface)
    ? { id: itemId, surface }
    : undefined;
}

export function correspondenceAfterReferenceInspectionDismiss(
  inspection: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  },
  published: OwnedMarkCorrespondence | undefined,
  rowItemId?: string,
): ReturnType<typeof ownedAnnotationCorrespondence> | undefined {
  const ownsPublishedCorrespondence = published !== undefined
    && referenceInspectionCorrespondenceAuthority(
      inspection,
      published.id,
      published.surface,
    ) !== undefined;
  if (!ownsPublishedCorrespondence) return undefined;
  return ownedAnnotationCorrespondence({
    ...(rowItemId === undefined ? {} : { rowItemId }),
  });
}

export function referenceInspectionReplacementChangesAuthority(
  current: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  } | null,
  next: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
  },
): boolean {
  return current !== null && !referenceInspectionMatches(current, next.identity, next.surface);
}

export function referenceInspectionShouldPreserveSelection(
  inspection: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
    readonly selected: boolean;
  } | null,
  identity: AnnotationReaderIdentity,
  surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>,
): boolean {
  return inspection?.selected === true && referenceInspectionMatches(inspection, identity, surface);
}

export function referenceInspectionShouldReuse(
  inspection: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
    readonly selected: boolean;
  } | null,
  identity: AnnotationReaderIdentity,
  surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>,
  presentation: 'preview' | 'selected',
): boolean {
  return referenceInspectionMatches(inspection, identity, surface)
    && (inspection?.selected === true || presentation === 'preview');
}

export function referenceInspectionShouldSuppressRestoredFocus(
  suppression: {
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
    readonly expiresAt: number;
  },
  identity: AnnotationReaderIdentity,
  surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>,
  now: number,
): boolean {
  return suppression.expiresAt >= now && referenceInspectionMatches(suppression, identity, surface);
}

export function ownedAnnotationCorrespondence(input: {
  readonly rowItemId?: string;
  readonly focusedMark?: OwnedMarkCorrespondence;
  readonly hoveredMark?: OwnedMarkCorrespondence;
  readonly preferredMark?: OwnedMarkCorrespondence;
}): {
  readonly viewerItemId?: string;
  readonly contentItemId?: string;
} {
  const mark = input.preferredMark ?? input.focusedMark ?? input.hoveredMark;
  if (mark !== undefined) {
    return {
      viewerItemId: mark.id,
      ...(mark.surface.kind === 'main' ? { contentItemId: mark.id } : {}),
    };
  }
  return input.rowItemId === undefined
    ? {}
    : { viewerItemId: input.rowItemId, contentItemId: input.rowItemId };
}

export function pdfAnnotationSurfaceIsCurrent(
  surface: PdfAnnotationSurface | undefined,
  current: {
    readonly documentGeneration: number;
    readonly activeReferenceTabIdentity: string | null;
    readonly referenceVisible: boolean;
  },
): boolean {
  if (surface === undefined) return true;
  return isCurrentPdfAnnotationSurface(
    surface,
    current.documentGeneration,
    current.activeReferenceTabIdentity,
  ) && (surface.kind === 'main' || current.referenceVisible);
}

export function frozenReferenceRecovery(tab: Pick<ReferenceTab,
  'identity' | 'annotationIdentity' | 'originalTarget' | 'annotationTarget' | 'label' | 'pageContext'>): AuthoringReferenceRecovery {
  const currentTarget = tab.annotationTarget ?? tab.originalTarget;
  const target = Object.freeze({
    ...currentTarget,
    zoom: Object.freeze({
      ...currentTarget.zoom,
      params: Object.freeze([...currentTarget.zoom.params]),
    }),
  });
  return Object.freeze({
    target,
    tabIdentity: tab.identity,
    label: tab.label ?? `Page ${target.pageIndex + 1}`,
    pageContext: tab.pageContext ?? `Page ${target.pageIndex + 1}`,
    ...(tab.annotationIdentity === undefined
      ? {}
      : { annotationIdentity: Object.freeze({ ...tab.annotationIdentity }) }),
  });
}

export function frozenReferenceRecoveryForSurface(
  surface: PdfAnnotationSurface | undefined,
  tabs: readonly ReferenceTab[],
): AuthoringReferenceRecovery | undefined {
  if (surface?.kind !== 'reference') return undefined;
  const tab = tabs.find((candidate) => candidate.identity === surface.tabIdentity);
  return tab === undefined ? undefined : frozenReferenceRecovery(tab);
}

function referenceTargetFromNaturalAnchor(input: {
  readonly point: { readonly x: number; readonly y: number };
  readonly pageIndex: number;
  readonly pages: readonly PdfDocumentOrderPage[] | null;
  readonly documentGeneration: number;
  readonly pageCount: number;
}): NonNullable<ReturnType<typeof pdfNavigationTargetFromPlacekeeperLocation>> | null {
  if (input.pages === null) return null;
  const page = input.pages[input.pageIndex];
  if (page === undefined) return null;
  const pdfPoint = naturalAnchorToPdfBottomOriginPoint(input.point, page.size, {
    x: page.crop.left,
    y: page.crop.bottom,
  });
  return pdfNavigationTargetFromPlacekeeperLocation({
    kind: 'destination',
    page: input.pageIndex + 1,
    mode: 'xyz',
    params: [pdfPoint.x, pdfPoint.y, 0],
  }, {
    documentGeneration: input.documentGeneration,
    pageCount: input.pageCount,
  });
}

export function annotationReferenceRequest(
  identity: AnnotationReaderIdentity,
  sources: {
    readonly items: readonly ReviewItem[];
    readonly existingAnnotations: ExistingAnnotationsDiscovery;
    readonly documentGeneration: number;
    readonly pageCount: number;
    readonly pages: readonly PdfDocumentOrderPage[] | null;
  },
): {
  readonly target: NonNullable<ReturnType<typeof pdfNavigationTargetFromPlacekeeperLocation>>;
  readonly metadata: { readonly label: string; readonly pageContext: string };
  readonly pageIndex: number;
} | null {
  let pageIndex: number;
  let point: { readonly x: number; readonly y: number };
  let label: string;
  if (identity.origin === 'owned') {
    const item = sources.items.find(({ id }) => id === identity.itemId);
    const location = item === undefined ? null : reviewItemNavigationTarget(item);
    if (item === undefined || location === null) return null;
    ({ pageIndex, point } = location);
    label = `Annotation on page ${pageIndex + 1}`;
  } else {
    if (
      identity.documentGeneration !== sources.documentGeneration
      || sources.existingAnnotations.status !== 'ready'
      || identity.discoveryGeneration !== sources.existingAnnotations.generation
    ) return null;
    const annotation = sources.existingAnnotations.items.find(
      (candidate) => existingAnnotationKey(candidate) === identity.annotationKey,
    );
    if (annotation === undefined) return null;
    pageIndex = annotation.pageIndex;
    point = { x: annotation.rect.x, y: annotation.rect.y };
    label = `${annotation.subtype} annotation on page ${pageIndex + 1}`;
  }
  const target = referenceTargetFromNaturalAnchor({
    point,
    pageIndex,
    pages: sources.pages,
    documentGeneration: sources.documentGeneration,
    pageCount: sources.pageCount,
  });
  return target === null ? null : {
    target,
    metadata: { label, pageContext: `Page ${pageIndex + 1}` },
    pageIndex,
  };
}

export function authoringReferenceTarget(
  anchor: AuthoringAnchorSnapshot,
  currentAuthority: AuthoringAuthority,
  pages: readonly PdfDocumentOrderPage[] | null,
): NonNullable<ReturnType<typeof pdfNavigationTargetFromPlacekeeperLocation>> | null {
  if (
    anchor.surface?.kind !== 'reference'
    || anchor.referenceRecovery === undefined
    || !authoringAuthorityMatches(anchor.authority, currentAuthority)
    || anchor.surface.documentGeneration !== currentAuthority.documentGeneration
    || anchor.referenceRecovery.target.documentGeneration !== currentAuthority.documentGeneration
    || anchor.point === null
  ) return null;
  return referenceTargetFromNaturalAnchor({
    point: anchor.point,
    pageIndex: anchor.pageIndex,
    pages,
    documentGeneration: currentAuthority.documentGeneration,
    pageCount: pages?.length ?? 0,
  });
}

export interface ProductionReviewAppProps {
  readonly session: ProductionSession;
  readonly initialState: ReviewState;
  readonly activeAuthoringDraftIds?: readonly string[];
  readonly initialSaveStatus?: SaveStatus;
  readonly scope: ProductionScope;
  readonly api: ProductionSessionApi;
  readonly viewerAssets?: ViewerAssetUrls;
  readonly resourcePolicy?: ViewerResourcePolicy;
  /** Host-owned semantic history. `null` explicitly disables address-bar history. */
  readonly locationHistory?: ReviewLocationHistoryPort | null;
  /** Host-issued capability-free canonical link base, independent of history. */
  readonly copyLinkBase?: string | null;
  readonly viewer?: ReactNode;
  readonly generationRefreshStatus?: GenerationRefreshStatus;
  readonly hostReattachRequestToken?: number;
  readonly hostExportRequestToken?: number;
  readonly onHostExportRequestHandled?: (token: number) => void;
  readonly hostForwardSyncTexRequest?: HostForwardSyncTexRequest;
  readonly hostReverseSyncTexRequestToken?: number;
  readonly onReverseSyncTex?: (input: ReverseSyncTexRequest) => Promise<unknown>;
  readonly initialPresentation?: { readonly pageIndex?: number; readonly zoom?: number };
  readonly onPresentationChange?: (presentation: { readonly pageIndex: number; readonly zoom: number }) => void;
  /** Host activation seam: emitted only after the main PDF generation is parsed. */
  readonly onDocumentReady?: (generation: number) => void;
  /** Host failure seam for the isolated PDF worker. */
  readonly onViewerError?: (error: Error) => void;
  /** Host-visible title seam, already resolved through metadata then filename fallback. */
  readonly onDocumentTitleChange?: (title: string, generation: number) => void;
  /** Safe semantic command projection for native menus and shortcuts. */
  readonly onCommandSurfaceChange?: (snapshot: ReviewCommandSurfaceSnapshot) => void;
  /** Native commands re-enter the same handlers used by web controls and shortcuts. */
  readonly commandInvocation?: ReviewCommandInvocation;
  readonly accessibilityTransition?: AccessibilityTransitionEffect;
}

export function acceptedAuthoringCommandRequiresPersistence(
  state: ReviewState,
  status: SaveStatus,
  authoringPersistenceRequired: boolean,
): boolean {
  return authoringPersistenceRequired
    && status.destination.phase === 'active'
    && !saveStatusIsCleanCurrent(state, status);
}

export function initialWorkspaceLocationForGeneration(
  initialGeneration: number,
  currentGeneration: number,
  location: { readonly pageIndex: number; readonly top: number } | undefined,
) {
  return currentGeneration === initialGeneration ? location : undefined;
}


export function ProductionReviewApp(props: ProductionReviewAppProps) {
  const availableModes = useContext(WorkspaceModeAvailability);
  const workspacePresentation = useContext(WorkspacePresentation);
  const initialReferenceDock = useContext(WorkspaceInitialReferenceDock);
  const authoringEnabled = availableModes === null || availableModes.includes('annotations');
  const referencesEnabled = availableModes === null || availableModes.includes('references');
  // Viewer subscriptions outlive demo mode changes; read current permissions at delivery.
  const interactionAvailability = useRef({ authoringEnabled, referencesEnabled });
  interactionAvailability.current = { authoringEnabled, referencesEnabled };
  const [localState, setState] = useState(props.initialState);
  // A runtime successor arrives as one state/assets render. Prefer that canonical
  // generation immediately so the viewer URL and semantic authority never split.
  const state = canonicalStateSupersedes(localState, props.initialState)
    ? props.initialState
    : localState;
  // A restart successor begins as an ordinary browser view, then its next
  // task prompt promotes this same authenticated page to the Codex surface.
  const [scope, setScope] = useState(props.scope);
  useEffect(() => setScope(props.scope), [props.scope]);
  const exportOnly = scope.persistenceMode === 'export-only';
  const interactionLifecycleRequired = props.api.capabilities?.localDocumentRefresh === true;
  const hasInteractionTransport = props.api.beginInteraction !== undefined
    && props.api.finalizeInteraction !== undefined
    && props.api.releaseInteraction !== undefined
    && props.api.acknowledgeInteraction !== undefined;
  const interactionLifecycle = useMemo(() => hasInteractionTransport && (
    interactionLifecycleRequired || props.api.capabilities?.interactionLifecycleVersion === 1
  )
    ? attachmentOrderedInteractionTransport(props.api, {
        beginInteraction: props.api.beginInteraction!,
        finalizeInteraction: props.api.finalizeInteraction!,
        releaseInteraction: props.api.releaseInteraction!,
        acknowledgeInteraction: props.api.acknowledgeInteraction!,
      })
    : undefined, [hasInteractionTransport, interactionLifecycleRequired, props.api]);
  useEffect(() => () => interactionLifecycle?.dispose(), [interactionLifecycle]);
  const [metadataPageTitle, setMetadataPageTitle] = useState<PdfMetadataPageTitle | null>(null);
  const portableItemIdsRef = useRef(initiallyPortableItemIds(
    props.initialState,
    props.initialSaveStatus,
  ));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(
    props.initialSaveStatus ?? {
      destination: { phase: "none", generation: 0 },
      sync: {
        phase: props.initialState.items.length === 0 ? "clean" : "not-saved",
        desiredRevision: props.initialState.revision,
        savedRevision: props.initialState.items.length === 0 ? props.initialState.revision : -1,
      },
    },
  );
  const authoringAnchorRef = useRef<AuthoringAnchorSnapshot | null>(null);
  const authoringActiveRef = useRef(false);
  const deferredReferenceOwnedHoverRef = useRef<DeferredReferenceOwnedHover | null>(null);
  const authoringViewportRef = useRef<PdfViewportQuery | null>(null);
  const [authoringAnchorNavigation, setAuthoringAnchorNavigation] = useState<
    AuthoringAnchorNavigationState | null
  >(null);
  const [authoringPreview, setAuthoringPreview] = useState<readonly ReviewAnnotation[] | null>(null);
  const [selectionUpdate, setSelectionUpdate] = useState<SelectionUpdate>(INITIAL_SELECTION_UPDATE);
  const selectionUpdateRef = useRef(selectionUpdate);
  selectionUpdateRef.current = selectionUpdate;
  const [mainCopySelection, setMainCopySelection] = useState<CopySelectionUpdate | null>(null);
  const [referenceCopySelection, setReferenceCopySelection] = useState<CopySelectionUpdate | null>(null);
  const [pdfCopyOwner, setPdfCopyOwner] = useState<PdfCopyOwner>(null);
  const paletteCopyOwnerRef = useRef<PdfCopyOwner>(null);
  const [pdfCopyOwnerIndicatorVisible, setPdfCopyOwnerIndicatorVisible] = useState(false);
  const [pdfCopyAnnouncement, setPdfCopyAnnouncement] = useState('');
  const [pdfCopyError, setPdfCopyError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  const [locationRestoreStatus, setLocationRestoreStatus] = useState<LocationRestoreStatus>('idle');
  const stateRef = useRef(state);
  stateRef.current = state;
  const [selectionPlacement, setSelectionPlacement] = useState<ContextPlacement | null>(null);
  const [selectionPlacementSurface, setSelectionPlacementSurface] = useState<PdfAnnotationSurface>();
  const [caret, setCaret] = useState<CaretAnchor | null>(null);
  const [caretPlacement, setCaretPlacement] = useState<ViewerClientPlacement | null>(null);
  const [pageMenu, setPageMenu] = useState<ProductionPageMenuInvocation | null>(null);
  const [keyboardPageNoteActive, setKeyboardPageNoteActive] = useState(false);
  const [keyboardPageNoteSurface, setKeyboardPageNoteSurface] = useState<PdfAnnotationSurface>();
  const [existingAnnotations, setExistingAnnotations] = useState<ExistingAnnotationsDiscovery>({
    status: 'loading', generation: 0,
  });
  const [inventoryRetryGeneration, setInventoryRetryGeneration] = useState(0);
  const [correspondingItemId, setCorrespondingItemId] = useState<string>();
  const [contentCorrespondingItemId, setContentCorrespondingItemId] = useState<string>();
  const [activeItemId, setActiveItemId] = useState<string>();
  const [referenceInspection, setReferenceInspection] = useState<ProductionReferenceInspection | null>(null);
  const referenceInspectionRef = useRef(referenceInspection);
  referenceInspectionRef.current = referenceInspection;
  const referenceInspectionTokenRef = useRef(0);
  const referenceInspectionHeldTokenRef = useRef<number | null>(null);
  const markHoverRef = useRef<OwnedMarkCorrespondence | undefined>(undefined);
  const markFocusRef = useRef<OwnedMarkCorrespondence | undefined>(undefined);
  const rowCorrespondenceRef = useRef<string | undefined>(undefined);
  const publishedMarkCorrespondenceRef = useRef<OwnedMarkCorrespondence | undefined>(undefined);
  const suppressedReferenceInspectionFocusRef = useRef<{
    readonly identity: AnnotationReaderIdentity;
    readonly surface: Extract<PdfAnnotationSurface, { readonly kind: 'reference' }>;
    readonly expiresAt: number;
  } | null>(null);
  const referenceInspectionDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelReferenceInspectionDismiss = useCallback(() => {
    if (referenceInspectionDismissTimerRef.current !== null) {
      clearTimeout(referenceInspectionDismissTimerRef.current);
      referenceInspectionDismissTimerRef.current = null;
    }
  }, []);
  const publishCorrespondence = useCallback((preferredMark?: OwnedMarkCorrespondence) => {
    const mark = preferredMark ?? markFocusRef.current ?? markHoverRef.current;
    const next = ownedAnnotationCorrespondence({
      ...(rowCorrespondenceRef.current === undefined
        ? {}
        : { rowItemId: rowCorrespondenceRef.current }),
      ...(mark === undefined ? {} : { preferredMark: mark }),
    });
    publishedMarkCorrespondenceRef.current = mark;
    setCorrespondingItemId(next.viewerItemId);
    setContentCorrespondingItemId(next.contentItemId);
  }, []);
  const releaseReferenceInspectionCorrespondence = useCallback((
    inspection: ProductionReferenceInspection,
  ) => {
    const next = correspondenceAfterReferenceInspectionDismiss(
      inspection,
      publishedMarkCorrespondenceRef.current,
      rowCorrespondenceRef.current,
    );
    if (next === undefined) return;
    publishedMarkCorrespondenceRef.current = undefined;
    setCorrespondingItemId(next.viewerItemId);
    setContentCorrespondingItemId(next.contentItemId);
  }, []);
  const dismissReferenceInspection = useCallback((token: number, includeSelected: boolean) => {
    const current = referenceInspectionRef.current;
    if (current?.token !== token || (!includeSelected && current.selected)) return false;
    cancelReferenceInspectionDismiss();
    referenceInspectionRef.current = null;
    if (referenceInspectionHeldTokenRef.current === token) {
      referenceInspectionHeldTokenRef.current = null;
    }
    setReferenceInspection(null);
    releaseReferenceInspectionCorrespondence(current);
    return true;
  }, [cancelReferenceInspectionDismiss, releaseReferenceInspectionCorrespondence]);
  const replaceReferenceInspection = useCallback((next: ProductionReferenceInspection) => {
    const current = referenceInspectionRef.current;
    cancelReferenceInspectionDismiss();
    if (current !== null && referenceInspectionReplacementChangesAuthority(current, next)) {
      releaseReferenceInspectionCorrespondence(current);
    }
    referenceInspectionHeldTokenRef.current = null;
    referenceInspectionRef.current = next;
    setReferenceInspection(next);
  }, [cancelReferenceInspectionDismiss, releaseReferenceInspectionCorrespondence]);
  const resetReferenceInspectionForDocument = useCallback(() => {
    cancelReferenceInspectionDismiss();
    referenceInspectionRef.current = null;
    referenceInspectionHeldTokenRef.current = null;
    publishedMarkCorrespondenceRef.current = undefined;
    markHoverRef.current = undefined;
    markFocusRef.current = undefined;
    rowCorrespondenceRef.current = undefined;
    setReferenceInspection(null);
    setCorrespondingItemId(undefined);
    setContentCorrespondingItemId(undefined);
  }, [cancelReferenceInspectionDismiss]);
  const scheduleReferenceInspectionDismiss = useCallback((token: number) => {
    cancelReferenceInspectionDismiss();
    referenceInspectionDismissTimerRef.current = setTimeout(() => {
      referenceInspectionDismissTimerRef.current = null;
      if (referenceInspectionHeldTokenRef.current === token) return;
      dismissReferenceInspection(token, false);
    }, 120);
  }, [cancelReferenceInspectionDismiss, dismissReferenceInspection]);
  useEffect(() => () => cancelReferenceInspectionDismiss(), [cancelReferenceInspectionDismiss]);
  const [caretSurface, setCaretSurface] = useState<PdfAnnotationSurface>();
  const [activationRequest, setActivationRequest] = useState<{ id: string; token: number }>();
  const [placedPageNote, setPlacedPageNote] = useState<{
    readonly token: number;
    readonly pageIndex: number;
    readonly position: { x: number; y: number; width: number; height: number };
    readonly surface: PdfAnnotationSurface;
    readonly referenceRecovery?: AuthoringReferenceRecovery;
  } | null>(null);
  const placementAuthority = useRef(new PageNotePlacementAuthority());
  const placedToken = useRef(0);
  const viewerRegistry = useRef<PluginRegistry | null>(null);
  const search = usePdfSearch();
  const { searchState, submitSearchQuery } = search;
  const [searchNavigationIntentToken, setSearchNavigationIntentToken] = useState(0);
  const commitMainFramingPositionRef = useRef<() => void>(() => undefined);
  const viewerControlsRef = useRef<InitializedViewerControls | undefined>(undefined);
  const viewerControlsGenerationRef = useRef<number | null>(null);
  const [viewerFraming, setViewerFraming] = useState<ViewerFramingControls>();
  const productionRootRef = useRef<HTMLElement | null>(null);
  const mainNavigationRef = useRef<PdfViewerNavigation | null>(null);
  const [mainNavigationReadyGeneration, setMainNavigationReadyGeneration] = useState<number | null>(null);
  const [mainDocumentReadyGeneration, setMainDocumentReadyGeneration] = useState<number | null>(null);
  const notifiedDocumentReadyGenerationRef = useRef<number | null>(null);
  const [mainNavigation, setMainNavigation] = useState<PdfViewerNavigation | null>(null);
  const referenceNavigationRef = useRef<PdfViewerNavigation | null>(null);
  const [referenceNavigation, setReferenceNavigation] = useState<PdfViewerNavigation | null>(null);
  const referenceControllerRef = useRef<ReferenceDocumentController | null>(null);
  const referenceManualScrollObserverRef = useRef(new ReferenceManualScrollObserver());
  const [referenceReturnState, renderReferenceReturnState] = useState<
    ReferenceReturnPresentationState | null
  >(null);
  const referenceReturnStateRef = useRef(referenceReturnState);
  referenceReturnStateRef.current = referenceReturnState;
  const setReferenceReturnState = useCallback((next: ReferenceReturnPresentationState | null) => {
    referenceReturnStateRef.current = next;
    renderReferenceReturnState(next);
  }, []);
  const referenceNavigationWaiters = useRef<Array<{
    readonly documentGeneration: number;
    readonly resolve: (navigation: PdfViewerNavigation | null) => void;
    timeout: ReturnType<typeof setTimeout> | null;
  }>>([]);
  const documentGenerationRef = useRef(props.initialState.workflow.documentGeneration);
  const initialDocumentGenerationRef = useRef(props.initialState.workflow.documentGeneration);
  const viewportIdentityRef = useRef(0);
  const readingUserMovementRef = useRef(0);
  const readingPageReaderRef = useRef<{
    readonly generation: number;
    readonly reader: ReturnType<typeof createEngineAnchorPageReader>;
  } | null>(null);
  const pendingReadingRestoreRef = useRef<{
    readonly successorGeneration: number;
    readonly userMovementIdentity: number;
    readonly captured: Promise<CapturedReadingLocation | null>;
  } | null>(null);
  const readingRestoreOperationRef = useRef<number | null>(null);
  const latestReadingCaptureRef = useRef<CapturedReadingLocation | null>(null);
  const captureCurrentReadingLocation = useCallback((): Promise<CapturedReadingLocation | null> => {
    const generation = documentGenerationRef.current;
    const viewportIdentity = viewportIdentityRef.current;
    const navigation = mainNavigationRef.current;
    const reader = readingPageReaderRef.current;
    let fallback: ReturnType<PdfViewerNavigation['captureLocation']>;
    try {
      fallback = navigation?.captureLocation() ?? null;
    } catch {
      return Promise.resolve(null);
    }
    if (fallback === null || fallback === undefined || reader?.generation !== generation) {
      return Promise.resolve(null);
    }
    const boundedFallback = fallbackReadingLocation({ generation, viewportIdentity, fallback });
    let page: ReturnType<typeof reader.reader.read>;
    try {
      page = reader.reader.read(fallback.pageIndex);
    } catch {
      return Promise.resolve(boundedFallback);
    }
    return captureReadingLocation({
      generation,
      viewportIdentity,
      fallback,
      page,
    }).then((captured) => {
      if (readingCaptureIsCurrent(
        captured,
        documentGenerationRef.current,
        viewportIdentityRef.current,
      )) {
        latestReadingCaptureRef.current = captured;
        return captured;
      }
      return null;
    }, () => readingCaptureIsCurrent(
      boundedFallback,
      documentGenerationRef.current,
      viewportIdentityRef.current,
    ) ? boundedFallback : null);
  }, []);
  const navigationStateRef = useRef(createReferenceNavigationState(documentGenerationRef.current));
  const [navigationState, setNavigationState] = useState(navigationStateRef.current);
  const [referenceLayoutState, dispatchReferenceLayout] = useReducer(
    reduceReferenceWorkspaceLayout,
    undefined,
    () => ({ ...createReferenceWorkspaceLayout({ width: 1440, height: 900 }), referenceDock: initialReferenceDock }),
  );
  const referenceLayoutStateRef = useRef(referenceLayoutState);
  referenceLayoutStateRef.current = referenceLayoutState;
  const layoutGenerationRef = useRef(0);
  const [rightWorkspaceMode, setRightWorkspaceMode] = useState<RightWorkspaceMode>('outline');
  const [pendingReference, setPendingReference] = useState<PendingReferencePanel | null>(null);
  const [linkActionRequest, setLinkActionRequest] = useState<
    Extract<ViewerInteractionEvent, { readonly type: 'pdf-link' }>['value'] | null
  >(null);
  const [navigationAnnouncement, setNavigationAnnouncement] = useState('');
  // Transient link-destination presentation (KTD1, KTD9, KTD10). Never part of
  // ReviewState, durable navigation, export, or Codex context.
  const [linkDescription, setLinkDescription] = useState<LinkDescriptionPresentationState | null>(null);
  const [linkActionBusy, setLinkActionBusy] = useState<LinkActionBusyState | null>(null);
  const [destinationBands, setDestinationBands] = useState<DestinationBandPresentationState | null>(null);
  const destinationDescriberRef = useRef<{
    readonly generation: number;
    readonly resolver: DestinationDescriptionResolver;
  } | null>(null);
  // The link menu's snippet stage (KTD3): a region render of the current main document.
  const destinationSnippetRendererRef = useRef<{
    readonly generation: number;
    readonly render: DestinationSnippetRenderer;
  } | null>(null);
  const renderDestinationSnippet = useCallback<DestinationSnippetRenderer>((description, signal) => {
    const renderer = destinationSnippetRendererRef.current;
    return renderer === null
      || renderer.generation !== description.documentGeneration
      || renderer.generation !== documentGenerationRef.current
      ? Promise.resolve(null)
      : renderer.render(description, signal);
  }, []);
  const outlineDiscoveryRef = useRef<PdfOutlineDiscovery>({
    status: 'loading',
    documentGeneration: documentGenerationRef.current,
  });
  const [outlineDiscovery, setOutlineDiscovery] = useState<PdfOutlineDiscovery>(
    outlineDiscoveryRef.current,
  );
  const [currentOutlineItemId, setCurrentOutlineItemId] = useState<string | null>(null);
  const locationHistory = useMemo(() => {
    if (props.locationHistory !== undefined) return props.locationHistory ?? undefined;
    if (props.session.appLinkBase === undefined || typeof window === 'undefined') return undefined;
    const environment: ReviewLocationHistoryEnvironment = {
      location: window.location,
      history: window.history,
      addEventListener: (type, listener) => window.addEventListener(type, listener),
      removeEventListener: (type, listener) => window.removeEventListener(type, listener),
    };
    return new BrowserReviewLocationHistory(environment);
  }, [props.locationHistory, props.session.appLinkBase]);
  const locationHistoryRef = useRef(locationHistory);
  locationHistoryRef.current = locationHistory;
  const copyLinkBase = useMemo(() => {
    if (props.copyLinkBase !== undefined) return props.copyLinkBase ?? undefined;
    if (props.session.appLinkBase === undefined) return undefined;
    if (scope.launchSurface !== 'codex' || typeof window === 'undefined') {
      return props.session.appLinkBase;
    }
    return `${window.location.origin}${window.location.pathname}`;
  }, [props.copyLinkBase, props.session.appLinkBase, scope.launchSurface]);
  const [locationHistorySnapshot, setLocationHistorySnapshot] = useState<ReviewLocationHistorySnapshot>({
    canBack: false,
    canForward: false,
  });
  const [referenceViewportHost, setReferenceViewportHost] = useState<HTMLDivElement | null>(null);
  const activationTokenRef = useRef(0);
  useEffect(() => {
    if (props.hostReattachRequestToken === undefined || props.hostReattachRequestToken <= 0) return;
    const id = firstUnresolvedReviewItemId(stateRef.current.items);
    setCommandNotice(null);
    if (id === undefined) {
      setCommandNotice('No annotations need reattachment.');
      const timer = window.setTimeout(() => setCommandNotice(null), 6_000);
      return () => window.clearTimeout(timer);
    }
    setActiveItemId(id);
    setActivationRequest({ id, token: ++activationTokenRef.current });
  }, [props.hostReattachRequestToken]);
  const [viewerState, setViewerState] = useState<ViewerControlsSnapshot>(unavailableViewerControls);
  const viewerStateRef = useRef(viewerState);
  viewerStateRef.current = viewerState;
  const requestReverseSyncTex = useHostSyncTex({
    hostForwardSyncTexRequest: props.hostForwardSyncTexRequest,
    hostReverseSyncTexRequestToken: props.hostReverseSyncTexRequestToken,
    onReverseSyncTex: props.onReverseSyncTex,
  }, state, stateRef, mainNavigation, mainNavigationRef, mainNavigationReadyGeneration,
    mainDocumentReadyGeneration, locationRestoreStatus, setCommandError);
  const initialPresentationAppliedRef = useRef(false);
  const providedViewerAssetsRef = useRef(props.viewerAssets);
  if (!viewerAssetUrlsEqual(providedViewerAssetsRef.current, props.viewerAssets)) {
    providedViewerAssetsRef.current = props.viewerAssets;
  }
  const resourcePolicyRef = useRef(props.resourcePolicy);
  if (!viewerResourcePoliciesEqual(resourcePolicyRef.current, props.resourcePolicy)) {
    resourcePolicyRef.current = props.resourcePolicy;
  }
  const viewerAssets = useMemo(() => providedViewerAssetsRef.current ?? ({
    pdfiumWasm: props.session.appLinkBase === undefined
      ? `/s/${props.session.sessionId}/assets/pdfium.wasm`
      : '/assets/pdfium.wasm',
    workerUrl: props.session.appLinkBase === undefined
      ? `/s/${props.session.sessionId}/assets/pdfium-worker.js`
      : '/assets/pdfium-worker.js',
    documentUrl: `/s/${props.session.sessionId}/document/${state.source.fileId}?generation=${state.workflow.documentGeneration}`,
    ...(props.session.credential === undefined
      ? {}
      : { requestHeaders: { authorization: `Bearer ${props.session.credential}` } }),
  }), [
    providedViewerAssetsRef.current,
    props.session.appLinkBase,
    props.session.credential,
    props.session.sessionId,
    state.source.fileId,
    state.workflow.documentGeneration,
  ]);
  useEffect(() => props.api.presence?.(), [props.api]);
  const ownedAnnotations = useMemo(
    () => projectReviewItems(
      authoringEnabled ? state.items : [],
      state.workflow.documentGeneration,
      { includePortableMetadata: false },
    ),
    [state.items, state.workflow.documentGeneration, authoringEnabled],
  );
  const codexContext = useCodexContext(props, scope, setScope, stateRef);
  const searchResults = useMemo(
    () => searchState.groups.flatMap((group) => group.results),
    [searchState.groups],
  );
  useEffect(() => {
    if (saveStatus.sync.phase !== "saving") return;
    const controller = new AbortController();
    void pollSaveStatusUntilSettled(
      props.api.saveStatus,
      setSaveStatus,
      controller.signal,
    );
    return () => controller.abort();
  }, [props.api, saveStatus.sync.phase, saveStatus.sync.desiredRevision, saveStatus.sync.savedRevision]);
  const annotationExport = useAnnotationExport(props.api, state, stateRef, documentGenerationRef,
    setState, props.generationRefreshStatus ?? 'idle');
  const destination = useSaveDestination(props, scope, state, stateRef, documentGenerationRef,
    setState, setSaveStatus, setCommandError);
  const { destinationDialog, copyProposal, destinationEstablishing, destinationError,
    authoringSessionResolution, openCopyDialog, retrySave } = destination;
  const dispatchNavigation = (action: ReferenceNavigationAction) => {
    const next = reduceReferenceNavigation(navigationStateRef.current, action);
    navigationStateRef.current = next;
    setNavigationState(next);
  };
  const dispatchLayout = useCallback((action: ReferenceWorkspaceLayoutAction) => {
    if (action.type !== 'set-stage-size' && action.type !== 'resize-right-references'
      && action.type !== 'resize-bottom-references' && action.type !== 'focus-surface') {
      layoutGenerationRef.current += 1;
    }
    dispatchReferenceLayout(action);
  }, []);
  const coordinatorRef = useRef<NavigationCoordinator | null>(null);
  useEffect(() => {
    if (!workspacePresentation) return;
    const { mode } = workspacePresentation;
    if (mode !== 'annotations') {
      setActiveItemId(undefined);
      setActivationRequest(undefined);
      setCorrespondingItemId(undefined);
      setContentCorrespondingItemId(undefined);
      markHoverRef.current = undefined;
      markFocusRef.current = undefined;
      publishedMarkCorrespondenceRef.current = undefined;
      deferredReferenceOwnedHoverRef.current = null;
      rowCorrespondenceRef.current = undefined;
    }
    if (mode !== 'references') setRightWorkspaceMode(mode);
    dispatchNavigation({ type: 'select-workspace-mode', mode });
  }, [workspacePresentation?.mode]);
  useEffect(() => {
    if (!workspacePresentation) return;
    if (workspacePresentation.referenceDock) {
      dispatchLayout({ type: workspacePresentation.referenceDock === 'bottom' ? 'move-references-bottom' : 'move-references-right' });
    }
    dispatchLayout({ type: 'hide-references' });
    dispatchLayout({ type: 'hide-right-workspace' });
    if (workspacePresentation.open) {
      dispatchLayout({ type: workspacePresentation.mode === 'references' ? 'show-references' : 'show-right-workspace' });
    }
  }, [workspacePresentation?.mode, workspacePresentation?.open, workspacePresentation?.referenceDock, dispatchLayout]);

  useEffect(() => {
    if (workspacePresentation?.bottomHeight !== undefined) {
      dispatchLayout({ type: 'resize-bottom-references', size: workspacePresentation.bottomHeight });
    }
  }, [workspacePresentation?.bottomHeight, dispatchLayout]);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = new NavigationCoordinator({
      getState: () => navigationStateRef.current,
      dispatch: dispatchNavigation,
      getMainNavigation: () => mainNavigationRef.current,
      getReferenceNavigation: () => referenceNavigationRef.current,
      waitForReferenceNavigation: () => {
        const current = referenceNavigationRef.current;
        if (current) return Promise.resolve(current);
        const generation = documentGenerationRef.current;
        return new Promise((resolve) => {
          const waiter: (typeof referenceNavigationWaiters.current)[number] = {
            documentGeneration: generation,
            resolve,
            timeout: null,
          };
          referenceNavigationWaiters.current.push(waiter);
          waiter.timeout = setTimeout(() => {
            const index = referenceNavigationWaiters.current.indexOf(waiter);
            if (index < 0) return;
            referenceNavigationWaiters.current.splice(index, 1);
            resolve(null);
          }, 1_600);
        });
      },
      getReferenceController: () => referenceControllerRef.current,
      commitMainFramingPosition: () => commitMainFramingPositionRef.current(),
      layout: {
        revealReferences: () => {
          const layout = referenceLayoutStateRef.current;
          if (layout.regime !== 'narrow' || !layout.narrowOpen) {
            dispatchLayout({ type: 'show-references' });
          }
          dispatchLayout({ type: 'focus-surface', surface: 'references' });
        },
        hideReferences: () => dispatchLayout({ type: 'hide-references' }),
        hideReferencesAfterSend: () => dispatchLayout({
          type: 'hide-references-after-send',
          activeMode: navigationStateRef.current.workspace.lastMode,
        }),
        settle: async () => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const animations = [
            ...productionRootRef.current?.querySelectorAll<HTMLElement>(
              '[data-review-workspace], [data-tools-workspace]',
            ) ?? [],
          ].flatMap((surface) => surface.getAnimations())
            .filter((animation) => animation.playState === 'running');
          if (animations.length > 0) {
            await Promise.allSettled(animations.map((animation) => animation.finished));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
        },
        focusReferenceRail: () => {
          const layoutGeneration = layoutGenerationRef.current;
          const documentGeneration = documentGenerationRef.current;
          requestAnimationFrame(() => {
            if (layoutGeneration !== layoutGenerationRef.current
              || documentGeneration !== documentGenerationRef.current) return;
            const layout = referenceLayoutStateRef.current;
            const surface = referenceFocusRailSurface(
              layout,
              navigationStateRef.current.tabs.length > 0,
            );
            productionRootRef.current
              ?.querySelector<HTMLButtonElement>(`[data-workspace-edge-rail="${surface}"]`)
              ?.focus({ preventScroll: true });
          });
          return true;
        },
        referenceRailFocusToken: () => referenceFocusRailSurface(
          referenceLayoutStateRef.current,
          navigationStateRef.current.tabs.length > 1,
        ) === 'bottom' ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
      },
      setPendingReference,
      getReferenceReturnState: () => referenceReturnStateRef.current,
      setReferenceReturnState,
      resetReferenceManualScrollIntent: () => referenceManualScrollObserverRef.current.clear(),
      setLinkActionRequest,
      setAnnouncement: setNavigationAnnouncement,
      focusReferenceTab: (identity) => {
        const layoutGeneration = layoutGenerationRef.current;
        const documentGeneration = documentGenerationRef.current;
        requestAnimationFrame(() => {
          if (layoutGeneration !== layoutGenerationRef.current
            || documentGeneration !== documentGenerationRef.current) return;
          const activeElement = productionRootRef.current?.ownerDocument.activeElement;
          if (activeElement instanceof HTMLElement && (
            activeElement.dataset.workspaceMode
            || activeElement.closest<HTMLElement>('[data-reference-tab-segment]')
              ?.dataset.referenceTabSegment === identity
          )) return;
          const target = [...(productionRootRef.current?.querySelectorAll<HTMLElement>(
            '[data-reference-tab]',
          ) ?? [])].find((element) => element.dataset.referenceTab === identity);
          target?.focus({ preventScroll: true });
        });
        return true;
      },
      getOutlineDiscovery: () => outlineDiscoveryRef.current,
      setCurrentOutlineItemId,
      getPageCount: () => search.getPageCount(),
      describeDestination: (request, signal) => {
        const describer = destinationDescriberRef.current;
        return describer === null || describer.generation !== request.target.documentGeneration
          ? Promise.resolve(null)
          : describer.resolver.resolve(request, signal);
      },
      setLinkDescription,
      setLinkActionBusy,
      setDestinationBands,
      // Native loading shells mount before their host history is available.
      // Keep the coordinator on the same history port the toolbar observes.
      get locationHistory() { return locationHistoryRef.current; },
      resolvePortableItem: (itemId: string) => {
        if (!portableItemIdsRef.current.has(itemId)) return null;
        const item = stateRef.current.items.find(({ id }) => id === itemId);
        return item === undefined ? null : reviewItemNavigationTarget(item);
      },
    });
  }
  const navigationCoordinator = coordinatorRef.current;
  const [initialFitRequest, setInitialFitRequest] = useState<number>();
  const [initialViewReady, setInitialViewReady] = useState(false);
  const workspacePresentationRef = useRef(workspacePresentation);
  workspacePresentationRef.current = workspacePresentation;
  useEffect(() => {
    if (!initialViewReady || !workspacePresentation?.sampleReference || workspacePresentation.mode !== 'references' || navigationStateRef.current.tabs.length > 0) return;
    const target = pdfNavigationTargetFromPlacekeeperLocation(workspacePresentation.sampleReference.pdfY === undefined
      ? { kind: 'page', page: workspacePresentation.sampleReference.page }
      : { kind: 'destination', page: workspacePresentation.sampleReference.page, mode: 'xyz', params: [0, workspacePresentation.sampleReference.pdfY, 0] }, {
      documentGeneration: state.workflow.documentGeneration, pageCount: viewerState.totalPages,
    });
    if (target) void navigationCoordinator.openReference(target, { label: workspacePresentation.sampleReference.label, pageContext: `Page ${workspacePresentation.sampleReference.page}` });
    return () => navigationCoordinator.cancelPendingNavigation();
  }, [initialViewReady, workspacePresentation?.activation, workspacePresentation?.mode, workspacePresentation?.sampleReference, viewerState.totalPages, navigationCoordinator]);
  const mainLocationRefresh = useMemo(
    () => createTrailingTaskScheduler(() => navigationCoordinator.refreshMainLocation()),
    [navigationCoordinator],
  );
  const currentAnnotationSurface = useCallback((surface?: PdfAnnotationSurface) => {
    const normalized = surface ?? mainPdfAnnotationSurface(documentGenerationRef.current);
    return pdfAnnotationSurfaceIsCurrent(normalized, {
      documentGeneration: documentGenerationRef.current,
      activeReferenceTabIdentity: navigationStateRef.current.activeTabIdentity,
      referenceVisible: referencePdfIsVisible(
        referenceLayoutStateRef.current,
        navigationStateRef.current,
      ),
    }) ? normalized : null;
  }, []);
  const referenceRecoveryForSurface = useCallback((surface: PdfAnnotationSurface | undefined) => {
    return frozenReferenceRecoveryForSurface(surface, navigationStateRef.current.tabs);
  }, []);
  const captureDocumentOrderPages = useCallback((): readonly PdfDocumentOrderPage[] | null => (
    mainNavigationRef.current?.captureDocumentOrderPages()
      ?? referenceNavigationRef.current?.captureDocumentOrderPages()
      ?? null
  ), []);
  const readAuthoringAnchorVisibility = useCallback((): {
    readonly token: number;
    readonly visibility: PdfTargetVisibility;
  } | null => {
    const anchor = authoringAnchorRef.current;
    if (anchor === null) return null;
    const currentAuthority = authoringAuthorityFor(
      stateRef.current,
      documentGenerationRef.current,
    );
    const current = anchor.point !== null
      && authoringAuthorityMatches(anchor.authority, currentAuthority);
    if (!current || anchor.point === null) {
      return { token: anchor.token, visibility: 'unavailable' };
    }
    if (anchor.surface?.kind === 'reference') {
      const recovery = anchor.referenceRecovery;
      const target = authoringReferenceTarget(
        anchor,
        currentAuthority,
        captureDocumentOrderPages(),
      );
      if (recovery === undefined || target === null) {
        return { token: anchor.token, visibility: 'unavailable' };
      }
      const active = navigationStateRef.current.activeTabIdentity === recovery.tabIdentity
        && referencePdfIsVisible(referenceLayoutStateRef.current, navigationStateRef.current);
      const navigation = referenceNavigationRef.current;
      return {
        token: anchor.token,
        visibility: !active || navigation === null
          ? 'outside'
          : navigation.targetVisibility(target),
      };
    }
    const navigation = mainNavigationRef.current;
    return {
      token: anchor.token,
      visibility: navigation === null
        ? 'unavailable'
        : navigation.pointVisibility(
          anchor.pageIndex,
          anchor.point,
        ),
    };
  }, [captureDocumentOrderPages]);
  const refreshAuthoringAnchorNavigation = useCallback(() => {
    const next = readAuthoringAnchorVisibility();
    setAuthoringAnchorNavigation((current) => {
      if (next === null) return null;
      const pending = current?.token === next.token ? current.pending : false;
      return current?.token === next.token
        && current.visibility === next.visibility
        && current.pending === pending
        ? current
        : { ...next, pending };
    });
  }, [readAuthoringAnchorVisibility]);
  const authoringAnchorRefresh = useMemo(
    () => createTrailingTaskScheduler(refreshAuthoringAnchorNavigation, 16),
    [refreshAuthoringAnchorNavigation],
  );
  const onAuthoringAnchorChange = useCallback((anchor: AuthoringAnchorSnapshot | null) => {
    authoringAnchorRef.current = anchor;
    refreshAuthoringAnchorNavigation();
  }, [refreshAuthoringAnchorNavigation]);
  const onAuthoringViewportChange = useCallback((viewport: PdfViewportQuery | null) => {
    authoringViewportRef.current = viewport;
    authoringAnchorRefresh.schedule();
  }, [authoringAnchorRefresh]);
  const returnToAuthoringAnchor = useCallback(async (token: number) => {
    const anchor = authoringAnchorRef.current;
    if (anchor === null || anchor.token !== token || anchor.point === null) {
      refreshAuthoringAnchorNavigation();
      return;
    }
    const currentAuthority = authoringAuthorityFor(
      stateRef.current,
      documentGenerationRef.current,
    );
    if (!authoringAuthorityMatches(anchor.authority, currentAuthority)) {
      refreshAuthoringAnchorNavigation();
      return;
    }
    setAuthoringAnchorNavigation((current) => current?.token === token
      ? { ...current, pending: true }
      : current);
    if (anchor.surface?.kind === 'reference') {
      const recovery = anchor.referenceRecovery;
      const target = authoringReferenceTarget(
        anchor,
        currentAuthority,
        captureDocumentOrderPages(),
      );
      if (recovery === undefined || target === null) {
        refreshAuthoringAnchorNavigation();
        return;
      }
      await navigationCoordinator.openReference(
        target,
        { label: recovery.label, pageContext: `Page ${anchor.pageIndex + 1}` },
        null,
        {
          preferredTabIdentity: recovery.tabIdentity,
          ...(recovery.annotationIdentity === undefined
            ? {}
            : { annotationIdentity: recovery.annotationIdentity }),
        },
      );
    } else {
      await navigationCoordinator.navigateMainAnnotation({
        pageIndex: anchor.pageIndex,
        point: anchor.point,
        viewport: authoringViewportRef.current ?? {},
      });
    }
    if (authoringAnchorRef.current?.token !== token) return;
    const next = readAuthoringAnchorVisibility();
    setAuthoringAnchorNavigation(next === null ? null : { ...next, pending: false });
  }, [navigationCoordinator, readAuthoringAnchorVisibility, refreshAuthoringAnchorNavigation]);
  const cancelAuthoringAnchorReturn = useCallback((token: number) => {
    if (authoringAnchorRef.current?.token !== token) return;
    navigationCoordinator.cancelPendingNavigation();
    setAuthoringAnchorNavigation((current) => current?.token === token
      ? { ...current, pending: false }
      : current);
  }, [navigationCoordinator]);

  const onSelectionUpdate = useCallback((update: SelectionUpdate) => {
    if (currentAnnotationSurface(update.surface) === null) return;
    setSelectionUpdate((current) => acceptSelectionUpdate(current, update));
  }, [currentAnnotationSurface]);
  useEffect(() => {
    setReferenceCopySelection(null);
    setPdfCopyOwner((owner) => owner === 'reference' ? null : owner);
  }, [navigationState.activeTabIdentity]);
  useEffect(() => {
    const current = {
      documentGeneration: state.workflow.documentGeneration,
      activeReferenceTabIdentity: navigationState.activeTabIdentity,
      referenceVisible: referencePdfIsVisible(referenceLayoutState, navigationState),
    };
    const obsolete = (surface: PdfAnnotationSurface | undefined) => surface?.kind === 'reference'
      && !pdfAnnotationSurfaceIsCurrent(surface, current);
    if (obsolete(selectionUpdate.surface)) {
      setSelectionUpdate((selection) => ({
        kind: 'cleared',
        generation: selection.generation + 1,
      }));
    }
    if (obsolete(selectionPlacementSurface)) {
      setSelectionPlacement(null);
      setSelectionPlacementSurface(undefined);
    }
    if (obsolete(caretSurface)) {
      setCaret(null);
      setCaretPlacement(null);
      setCaretSurface(undefined);
    }
    if (pageMenu !== null && obsolete(pageMenu.surface)) {
      placementAuthority.current.dismissContext(pageMenu.invocationId);
      setPageMenu(null);
    }
    if (placedPageNote !== null && obsolete(placedPageNote.surface)) {
      setPlacedPageNote(null);
    }
    if (obsolete(keyboardPageNoteSurface)) {
      placementAuthority.current.clearKeyboardCursor();
      setKeyboardPageNoteActive(false);
      setKeyboardPageNoteSurface(undefined);
    }
  }, [
    caretSurface,
    keyboardPageNoteSurface,
    navigationState,
    pageMenu,
    placedPageNote,
    referenceLayoutState,
    selectionPlacementSurface,
    selectionUpdate.surface,
    state.workflow.documentGeneration,
  ]);
  useEffect(() => {
    const current = referenceInspectionRef.current;
    if (current === null) return;
    const identity = current.identity;
    const remainsCurrent = current.surface.documentGeneration === state.workflow.documentGeneration
      && current.surface.tabIdentity === navigationState.activeTabIdentity
      && referencePdfIsVisible(referenceLayoutState, navigationState)
      && (identity.origin === 'owned'
        ? state.items.some(({ id }) => id === identity.itemId)
        : existingAnnotations.status === 'ready'
        && identity.documentGeneration === state.workflow.documentGeneration
        && identity.discoveryGeneration === existingAnnotations.generation
        && existingAnnotations.items.some(
          (annotation) => existingAnnotationKey(annotation) === identity.annotationKey,
        ));
    if (!remainsCurrent) dismissReferenceInspection(current.token, true);
  }, [
    dismissReferenceInspection,
    existingAnnotations,
    navigationState,
    referenceLayoutState,
    state.items,
    state.workflow.documentGeneration,
  ]);
  const onCopySelectionUpdate = useCallback((update: CopySelectionUpdate) => {
    if (update.surface.documentGeneration !== documentGenerationRef.current) return;
    if (update.surface.kind === 'reference') {
      if (update.surface.tabIdentity !== navigationStateRef.current.activeTabIdentity) return;
      if (!referencePdfIsVisible(referenceLayoutStateRef.current, navigationStateRef.current)) return;
      setReferenceCopySelection((current) => acceptCopySelectionUpdate(current, update));
    } else {
      setMainCopySelection((current) => acceptCopySelectionUpdate(current, update));
      if (update.kind === 'cleared') setPdfCopyOwnerIndicatorVisible(false);
    }
    if (update.kind === 'pending' || update.kind === 'ready') setPdfCopyError(null);
  }, []);
  useEffect(() => () => {
    navigationCoordinator.dispose();
    destinationDescriberRef.current?.resolver.dispose();
    destinationDescriberRef.current = null;
    destinationSnippetRendererRef.current = null;
    mainLocationRefresh.cancel();
    authoringAnchorRefresh.cancel();
    viewerControlsRef.current?.dispose();
    placementAuthority.current.clear();
    search.dispose();
  }, [authoringAnchorRefresh, mainLocationRefresh, navigationCoordinator]);
  useEffect(() => {
    refreshAuthoringAnchorNavigation();
  }, [
    mainNavigationReadyGeneration,
    refreshAuthoringAnchorNavigation,
    viewerState,
  ]);
  const sourceIdentity = `${state.source.fileId}:${state.source.digest}`;
  const sourceIdentityRef = useRef(sourceIdentity);
  const pendingPresentationLocationRef = useRef<ReturnType<PdfViewerNavigation['captureLocation']>>(null);
  if (sourceIdentity !== sourceIdentityRef.current && pendingPresentationLocationRef.current === null) {
    pendingPresentationLocationRef.current = mainNavigationRef.current?.captureLocation() ?? null;
  }
  const restoredLocationGenerationRef = useRef<number | null>(null);
  const restoringLocationGenerationRef = useRef<number | null>(null);
  const initialStateKeyRef = useRef(
    `${props.initialState.workflow.documentGeneration}:${props.initialState.revision}:${props.initialState.workflow.freshness}:${props.initialState.source.fileId}:${props.initialState.source.digest}`,
  );
  const resolvedPageTitle = pdfDocumentTitleForSource(
    metadataPageTitle,
    sourceIdentity,
    scope.documentTitle,
  );
  const pageTitle = scope.launchSurface === 'chrome'
    ? sanitizeReviewRuntimeDisplayString(resolvedPageTitle) ?? scope.documentTitle
    : resolvedPageTitle;
  useEffect(() => {
    document.title = pageTitle;
    props.onDocumentTitleChange?.(pageTitle, documentGenerationRef.current);
  }, [pageTitle, props.onDocumentTitleChange]);
  useEffect(() => {
    const next = `${props.initialState.workflow.documentGeneration}:${props.initialState.revision}:${props.initialState.workflow.freshness}:${props.initialState.source.fileId}:${props.initialState.source.digest}`;
    if (next === initialStateKeyRef.current) return;
    initialStateKeyRef.current = next;
    const commit = () => {
      if (initialStateKeyRef.current !== next) return;
      portableItemIdsRef.current = initiallyPortableItemIds(
        props.initialState,
        props.initialSaveStatus,
      );
      setState(props.initialState);
      if (props.initialSaveStatus !== undefined) setSaveStatus(props.initialSaveStatus);
    };
    const pending = pendingReadingRestoreRef.current;
    if (pending?.successorGeneration === props.initialState.workflow.documentGeneration) {
      // Keep the predecessor viewer mounted until its bounded semantic capture
      // settles; replacing it earlier would invalidate the page-text cache.
      void pending.captured.then(commit, commit);
    } else commit();
  }, [props.initialState]);
  useLayoutEffect(() => {
    const successorGeneration = props.initialState.workflow.documentGeneration;
    const predecessorGeneration = documentGenerationRef.current;
    if (successorGeneration <= predecessorGeneration) return;
    const cached = latestReadingCaptureRef.current;
    if (cached === null && mainNavigationRef.current === null) {
      pendingReadingRestoreRef.current = null;
      return;
    }
    pendingReadingRestoreRef.current = {
      successorGeneration,
      userMovementIdentity: readingUserMovementRef.current,
      captured: cached?.generation === predecessorGeneration
        && cached.viewportIdentity === viewportIdentityRef.current
        ? Promise.resolve(cached)
        : captureCurrentReadingLocation(),
    };
  }, [captureCurrentReadingLocation, props.initialState]);
  useEffect(() => {
    if (sourceIdentity === sourceIdentityRef.current) return;
    mainLocationRefresh.cancel();
    sourceIdentityRef.current = sourceIdentity;
    portableItemIdsRef.current = new Set();
    restoredLocationGenerationRef.current = null;
    restoringLocationGenerationRef.current = null;
    const nextGeneration = state.workflow.documentGeneration;
    if (nextGeneration <= documentGenerationRef.current) return;
    documentGenerationRef.current = nextGeneration;
    setLocationRestoreStatus('restoring');
    for (const waiter of referenceNavigationWaiters.current.splice(0)) {
      if (waiter.timeout !== null) clearTimeout(waiter.timeout);
      waiter.resolve(null);
    }
    outlineDiscoveryRef.current = { status: 'loading', documentGeneration: nextGeneration };
    setOutlineDiscovery(outlineDiscoveryRef.current);
    setExistingAnnotations({ status: 'loading', generation: 0 });
    setMainNavigationReadyGeneration(null);
    setMainDocumentReadyGeneration(null);
    viewerControlsGenerationRef.current = null;
    destinationDescriberRef.current?.resolver.dispose();
    destinationDescriberRef.current = null;
    destinationSnippetRendererRef.current = null;
    navigationCoordinator.replaceDocument(nextGeneration, { preservePresentation: true });
    readingRestoreOperationRef.current = navigationCoordinator.operationIdentity();
    search.reset();
    setSelectionUpdate((current) => ({ kind: 'cleared', generation: current.generation + 1 }));
    setMainCopySelection(null);
    setReferenceCopySelection(null);
    setPdfCopyOwner(null);
    setPdfCopyOwnerIndicatorVisible(false);
    setPdfCopyError(null);
    setCaret(null);
    setCaretSurface(undefined);
    setSelectionPlacement(null);
    setSelectionPlacementSurface(undefined);
    setCaretPlacement(null);
    setPageMenu(null);
    setPlacedPageNote(null);
    setKeyboardPageNoteActive(false);
    setKeyboardPageNoteSurface(undefined);
    resetReferenceInspectionForDocument();
    setActiveItemId(undefined);
  }, [mainLocationRefresh, navigationCoordinator, resetReferenceInspectionForDocument,
    sourceIdentity, state.workflow.documentGeneration]);
  useEffect(() => {
    destination.invalidatePendingDestination();
  }, [destinationDialog, sourceIdentity, state.sessionId, state.workflow.documentGeneration]);
  useEffect(() => {
    if (locationHistory === undefined) return;
    return locationHistory.subscribe(setLocationHistorySnapshot);
  }, [locationHistory]);
  useEffect(() => {
    if (referenceReturnStateRef.current?.available !== true) return;
    const frame = requestAnimationFrame(() => {
      void navigationCoordinator.refreshReferenceReturnAvailability();
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationCoordinator, referenceLayoutState]);
  useEffect(() => {
    if (
      mainNavigationReadyGeneration !== documentGenerationRef.current
      || mainDocumentReadyGeneration !== documentGenerationRef.current
      || restoredLocationGenerationRef.current === documentGenerationRef.current
      || restoringLocationGenerationRef.current === documentGenerationRef.current
    ) return;
    const generation = documentGenerationRef.current;
    restoringLocationGenerationRef.current = generation;
    const restoreOperation = readingRestoreOperationRef.current;
    let cancelled = false;
    const restoreWhenSettled = async () => {
      let restored = false;
      let settled = false;
      try {
        const ready = await waitForReviewNavigationReady({
          isCurrent: () => !cancelled && generation === documentGenerationRef.current,
          isReady: () => (
            viewerControlsGenerationRef.current === generation
            && (mainNavigationRef.current?.fitToWidthReady() ?? false)
          ),
        });
        if (!ready) return;
        const initialLocation = initialWorkspaceLocationForGeneration(
          initialDocumentGenerationRef.current,
          generation,
          workspacePresentationRef.current?.initialLocation,
        );
        if (!initialLocation && viewerControlsRef.current?.usesAutomaticFitWidth()) {
          // Establish default framing before restoring an explicit destination.
          // A later fit would move its anchor and replace the exact URL with a page link.
          await mainNavigationRef.current?.fitToWidth();
          if (cancelled || generation !== documentGenerationRef.current) return;
        }
        navigationCoordinator.startLocationHistory();
        const pendingReading = pendingReadingRestoreRef.current?.successorGeneration === generation
          ? pendingReadingRestoreRef.current : null;
        if (pendingReading !== null) {
          pendingReadingRestoreRef.current = null;
          const captured = await pendingReading.captured;
          if (captured !== null && !cancelled && generation === documentGenerationRef.current &&
            pendingReading.userMovementIdentity === readingUserMovementRef.current &&
            readingRestoreOperationRef.current === navigationCoordinator.operationIdentity()) {
            const request = readingLocationRequest(captured);
            let resolution;
            try {
              resolution = request === null || props.api.resolveReadingLocation === undefined
                ? { status: 'fallback' as const, generation, pageCount: Math.max(1, search.getPageCount()) }
                : await props.api.resolveReadingLocation({ ...request, generation });
            } catch {
              resolution = {
                status: 'fallback' as const,
                generation,
                pageCount: Math.max(1, search.getPageCount()),
              };
            }
            if (!cancelled && generation === documentGenerationRef.current &&
              pendingReading.userMovementIdentity === readingUserMovementRef.current &&
              readingRestoreOperationRef.current === navigationCoordinator.operationIdentity()) {
              const navigation = mainNavigationRef.current;
              const location = resolution.status === 'stale' || navigation === null
                ? null
                : navigation.clampLocation(resolvedReadingLocation(captured, resolution));
              if (resolution.status !== 'stale' && navigation !== null && location !== null) {
                try {
                  restored = await navigation.applyLocation(location);
                } catch {
                  restored = false;
                }
              }
            }
          }
        } else {
          const presentation = pendingPresentationLocationRef.current;
          restored = locationHistory === undefined
            ? presentation === null
              ? true
              : await navigationCoordinator.restorePresentationLocation(presentation, generation)
            : await navigationCoordinator.restoreCurrentLocation();
        }
        if (cancelled || generation !== documentGenerationRef.current) return;
        if (restored) viewerControlsRef.current?.freezeCurrentZoom();
        const startingLocation = mainNavigationRef.current?.captureLocation();
        if (initialLocation && startingLocation) {
          // Position the excerpt, then let the shell fit its settled reading frame.
          const applied = await mainNavigationRef.current?.applyLocation({
              ...startingLocation,
              pageIndex: initialLocation.pageIndex,
              anchor: { ...startingLocation.anchor, y: initialLocation.top },
              alignment: { ...startingLocation.alignment, yPercent: 0 },
            }) ?? false;
          if (applied && !cancelled && generation === documentGenerationRef.current) {
            setInitialFitRequest(generation);
          } else {
            restored = false;
            setInitialViewReady(true);
          }
        } else {
          setInitialViewReady(true);
        }
        restoredLocationGenerationRef.current = generation;
        pendingPresentationLocationRef.current = null;
        setLocationRestoreStatus(restored ? 'idle' : 'fallback');
        settled = true;
      } catch {
        restored = false;
      } finally {
        if (readingRestoreOperationRef.current === restoreOperation) {
          readingRestoreOperationRef.current = null;
        }
        if (!settled && !cancelled && generation === documentGenerationRef.current) {
          restoredLocationGenerationRef.current = generation;
          pendingPresentationLocationRef.current = null;
          setInitialViewReady(true);
          setLocationRestoreStatus('fallback');
        }
        if (restoringLocationGenerationRef.current === generation) {
          restoringLocationGenerationRef.current = null;
        }
      }
    };
    void restoreWhenSettled();
    return () => { cancelled = true; };
  }, [
    locationHistory,
    mainDocumentReadyGeneration,
    mainNavigationReadyGeneration,
    navigationCoordinator,
  ]);
  useEffect(() => {
    if (!saveStatusIsCleanCurrent(state, saveStatus)) {
      if (restoredLocationGenerationRef.current === documentGenerationRef.current) {
        navigationCoordinator.downgradeCurrentItemLocation();
      }
      return;
    }
    portableItemIdsRef.current = new Set(state.items.map((item) => item.id));
  }, [navigationCoordinator, saveStatus, state]);
  const onViewerInteraction = useCallback((event: ViewerInteractionEvent) => {
    if (!interactionAvailability.current.referencesEnabled && (event.type === 'pdf-link' || event.type === 'pdf-link-unavailable')) return;
    if (!interactionAvailability.current.authoringEnabled && ['caret', 'page-menu', 'page-note-cursor', 'page-note-commit'].includes(event.type)) return;
    const surface = currentAnnotationSurface(event.surface);
    if ([
      'selection-placement',
      'caret',
      'page-menu',
      'page-note-cursor',
      'page-note-commit',
      'owned-mark',
      'owned-mark-clear',
      'source-mark',
    ].includes(event.type) && surface === null) return;
    if (event.type === 'reverse-synctex') {
      requestReverseSyncTex(event.value);
      return;
    }
    if (event.type === 'pdf-link') {
      navigationCoordinator.requestLink(event.value);
      return;
    }
    if (event.type === 'pdf-link-unavailable') {
      navigationCoordinator.unavailableLink(event.value);
      return;
    }
    if (event.type === 'scroll') {
      mainLocationRefresh.schedule();
      authoringAnchorRefresh.schedule();
      void captureCurrentReadingLocation();
      return;
    }
    if (event.type === "selection-placement") {
      setSelectionPlacement(event.value === null || surface === null
        ? null
        : { ...event.value.placement, surface: surface.kind });
      setSelectionPlacementSurface(event.value === null ? undefined : surface ?? undefined);
      return;
    }
    if (event.type === "caret") {
      setCaret(event.value.anchor);
      setCaretPlacement(event.value.placement);
      setCaretSurface(event.value.anchor === null ? undefined : surface ?? undefined);
      return;
    }
    if (event.type === "page-menu") {
      placementAuthority.current.clearKeyboardCursor();
      setKeyboardPageNoteActive(false);
      setKeyboardPageNoteSurface(undefined);
      const referenceRecovery = referenceRecoveryForSurface(surface ?? undefined);
      setPageMenu(event.value === null || surface === null ? null : {
        ...event.value,
        surface,
        ...(referenceRecovery === undefined ? {} : { referenceRecovery }),
      });
      if (event.value) placementAuthority.current.setContextPoint(event.value.invocationId, event.value.point);
      return;
    }
    if (event.type === "page-note-cursor") {
      if (event.value) placementAuthority.current.setKeyboardCursor(event.value);
      else placementAuthority.current.clearKeyboardCursor();
      if (event.value) setKeyboardPageNoteSurface(surface ?? undefined);
      return;
    }
    if (event.type === "page-note-commit") {
      const point = placementAuthority.current.consumeKeyboardCursor(event.value);
      if (!point) return;
      setKeyboardPageNoteActive(false);
      const referenceRecovery = referenceRecoveryForSurface(surface ?? undefined);
      setPlacedPageNote({
        token: ++placedToken.current,
        pageIndex: point.pageIndex,
        position: { x: point.x, y: point.y, width: 18, height: 18 },
        surface: surface ?? mainPdfAnnotationSurface(documentGenerationRef.current),
        ...(referenceRecovery === undefined ? {} : { referenceRecovery }),
      });
      return;
    }
    if (event.type === 'owned-mark-clear') {
      if (surface?.kind === 'reference') return;
      if (authoringActiveRef.current) return;
      setActiveItemId(undefined);
      return;
    }
    if (event.type === 'owned-mark') {
      if (surface === null) return;
      const { id, phase } = event.value;
      const referencePresentation = referenceInspectionPresentationForPhase(phase);
      const preferredMark = referencePresentation === 'dismiss'
        ? referenceInspectionCorrespondenceAuthority(referenceInspectionRef.current, id, surface)
        : { id, surface };
      if (phase === 'enter') markHoverRef.current = { id, surface };
      if (phase === 'leave' && markHoverRef.current?.id === id) markHoverRef.current = undefined;
      if (phase === 'focus') markFocusRef.current = { id, surface };
      if (phase === 'blur' && markFocusRef.current?.id === id) markFocusRef.current = undefined;
      if (surface.kind === 'reference' && referencePresentation === 'dismiss') {
        const deferred = deferredReferenceOwnedHoverRef.current;
        if (deferred?.id === id
          && samePdfAnnotationSurface(deferred.surface, surface)) {
          deferredReferenceOwnedHoverRef.current = null;
        }
      }
      if (surface.kind === 'reference' && referencePresentation === 'preview') {
        if (authoringActiveRef.current) {
          if (phase === 'enter') deferredReferenceOwnedHoverRef.current = {
            id,
            surface,
            itemWasPresent: stateRef.current.items.some((candidate) => candidate.id === id),
            ...(event.value.pageIndex === undefined ? {} : { pageIndex: event.value.pageIndex }),
            ...(event.value.placement === undefined ? {} : { placement: event.value.placement }),
          };
          return;
        }
        deferredReferenceOwnedHoverRef.current = null;
        const identity = { origin: 'owned', itemId: id } as const;
        const suppressedFocus = suppressedReferenceInspectionFocusRef.current;
        if (phase === 'focus' && suppressedFocus !== null) {
          suppressedReferenceInspectionFocusRef.current = null;
          if (referenceInspectionShouldSuppressRestoredFocus(
            suppressedFocus, identity, surface, Date.now(),
          )) {
            publishCorrespondence(preferredMark);
            return;
          }
        }
        const current = referenceInspectionRef.current;
        if (referenceInspectionMatches(current, identity, surface)) {
          cancelReferenceInspectionDismiss();
          publishCorrespondence(preferredMark);
          return;
        }
        const item = stateRef.current.items.find((candidate) => candidate.id === id);
        const location = item === undefined ? null : reviewItemNavigationTarget(item);
        if (location === null) return;
        cancelReferenceInspectionDismiss();
        const referenceRecovery = referenceRecoveryForSurface(surface);
        replaceReferenceInspection({
          token: ++referenceInspectionTokenRef.current,
          identity,
          surface,
          ...(referenceRecovery === undefined ? {} : { referenceRecovery }),
          pageIndex: event.value.pageIndex ?? location.pageIndex,
          ...(event.value.placement === undefined ? {} : { placement: event.value.placement }),
          selected: false,
        });
      }
      if (surface.kind === 'reference' && referencePresentation === 'dismiss') {
        const current = referenceInspectionRef.current;
        if (current?.identity.origin === 'owned'
          && current.identity.itemId === id
          && !current.selected) scheduleReferenceInspectionDismiss(current.token);
      }
      if (phase === 'activate') {
        if (authoringActiveRef.current) return;
        if (surface.kind === 'reference') {
          const item = stateRef.current.items.find((candidate) => candidate.id === id);
          const location = item === undefined ? null : reviewItemNavigationTarget(item);
          if (location === null) return;
          const referenceRecovery = referenceRecoveryForSurface(surface);
          cancelReferenceInspectionDismiss();
          replaceReferenceInspection({
            token: ++referenceInspectionTokenRef.current,
            identity: { origin: 'owned', itemId: id },
            surface,
            ...(referenceRecovery === undefined ? {} : { referenceRecovery }),
            pageIndex: event.value.pageIndex ?? location.pageIndex,
            ...(event.value.placement === undefined ? {} : { placement: event.value.placement }),
            selected: true,
          });
          publishCorrespondence(preferredMark);
          return;
        }
        setActiveItemId(id);
        setActivationRequest({ id, token: ++activationTokenRef.current });
      }
      publishCorrespondence(preferredMark);
      return;
    }
    if (event.type === 'source-mark' && surface?.kind === 'reference') {
      if (existingAnnotations.status !== 'ready') return;
      if (!existingAnnotations.items.some(
        (annotation) => existingAnnotationKey(annotation) === event.value.annotationKey,
      )) return;
      const current = referenceInspectionRef.current;
      const referencePresentation = referenceInspectionPresentationForPhase(event.value.phase);
      if (referencePresentation === 'dismiss') {
        if (current?.identity.origin === 'source'
          && current.identity.annotationKey === event.value.annotationKey
          && !current.selected) scheduleReferenceInspectionDismiss(current.token);
        return;
      }
      const identity: AnnotationReaderIdentity = {
        origin: 'source',
        annotationKey: event.value.annotationKey,
        documentGeneration: surface.documentGeneration,
        discoveryGeneration: existingAnnotations.generation,
      };
      const suppressedFocus = suppressedReferenceInspectionFocusRef.current;
      if (event.value.phase === 'focus' && suppressedFocus !== null) {
        suppressedReferenceInspectionFocusRef.current = null;
        if (referenceInspectionShouldSuppressRestoredFocus(
          suppressedFocus, identity, surface, Date.now(),
        )) return;
      }
      if (referenceInspectionShouldReuse(current, identity, surface, referencePresentation)) {
        cancelReferenceInspectionDismiss();
        return;
      }
      cancelReferenceInspectionDismiss();
      const referenceRecovery = referenceRecoveryForSurface(surface);
      replaceReferenceInspection({
        token: ++referenceInspectionTokenRef.current,
        identity,
        surface,
        ...(referenceRecovery === undefined ? {} : { referenceRecovery }),
        pageIndex: event.value.pageIndex,
        ...(event.value.placement === undefined ? {} : { placement: event.value.placement }),
        selected: referencePresentation === 'selected',
      });
    }
  }, [
    authoringAnchorRefresh,
    cancelReferenceInspectionDismiss,
    captureCurrentReadingLocation,
    currentAnnotationSurface,
    existingAnnotations,
    mainLocationRefresh,
    navigationCoordinator,
    referenceRecoveryForSurface,
    replaceReferenceInspection,
    requestReverseSyncTex,
    scheduleReferenceInspectionDismiss,
  ]);
  const replayDeferredReferenceOwnedHover = useCallback(() => {
    const deferred = deferredReferenceOwnedHoverRef.current;
    if (deferred === null || authoringActiveRef.current) return;
    const currentSurface = currentAnnotationSurface(deferred.surface);
    const hovered = markHoverRef.current;
    if (currentSurface?.kind !== 'reference'
      || hovered === undefined
      || hovered.id !== deferred.id
      || !samePdfAnnotationSurface(hovered.surface, deferred.surface)) {
      deferredReferenceOwnedHoverRef.current = null;
      return;
    }
    const itemPresent = stateRef.current.items.some((candidate) => candidate.id === deferred.id);
    if (!itemPresent) {
      if (deferred.itemWasPresent) deferredReferenceOwnedHoverRef.current = null;
      return;
    }
    deferredReferenceOwnedHoverRef.current = null;
    onViewerInteraction({
      type: 'owned-mark',
      value: {
        id: deferred.id,
        phase: 'enter',
        ...(deferred.pageIndex === undefined ? {} : { pageIndex: deferred.pageIndex }),
        ...(deferred.placement === undefined ? {} : { placement: deferred.placement }),
      },
      surface: deferred.surface,
    });
  }, [currentAnnotationSurface, onViewerInteraction]);
  useEffect(() => {
    replayDeferredReferenceOwnedHover();
  }, [
    navigationState,
    referenceLayoutState,
    replayDeferredReferenceOwnedHover,
    state.items,
    state.workflow.documentGeneration,
  ]);
  const onReferenceDocumentControls = useCallback((controls: ReferenceDocumentController | null) => {
    referenceControllerRef.current = controls;
    if (controls === null) navigationCoordinator.referenceNavigationUnavailable();
  }, [navigationCoordinator]);
  const onViewerNavigationInitialized = useCallback((
    scope: 'main' | 'reference',
    navigation: PdfViewerNavigation | null,
  ) => {
    if (scope === 'main') {
      mainNavigationRef.current = navigation;
      setMainNavigation(navigation);
      navigation?.replaceDocument(documentGenerationRef.current);
      setMainNavigationReadyGeneration(navigation === null ? null : documentGenerationRef.current);
      navigationCoordinator.refreshMainLocation();
      refreshAuthoringAnchorNavigation();
      void captureCurrentReadingLocation();
      return;
    }
    referenceNavigationRef.current = navigation;
    setReferenceNavigation(navigation);
    if (navigation === null) {
      navigationCoordinator.referenceNavigationUnavailable();
      const current = referenceInspectionRef.current;
      if (current !== null) dismissReferenceInspection(current.token, true);
    }
    navigation?.replaceDocument(documentGenerationRef.current);
    if (navigation) {
      const generation = documentGenerationRef.current;
      const current = referenceNavigationWaiters.current.splice(0);
      for (const waiter of current) {
        if (waiter.timeout !== null) clearTimeout(waiter.timeout);
        waiter.resolve(waiter.documentGeneration === generation ? navigation : null);
      }
    }
  }, [captureCurrentReadingLocation, dismissReferenceInspection, navigationCoordinator, refreshAuthoringAnchorNavigation]);
  const onExistingAnnotationsDiscovery = useCallback((result: ExistingAnnotationsDiscovery) => {
    setExistingAnnotations(result);
  }, []);
  const onOutlineDiscovery = useCallback((discovery: PdfOutlineDiscovery) => {
    if (discovery.documentGeneration !== documentGenerationRef.current) return;
    outlineDiscoveryRef.current = discovery;
    setOutlineDiscovery(discovery);
    navigationCoordinator.refreshCurrentOutline();
  }, [navigationCoordinator]);
  const onViewerInitialized = useCallback(async (registry: PluginRegistry) => {
    viewerRegistry.current = registry;
    viewerControlsRef.current?.dispose();
    const controls = createViewerControls(registry, {
      viewport: () => productionRootRef.current?.querySelector<HTMLElement>(
        '.pdf-workspace:not(.pdf-workspace--reference) [data-viewer-framing-viewport]',
      ) ?? null,
      jumpToPage: (pageNumber) => {
        // Startup applies page and zoom together through the native controls.
        if (!initialPresentationAppliedRef.current) return false;
        const navigation = mainNavigationRef.current;
        const destination = navigation?.resolvePageLocation(pageNumber - 1);
        if (!navigation || !destination) return false;
        return navigation.applyLocation(destination);
      },
    });
    viewerControlsRef.current = controls;
    viewerControlsGenerationRef.current = documentGenerationRef.current;
    setViewerState(controls.snapshot());
    if (!initialPresentationAppliedRef.current) {
      if (props.initialPresentation?.pageIndex !== undefined) {
        controls.goToPage(props.initialPresentation.pageIndex + 1);
      }
      if (props.initialPresentation?.zoom !== undefined) {
        controls.zoomToPercent(props.initialPresentation.zoom * 100);
      }
      initialPresentationAppliedRef.current = true;
    }
    controls.subscribe(() => {
      if (restoringLocationGenerationRef.current !== documentGenerationRef.current) {
        viewportIdentityRef.current += 1;
      }
      setViewerState(controls.snapshot());
      mainLocationRefresh.schedule();
      void captureCurrentReadingLocation();
    });
  }, [captureCurrentReadingLocation, mainLocationRefresh, props.initialPresentation]);
  useEffect(() => {
    if (!viewerState.ready || props.onPresentationChange === undefined) return;
    props.onPresentationChange({
      pageIndex: viewerState.currentPage,
      zoom: viewerState.zoomPercent / 100,
    });
  }, [props.onPresentationChange, viewerState]);
  const onMainDocumentReady = useCallback((engine: PdfEngine, document: PdfDocumentObject) => {
    const documentGeneration = documentGenerationRef.current;
    readingPageReaderRef.current = {
      generation: documentGeneration,
      reader: createEngineAnchorPageReader(engine, document),
    };
    destinationDescriberRef.current?.resolver.dispose();
    destinationSnippetRendererRef.current = {
      generation: documentGeneration,
      render: createEngineDestinationSnippetRenderer({ engine, document, documentGeneration }),
    };
    // The outline may load after the document; resolve headings lazily and
    // prepare one containment index per loaded outline.
    let headingIndex: {
      readonly discovery: PdfOutlineDiscovery;
      readonly resolve: OutlineContainmentResolver;
    } | null = null;
    destinationDescriberRef.current = {
      generation: documentGeneration,
      resolver: createDestinationDescriptionResolver({
        documentGeneration,
        reader: createEngineDestinationPageReader(engine, document),
        resolveHeading: (location) => {
          const discovery = outlineDiscoveryRef.current;
          if (discovery.documentGeneration !== documentGeneration) return null;
          if (headingIndex?.discovery !== discovery) {
            headingIndex = {
              discovery,
              resolve: createOutlineContainmentResolver({
                discovery,
                resolveTarget: (target) => {
                  const page = document.pages[target.pageIndex];
                  return page === undefined ? null : createPdfOutlineTargetOrderLocation(target, {
                    documentGeneration,
                    page: {
                      ...page.size,
                      cropOrigin: {
                        x: page.boxes?.crop.left ?? 0,
                        y: page.boxes?.crop.bottom ?? 0,
                      },
                    },
                  });
                },
              }),
            };
          }
          return headingIndex.resolve(location)?.label ?? null;
        },
      }),
    };
    void captureCurrentReadingLocation();
    const documentSourceIdentity = sourceIdentity;
    search.initialize(engine, document, documentGeneration, () => {
      setMainDocumentReadyGeneration(documentGeneration);
    }, () => {
      void resolvePdfMetadataTitle(engine, document).then((title) => {
        if (
          documentGenerationRef.current === documentGeneration &&
          search.isCurrentDocument(document)
        ) {
          setMetadataPageTitle(title === undefined
            ? null
            : { sourceIdentity: documentSourceIdentity, title });
        }
      });
    });
  }, [captureCurrentReadingLocation, sourceIdentity]);
  useEffect(() => {
    const generation = state.workflow.documentGeneration;
    if (props.onDocumentReady === undefined
      || notifiedDocumentReadyGenerationRef.current === generation
      || mainDocumentReadyGeneration !== generation) return;
    if (scope.launchSurface !== 'macos') {
      notifiedDocumentReadyGenerationRef.current = generation;
      props.onDocumentReady(generation);
      return;
    }
    if (mainNavigationReadyGeneration !== generation) return;
    const root = productionRootRef.current;
    const navigation = mainNavigationRef.current;
    if (root === null || navigation === null) return;
    let cancelled = false;
    let confirming = false;
    const frames = new Set<number>();
    const usableRenderedPage = () => {
      const viewport = root.querySelector<HTMLElement>('[data-viewer-framing-viewport]');
      if (viewport === null) return false;
      const viewportRect = viewport.getBoundingClientRect();
      for (const image of viewport.querySelectorAll<HTMLImageElement>('[data-page-index] img')) {
        const style = getComputedStyle(image);
        if (renderedPdfPageIsUsable({
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
          pageRect: image.getBoundingClientRect(),
          viewportRect,
          display: style.display,
          visibility: style.visibility,
        })) return true;
      }
      return false;
    };
    const scheduleFrame = (callback: () => void) => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        callback();
      });
      frames.add(frame);
    };
    const probe = () => {
      if (cancelled || confirming || !usableRenderedPage() || navigation.captureLocation() === null) return;
      confirming = true;
      scheduleFrame(() => scheduleFrame(() => {
        confirming = false;
        if (cancelled || generation !== documentGenerationRef.current
          || mainNavigationRef.current !== navigation || !usableRenderedPage()
          || navigation.captureLocation() === null) return;
        notifiedDocumentReadyGenerationRef.current = generation;
        props.onDocumentReady?.(generation);
      }));
    };
    const observer = new MutationObserver(probe);
    observer.observe(root, { subtree: true, childList: true, attributes: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(probe);
    resize?.observe(root);
    root.addEventListener('load', probe, true);
    queueMicrotask(probe);
    return () => {
      cancelled = true;
      observer.disconnect();
      resize?.disconnect();
      root.removeEventListener('load', probe, true);
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [
    mainDocumentReadyGeneration,
    mainNavigationReadyGeneration,
    props.onDocumentReady,
    scope.launchSurface,
    state.workflow.documentGeneration,
  ]);
  const onViewerFramingInitialized = useCallback((controls: ViewerFramingControls) => {
    setViewerFraming(controls);
  }, []);
  const currentDestinationBands = destinationBands !== null
    && destinationBands.documentGeneration === navigationState.documentGeneration
    ? destinationBands
    : null;
  const activeReferenceDestinationBand: DestinationBand | null = navigationState.activeTabIdentity === null
    ? null
    : currentDestinationBands?.references.get(navigationState.activeTabIdentity) ?? null;
  const viewer = props.viewer ?? (
    <App
      embeddedInReviewShell
      assets={viewerAssets}
      {...(resourcePolicyRef.current === undefined ? {} : { resourcePolicy: resourcePolicyRef.current })}
      documentTitle={scope.documentTitle}
      onSelectionUpdate={onSelectionUpdate}
      onCopySelectionUpdate={onCopySelectionUpdate}
      ownedAnnotations={ownedAnnotations}
      authoringPreview={authoringPreview}
      keyboardPageNoteActive={keyboardPageNoteActive}
      {...(keyboardPageNoteSurface === undefined ? {} : { keyboardPageNoteSurface })}
      onViewerInteraction={onViewerInteraction}
      reverseSyncTexEnabled={props.onReverseSyncTex !== undefined}
      {...(activeItemId === undefined ? {} : { activeOwnedAnnotationId: activeItemId })}
      {...(correspondingItemId === undefined ? {} : { correspondingOwnedAnnotationId: correspondingItemId })}
      onExistingAnnotationsDiscovery={onExistingAnnotationsDiscovery}
      inventoryRetryGeneration={inventoryRetryGeneration}
      documentGeneration={state.workflow.documentGeneration}
      referenceViewportHost={referenceViewportHost}
      activeReferenceTabIdentity={navigationState.activeTabIdentity}
      onReferenceDocumentControls={onReferenceDocumentControls}
      onReferenceManualScroll={() => navigationCoordinator.observeReferenceManualScroll()}
      referenceManualScrollObserver={referenceManualScrollObserverRef.current}
      onViewerNavigationInitialized={onViewerNavigationInitialized}
      onOutlineDiscovery={onOutlineDiscovery}
      onViewerInitialized={onViewerInitialized}
      onMainDocumentReady={onMainDocumentReady}
      {...(props.onViewerError === undefined ? {} : { onViewerError: props.onViewerError })}
      onViewerFramingInitialized={onViewerFramingInitialized}
      searchResults={searchResults}
      mainDestinationBand={currentDestinationBands?.main ?? null}
      referenceDestinationBand={activeReferenceDestinationBand}
    />
  );

  const openAnnotationReference = useCallback((identity: AnnotationReaderIdentity) => {
    if (!referencesEnabled) return;
    const request = annotationReferenceRequest(identity, {
      items: stateRef.current.items,
      existingAnnotations,
      documentGeneration: documentGenerationRef.current,
      pageCount: viewerState.totalPages,
      pages: captureDocumentOrderPages(),
    });
    if (request === null) {
      setNavigationAnnouncement('Annotation passage unavailable.');
      return;
    }
    void navigationCoordinator.openReference(
      request.target,
      request.metadata,
      null,
      {
        annotationIdentity: identity,
        onSettled: ({ token, documentGeneration, tabIdentity }) => {
          if (documentGeneration !== documentGenerationRef.current) return;
          const tab = navigationStateRef.current.tabs.find(
            (candidate) => candidate.identity === tabIdentity,
          );
          replaceReferenceInspection({
            token,
            identity,
            surface: { kind: 'reference', documentGeneration, tabIdentity },
            ...(tab === undefined ? {} : { referenceRecovery: frozenReferenceRecovery(tab) }),
            pageIndex: request.pageIndex,
            selected: true,
          });
        },
      },
    );
  }, [
    existingAnnotations,
    captureDocumentOrderPages,
    navigationCoordinator,
    replaceReferenceInspection,
    referencesEnabled,
    viewerState.totalPages,
  ]);
  const authoringSurface = selectionUpdate.kind === 'reliable'
    ? currentAnnotationSurface(selectionUpdate.surface) ?? undefined
    : currentAnnotationSurface(caretSurface) ?? undefined;
  const authoringReferenceRecovery = referenceRecoveryForSurface(authoringSurface);

  const activateSearchResult = (result: PdfSearchResult) => {
    const target = pdfSearchResultTarget(result, navigationState.documentGeneration);
    if (target === null) return;
    search.selectResult(result.id);
    void navigationCoordinator.navigateMainTarget(target, 'search');
  };
  const openSearchResultReference = (result: PdfSearchResult) => {
    const target = pdfSearchResultTarget(result, navigationState.documentGeneration);
    if (target === null) return;
    const selectedResult = searchResults.find(({ id }) => id === searchState.selectedResultId);
    const selectedTarget = selectedResult
      ? pdfSearchResultTarget(selectedResult, navigationState.documentGeneration)
      : null;
    setSearchNavigationIntentToken((token) => token + 1);
    setTimeout(() => {
      void navigationCoordinator.openReference(target, {
        label: result.matchedForm || `Search result on page ${result.pageIndex + 1}`,
        pageContext: `Page ${result.pageIndex + 1}`,
      }, selectedTarget);
    }, 0);
  };
  const writePlacekeeperLink = async (link: string) => {
    if (navigator.clipboard?.writeText === undefined) {
      throw new Error('Clipboard API unavailable');
    }
    await navigator.clipboard.writeText(link);
  };
  const pdfTargetCopyLinkContext: PdfTargetCopyLinkContext | undefined =
    props.session.appLinkBase === undefined ? undefined : {
      appLinkBase: props.session.appLinkBase,
      document: {
        documentGeneration: documentGenerationRef.current,
        pageCount: viewerState.totalPages,
      },
      currentDocumentGeneration: () => documentGenerationRef.current,
      writeText: writePlacekeeperLink,
    };
  const copyLinkForSearchResult = pdfTargetCopyLinkContext === undefined
    ? undefined
    : (result: PdfSearchResult) => createSearchResultRowCopyLink(result, pdfTargetCopyLinkContext);
  const copyLinkForOutlineItem = pdfTargetCopyLinkContext === undefined
    ? undefined
    : (item: Parameters<typeof createOutlineRowCopyLink>[0]) => (
      createOutlineRowCopyLink(item, pdfTargetCopyLinkContext)
    );
  const copyLinkForLinkAction = pdfTargetCopyLinkContext === undefined
    ? undefined
    : (request: ViewerPdfLinkInvocation) => {
      const copyLink = createPdfTargetCopyLink(request.target, pdfTargetCopyLinkContext);
      if (copyLink === undefined) return undefined;
      const page = request.target.pageIndex + 1;
      return {
        ...copyLink,
        ariaLabel: copyLink.precision === 'exact'
          ? `Copy link to exact destination on page ${page}`
          : `Copy link to target page ${page}`,
        title: copyLink.precision === 'exact'
          ? 'Copy exact destination link'
          : 'Copy target page link',
      };
    };
  const searchWorkspace = (
    <PdfSearchWorkspace
      state={searchState}
      onQueryChange={submitSearchQuery}
      onResultActivate={activateSearchResult}
      onResultOpenReference={openSearchResultReference}
      {...(copyLinkForSearchResult === undefined ? {} : { copyLinkForResult: copyLinkForSearchResult })}
      onAlternativeActivate={(alternative) => submitSearchQuery(alternative.query, true)}
    />
  );

  const effectiveReferenceLayout = deriveReferenceWorkspaceLayout(
    referenceLayoutState,
    rightWorkspaceMode,
    navigationState.workspace.lastMode,
  );
  const referencePdfVisible = referencePdfIsVisible(referenceLayoutState, navigationState);
  useEffect(() => {
    refreshAuthoringAnchorNavigation();
  }, [
    navigationState.activeTabIdentity,
    referencePdfVisible,
    refreshAuthoringAnchorNavigation,
  ]);
  useEffect(() => {
    if (referencePdfVisible) return;
    setReferenceCopySelection(null);
    setPdfCopyOwner((owner) => owner === 'reference' ? null : owner);
  }, [referencePdfVisible]);
  const pdfCopySnapshots: PdfCopySnapshots = useMemo(() => ({
    main: mainCopySelection,
    reference: referenceCopySelection,
  }), [mainCopySelection, referenceCopySelection]);
  const copyMainSelectionFromPalette = useCallback(() => {
    paletteCopyOwnerRef.current = 'main';
    let copied = false;
    try {
      // Embedded browsers may deny the async Clipboard API while still allowing
      // the user-initiated copy event path used by the platform shortcut.
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      paletteCopyOwnerRef.current = null;
    }
    setPdfCopyOwner('main');
    if (!copied) {
      setPdfCopyAnnouncement('');
      setPdfCopyError('Placekeeper could not copy the selected text. Try Command-C instead.');
    }
  }, []);
  useEffect(() => {
    if (mainCopySelection !== null && mainCopySelection.kind !== 'cleared'
      && referenceCopySelection !== null && referenceCopySelection.kind !== 'cleared') {
      setPdfCopyOwnerIndicatorVisible(true);
    }
  }, [mainCopySelection, referenceCopySelection]);
  useEffect(() => {
    let copyEventRevision = 0;
    const commandForTarget = (target: EventTarget | null) => {
      const nativeSelection = window.getSelection();
      return resolvePdfCopyCommand({
        nativeCopyHasPrecedence: nativeCopyHasPrecedence({
          editableTarget: isEditableTarget(target),
          domSelectionCollapsed: nativeSelection?.isCollapsed ?? true,
          domSelectionText: nativeSelection?.toString() ?? '',
          domSelectionOwnedByPdf: nativeSelectionBelongsToPdfBridge(nativeSelection),
        }),
        owner: paletteCopyOwnerRef.current ?? pdfCopyOwner,
        snapshots: pdfCopySnapshots,
      });
    };
    let shortcutCommand: ReturnType<typeof commandForTarget> | null = null;
    const handleCopy = (event: ClipboardEvent) => {
      copyEventRevision += 1;
      const activeOwner = paletteCopyOwnerRef.current ?? pdfCopyOwner;
      const command = shortcutCommand ?? commandForTarget(event.target);
      applyPdfCopyCommand(command, event, {
        onPending: () => setPdfCopyAnnouncement(
          'Selected text is still being read. Retry Copy when it is ready.',
        ),
        onError: (kind) => {
          setPdfCopyError(kind === 'over-limit'
            ? PDF_SELECTION_PAGE_LIMIT_MESSAGE
            : 'Selected PDF text is unavailable. Reselect the text and try Copy again.');
        },
      });
      if (command.kind === 'copy') {
        setPdfCopyError(null);
        setPdfCopyAnnouncement(
          `Copied selected text from ${activeOwner === 'main' ? 'Main PDF' : 'Reference PDF'}.`,
        );
      }
    };
    const handleCopyShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey
        || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;
      const command = commandForTarget(event.target);
      if (command.kind === 'default' || isEditableTarget(event.target)) return;
      // WebKit on Linux does not dispatch Copy for a non-editable DOM selection.
      // Invoke the browser command within this user gesture; the same copy handler
      // retains native clipboard access, selection limits, and pending/error feedback.
      const revision = copyEventRevision;
      // Chromium may target the last editable field when there is no bridge text
      // (pending or rejected selection). Preserve the actual shortcut's target decision.
      shortcutCommand = command;
      try {
        document.execCommand('copy');
      } finally {
        shortcutCommand = null;
      }
      if (copyEventRevision !== revision) event.preventDefault();
    };
    window.addEventListener('copy', handleCopy);
    window.addEventListener('keydown', handleCopyShortcut);
    return () => {
      window.removeEventListener('copy', handleCopy);
      window.removeEventListener('keydown', handleCopyShortcut);
    };
  }, [pdfCopyOwner, pdfCopySnapshots]);
  const activeReferenceReturn = referenceReturnForActiveTab(
    navigationState,
    referenceReturnState,
  );
  const anyTrayOpen = effectiveReferenceLayout.kind === 'narrow-unified'
    ? effectiveReferenceLayout.open
    : effectiveReferenceLayout.rightWorkspaceOpen || effectiveReferenceLayout.bottomReferencesOpen;
  const onInitialFitComplete = useCallback((generation: number) => {
    if (generation !== documentGenerationRef.current) return;
    setInitialFitRequest(undefined);
    setInitialViewReady(true);
  }, []);
  const onCommitMainFramingPositionChange = useCallback((commit: (() => void) | null) => {
    commitMainFramingPositionRef.current = commit ?? (() => undefined);
  }, []);
  return (
    <main
      data-production-review
      data-initial-view-ready={initialViewReady}
      data-location-restore-status={locationRestoreStatus}
      inert={availableModes !== null && !initialViewReady}
      data-launch-surface={scope.launchSurface ?? 'browser'}
      ref={productionRootRef}
      onWheelCapture={() => {
        if (restoringLocationGenerationRef.current === documentGenerationRef.current) {
          readingUserMovementRef.current += 1;
        }
      }}
      onPointerDownCapture={(event) => {
        const surface = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pdf-copy-surface]')?.dataset.pdfCopySurface
          : undefined;
        setPdfCopyOwner(surface === 'main' || surface === 'reference' ? surface : null);
      }}
      onFocusCapture={(event) => {
        const surface = event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-pdf-copy-surface]')?.dataset.pdfCopySurface
          : undefined;
        setPdfCopyOwner(surface === 'main' || surface === 'reference' ? surface : null);
      }}
    >
      <NativePdfSelectionBridge owner={pdfCopyOwner} snapshots={pdfCopySnapshots} />
      <ReviewShell
        state={state}
        {...(props.activeAuthoringDraftIds === undefined ? {} : {
          activeAuthoringDraftIds: props.activeAuthoringDraftIds,
        })}
        documentTitle={scope.documentTitle}
        generationRefreshStatus={props.generationRefreshStatus ?? 'idle'}
        locationRestoreStatus={locationRestoreStatus}
        toolError={pdfCopyError ?? commandError}
        commandNotice={commandNotice}
        commandModalOpen={(!exportOnly && destinationDialog !== null) || annotationExport.request !== null}
        {...(props.onCommandSurfaceChange === undefined
          ? {}
          : { onCommandSurfaceChange: props.onCommandSurfaceChange })}
        {...(props.commandInvocation === undefined
          ? {}
          : { commandInvocation: props.commandInvocation })}
        {...(props.accessibilityTransition === undefined
          ? {}
          : { accessibilityTransition: props.accessibilityTransition })}
        {...(props.hostExportRequestToken === undefined ? {} : {
          documentActionsRequestToken: props.hostExportRequestToken,
        })}
        {...(props.onHostExportRequestHandled === undefined ? {} : {
          onDocumentActionsRequestHandled: props.onHostExportRequestHandled,
        })}
        {...(scope.launchSurface === 'codex'
          ? { codexContext: visibleCodexContext(codexContext, state) ?? UNAVAILABLE_CODEX_CONTEXT }
          : {})}
        {...(copyLinkBase === undefined || locationHistory === undefined ? {} : {
          ...(scope.launchSurface === 'chrome' ? {} : {
            copyLink: {
              disabled: navigationState.pendingMainNavigation !== null
                || navigationState.pendingSendToMain !== null,
              getLink: () => {
                mainLocationRefresh.flush();
                return buildPlacekeeperCopyLink(
                  copyLinkBase,
                  navigationCoordinator.currentLinkLocation(),
                );
              },
              writeText: writePlacekeeperLink,
            },
          }),
          copyItemLink: {
            getLink: (item: ReviewItem) => buildPlacekeeperCopyLink(
              copyLinkBase,
              {
                kind: 'item',
                page: item.pageIndex + 1,
                itemId: item.id,
              },
            ),
            disabled: (item: ReviewItem) => !portableItemIdsRef.current.has(item.id)
              || !saveStatusIsCleanCurrent(state, saveStatus),
            writeText: writePlacekeeperLink,
          },
        })}
        existingAnnotations={existingAnnotations}
        onOpenAnnotationReference={openAnnotationReference}
        referenceInspection={referenceInspection}
        onReferenceInspectionDismiss={(token, restoreFocus) => {
          const current = referenceInspectionRef.current;
          suppressedReferenceInspectionFocusRef.current = restoreFocus === true && current?.token === token
            ? { identity: current.identity, surface: current.surface, expiresAt: Date.now() + 500 }
            : null;
          dismissReferenceInspection(token, true);
        }}
        onReferenceInspectionHoldChange={(token, held) => {
          if (referenceInspectionRef.current?.token !== token) return;
          referenceInspectionHeldTokenRef.current = held ? token : null;
          if (held) cancelReferenceInspectionDismiss();
          else if (!referenceInspectionRef.current.selected) scheduleReferenceInspectionDismiss(token);
        }}
        onReferenceInspectionSelect={(token) => {
          const current = referenceInspectionRef.current;
          if (current?.token !== token) return;
          cancelReferenceInspectionDismiss();
          const selected = pinReferenceInspection(current, token);
          referenceInspectionRef.current = selected;
          setReferenceInspection(selected);
          const selectedCorrespondence = selectedReferenceInspectionCorrespondence(selected);
          if (selectedCorrespondence !== undefined) publishCorrespondence(selectedCorrespondence);
        }}
        activeItemId={activeItemId ?? null}
        {...(contentCorrespondingItemId === undefined
          ? {}
          : { correspondingItemId: contentCorrespondingItemId })}
        {...(activationRequest === undefined ? {} : { activationRequest })}
        onRetryExistingAnnotations={() => setInventoryRetryGeneration((generation) => generation + 1)}
        onItemCorrespondenceChange={(id) => {
          rowCorrespondenceRef.current = id;
          publishCorrespondence();
        }}
        onActiveItemChange={setActiveItemId}
        onNavigate={(item) => {
          const target = reviewItemNavigationTarget(item);
          if (target === null) return;
          const portable = portableItemIdsRef.current.has(item.id)
            && saveStatusIsCleanCurrent(state, saveStatus);
          void navigationCoordinator.navigateMainAnnotation({
            ...target,
            ...(portable
              ? { portableItemId: item.id }
              : { linkFallbackNotice: 'The shareable link uses this page until the item is saved.' }),
          });
        }}
        onNavigateExisting={(annotation: ExistingAnnotation) => {
          void navigationCoordinator.navigateMainAnnotation({
            pageIndex: annotation.pageIndex,
            point: { x: annotation.rect.x, y: annotation.rect.y },
            linkFallbackNotice: 'External PDF annotations use page links.',
          });
        }}
        save={{
          savedLabel: exportOnly
            ? 'Export to keep your annotations'
            : state.workflow.mode === 'generated-output' ? 'Protected review state' : 'Saved',
          savePhase: exportOnly
            ? 'not-saved'
            : state.workflow.mode === 'generated-output' ? 'clean' : saveStatus.sync.phase,
          exportOnly,
          ...(!exportOnly && state.workflow.mode !== 'generated-output'
            && saveStatus.sync.phase === 'not-saved' && saveStatus.destination.phase === 'active'
            ? {
              saveRecovery: {
                pending: destinationEstablishing,
                ...(destinationError === undefined ? {} : { error: destinationError }),
                onRetry: retrySave,
                onSaveCopy: () => openCopyDialog('menu'),
              }
            }
            : {}),
          savePendingDestination: state.workflow.mode !== 'generated-output'
            && scope.sourceDisposition === 'remote-temporary'
            && saveStatus.destination.phase === 'none'
            && saveStatus.sync.phase === 'not-saved',
          saveOptionsOpen: state.workflow.mode === 'generated-output' || exportOnly
            ? false
            : destinationDialog !== null,
          ...(state.workflow.mode === 'generated-output' || exportOnly
            ? {}
            : { onSaveOptions: () => openCopyDialog("menu") }),
          onExportReviewedCopy: annotationExport.open,
        }}
        selection={{
          onSelectionPageLimitExceeded: () => setCommandError(PDF_SELECTION_PAGE_LIMIT_MESSAGE),
          onCopySelection: copyMainSelectionFromPalette,
          pdfCopyOwner,
          pdfCopySnapshots,
          pdfCopyOwnerIndicatorVisible,
          pdfCopyAnnouncement,
          selectionUpdate,
          selectionPlacement,
          caretAnchor: caret,
          caretPlacement,
          onSelectionConsumed: (generation) => {
            const currentSelection = selectionUpdateRef.current;
            if (currentSelection.kind !== "reliable" || currentSelection.generation !== generation) return;
            const registry = viewerRegistry.current;
            if (!registry) return;
            const surface = currentSelection.surface;
            const documentId = surface?.kind === 'reference'
              ? REFERENCE_PDF_DOCUMENT_ID
              : MAIN_PDF_DOCUMENT_ID;
            registry.getPlugin<SelectionPlugin>(SelectionPlugin.id)?.provides()?.clear(documentId);
          },
        }}
        authoring={{
          ...(authoringSurface === undefined ? {} : { surface: authoringSurface }),
          ...(authoringReferenceRecovery === undefined
            ? {}
            : { referenceRecovery: authoringReferenceRecovery }),
          ...(interactionLifecycleRequired ? { interactionLifecycleRequired: true } : {}),
          ...(interactionLifecycle === undefined ? {} : {
            interactionLifecycle,
            ...(props.api.subscribeInteractionReconnect === undefined ? {} : {
              subscribeInteractionReconnect: props.api.subscribeInteractionReconnect,
            }),
            interactionFinalizationReady: state.workflow.mode === 'generated-output'
              || exportOnly
              || saveStatus.destination.phase !== 'none',
            interactionPersistenceRequired: saveStatus.destination.phase === 'active'
              && !exportOnly
              && state.workflow.mode !== 'generated-output',
            onInteractionFinalizationPrerequisite: () => openCopyDialog('first-annotation'),
          }),
          pageMenu: pageMenu === null ? null : {
            invocationId: pageMenu.invocationId,
            placement: pageMenu.placement,
            pageIndex: pageMenu.point.pageIndex,
            position: { x: pageMenu.point.x, y: pageMenu.point.y, width: 18, height: 18 },
            surface: pageMenu.surface,
            ...(pageMenu.referenceRecovery === undefined
              ? {}
              : { referenceRecovery: pageMenu.referenceRecovery }),
          },
          ...(props.onReverseSyncTex === undefined ? {} : {
            onGoToSource: (menu: {
              readonly pageIndex: number;
              readonly position: { readonly x: number; readonly y: number };
            }) => {
              requestReverseSyncTex({
                pageIndex: menu.pageIndex,
                point: { x: menu.position.x, y: menu.position.y },
              });
            },
          }),
          placedPageNote,
          keyboardPageNoteActive,
          onRequestKeyboardPageNote: () => {
            if (!authoringEnabled) return;
            if (pageMenu) placementAuthority.current.dismissContext(pageMenu.invocationId);
            setPageMenu(null);
            placementAuthority.current.clearKeyboardCursor();
            const activeReferenceIdentity = navigationStateRef.current.activeTabIdentity;
            const surface = pdfCopyOwner === 'reference'
              && activeReferenceIdentity !== null
              && referencePdfIsVisible(referenceLayoutStateRef.current, navigationStateRef.current)
              ? {
                  kind: 'reference' as const,
                  documentGeneration: documentGenerationRef.current,
                  tabIdentity: activeReferenceIdentity,
                }
              : mainPdfAnnotationSurface(documentGenerationRef.current);
            setKeyboardPageNoteSurface(surface);
            setKeyboardPageNoteActive(true);
          },
          onCancelKeyboardPageNote: () => {
            placementAuthority.current.clearKeyboardCursor();
            setKeyboardPageNoteActive(false);
            setKeyboardPageNoteSurface(undefined);
          },
          onPageMenuDismiss: (invocationId) => {
            placementAuthority.current.dismissContext(invocationId);
            setPageMenu((current) => current?.invocationId === invocationId ? null : current);
          },
          onPageMenuConsumed: (invocationId) => {
            const point = placementAuthority.current.consumeContextPoint(invocationId);
            if (!point) return;
            setPageMenu(null);
          },
          onPlacedPageNoteConsumed: (token) => {
            setPlacedPageNote((current) => current?.token === token ? null : current);
          },
          ...(authoringSessionResolution === undefined
            ? {}
            : { authoringSessionResolution }),
          ...(saveStatus.sync.phase === 'clean'
            ? { persistedRevision: saveStatus.sync.savedRevision }
            : {}),
          onAuthoringAnchorChange,
          onAuthoringActiveChange: (active) => {
            authoringActiveRef.current = active;
            if (!active) replayDeferredReferenceOwnedHover();
          },
          onAuthoringPreviewChange: setAuthoringPreview,
          onAuthoringViewportChange,
          ...(authoringAnchorNavigation === null ? {} : {
            authoringAnchorNavigation: {
              ...authoringAnchorNavigation,
              onReturn: () => {
                void returnToAuthoringAnchor(authoringAnchorNavigation.token);
              },
              onCancelReturn: () => cancelAuthoringAnchorReturn(authoringAnchorNavigation.token),
            },
          }),
          onPageNoteComposerComplete: () => {
            placementAuthority.current.clear();
            setPageMenu(null);
            setKeyboardPageNoteActive(false);
            setKeyboardPageNoteSurface(undefined);
          },
          onCommand: async (command, authority) => {
            const currentState = stateRef.current;
            const currentAuthority = authoringAuthorityFor(
              currentState,
              documentGenerationRef.current,
            );
            if (
              authority !== undefined
              && !authoringAuthorityMatches(authority, currentAuthority)
            ) {
              return {
                accepted: false,
                state: currentState,
                message: 'This draft belonged to the previous document and was not applied.',
                reason: 'stale-authoring',
              };
            }
            // Protected drafts are semantic recovery state and do not establish
            // a physical PDF destination. Applying one still requires the
            // ordinary destination prerequisite before broker finalization.
            const gated = command.type === 'put-draft'
              ? { kind: 'submit' as const, command }
              : gateReviewCommand(
              currentState,
              saveStatus,
              command,
              exportOnly
                ? 'ephemeral'
                : scope.sourceDisposition === 'remote-temporary' ? 'remote-temporary' : 'local',
              );
            if (gated.kind === "choose-destination") {
              openCopyDialog("first-annotation", {
                command,
                authority: authority ?? currentAuthority,
              });
              return {
                accepted: false,
                state: currentState,
                message: "Choose where annotations should be saved.",
                reason: 'save-destination',
              };
            }
            const result = await props.api.command(command);
            if (
              authority !== undefined
              && !authoringAuthorityMatches(
                authority,
                authoringAuthorityFor(stateRef.current, documentGenerationRef.current),
              )
            ) {
              return {
                accepted: false,
                state: stateRef.current,
                message: 'This draft belonged to the previous document and was not applied.',
                reason: 'stale-authoring',
              };
            }
            const next = "accepted" in result ? result.state : result;
            setState(next);
            if (!("accepted" in result)) {
              const nextSaveStatus = await props.api.saveStatus();
              setSaveStatus(nextSaveStatus);
              if (gated.kind === 'submit-and-choose-destination') {
                openCopyDialog("first-annotation");
              }
              if (acceptedAuthoringCommandRequiresPersistence(
                next,
                nextSaveStatus,
                authority !== undefined
                  && !exportOnly
                  && state.workflow.mode !== 'generated-output',
              )) {
                setCommandError(null);
                return {
                  accepted: false,
                  state: next,
                  message: 'The annotation is waiting to be saved to the PDF.',
                  reason: 'persistence-pending',
                };
              }
            }
            setCommandError("accepted" in result ? result.message : null);
            return result;
          },
        }}
        viewer={{
          ...(viewerControlsRef.current === undefined ? {} : { viewerControls: viewerControlsRef.current }),
          ...(viewerFraming === undefined ? {} : { viewerFraming }),
          ...(mainNavigation === null ? {} : { viewerNavigation: mainNavigation }),
          ...(referenceNavigation === null ? {} : { referenceNavigation }),
          viewerState,
          viewerNavigationIntentToken: searchNavigationIntentToken,
          onCommitMainFramingPositionChange,
          ...(initialFitRequest === undefined ? {} : { initialFitRequest }),
          onInitialFitComplete,
        }}
        workspace={{
          workspaceOpen: anyTrayOpen,
          referenceLayoutState,
          rightWorkspaceMode,
          search: searchWorkspace,
          onReferenceLayoutAction: dispatchLayout,
          navigationState,
          referenceTabs: navigationState.tabs.map((tab) => ({
            identity: tab.identity,
            label: tab.label ?? `Page ${tab.originalTarget.pageIndex + 1}`,
            pageContext: tab.pageContext ?? `Page ${tab.originalTarget.pageIndex + 1}`,
            pageNumber: tab.originalTarget.pageIndex + 1,
          })),
          pendingReference,
          referenceReturn: activeReferenceReturn,
          outlineDiscovery,
          currentOutlineItemId,
          linkActionRequest,
          linkDescription,
          linkActionBusy,
          renderDestinationSnippet,
          navigationAnnouncement,
          canNavigateBack: locationHistory === undefined
            ? navigationState.mainHistory.index > 0
            : locationHistorySnapshot.canBack,
          canNavigateForward: locationHistory === undefined
            ? navigationState.mainHistory.index >= 0
            && navigationState.mainHistory.index < navigationState.mainHistory.entries.length - 1
            : locationHistorySnapshot.canForward,
          documentNavigationPending: navigationState.pendingMainNavigation !== null,
          onLinkActionChoose: (choice, request) => {
            if (authoringActiveRef.current && choice === 'references') return;
            void navigationCoordinator.chooseLink(choice, request, {
              preserveWorkspace: authoringActiveRef.current,
            });
          },
          onLinkActionDismiss: (request) => navigationCoordinator.dismissLink(request),
          ...(copyLinkForLinkAction === undefined ? {} : { copyLinkForLinkAction }),
          onNavigateBack: () => {
            void navigationCoordinator.historyBack(
              authoringActiveRef.current ? authoringViewportRef.current ?? undefined : undefined,
            );
          },
          onNavigateForward: () => {
            void navigationCoordinator.historyForward(
              authoringActiveRef.current ? authoringViewportRef.current ?? undefined : undefined,
            );
          },
          onWorkspaceModeChange: (mode) => {
            if (availableModes !== null && !availableModes.includes(mode)) return;
            if (mode === 'references') {
              void navigationCoordinator.openReferencesWorkspace();
              return;
            }
            if (mode === 'search') {
              search.prepare();
            }
            setRightWorkspaceMode(mode);
            dispatchNavigation({ type: 'select-workspace-mode', mode });
            if (referenceLayoutState.regime !== 'narrow' || !referenceLayoutState.narrowOpen) {
              dispatchLayout({ type: 'show-right-workspace' });
            }
            dispatchLayout({ type: 'focus-surface', surface: 'right' });
          },
          onWorkspaceDismiss: () => {
            dispatchLayout({ type: 'hide-references' });
            dispatchNavigation({
              type: 'hide-workspace',
              focusReturnToken: referenceLayoutState.regime === 'narrow'
                || referenceLayoutState.referenceDock === 'bottom'
                ? BOTTOM_REFERENCES_RAIL_FOCUS_TOKEN
                : RIGHT_WORKSPACE_RAIL_FOCUS_TOKEN,
            });
          },
          onReferenceTabActivate: (identity) => {
            void navigationCoordinator.switchReference(identity);
          },
          onReferenceTabClose: (identity) => {
            void navigationCoordinator.closeReference(identity);
          },
          onReferenceSendToMain: (identity) => {
            void navigationCoordinator.sendToMain(identity);
          },
          onReferenceRetry: () => { void navigationCoordinator.retryReference(); },
          onReferenceReturn: (identity) => {
            void navigationCoordinator.returnToReference(identity);
          },
          onOutlineActivate: (item) => {
            if (item.target === null) navigationCoordinator.unavailableDestination();
            else void navigationCoordinator.navigateMainTarget(item.target, 'outline');
          },
          onOutlineReference: (item) => {
            if (!referencesEnabled) return;
            if (item.target === null) return;
            void navigationCoordinator.openReference(item.target, {
              label: item.label,
              pageContext: item.pageContext ?? `Page ${item.target.pageIndex + 1}`,
            });
          },
          ...(copyLinkForOutlineItem === undefined ? {} : { copyLinkForOutlineItem }),
          onReferenceViewportHost: setReferenceViewportHost,
          onWorkspaceModeFocusTokenChange: (mode, token) => {
            const current = navigationStateRef.current.workspace.modes[mode];
            dispatchNavigation({
              type: 'remember-workspace-view',
              mode,
              logicalScrollToken: current.logicalScrollToken,
              logicalFocusToken: token,
            });
            dispatchLayout({
              type: 'focus-surface',
              surface: mode === 'references' ? 'references' : 'right',
            });
          },
        }}
      >
        {viewer}
      </ReviewShell>
      {annotationExport.request === null ? null : <ExportAnnotationDialog
        annotationName={state.annotationName}
        pending={annotationExport.pending}
        error={annotationExport.error}
        onConfirm={(name) => void annotationExport.confirm(name)}
        onCancel={annotationExport.cancel}
      />}
      {exportOnly ? null : <SaveDestinationDialog
        open={destinationDialog !== null}
        {...(state.annotationName === undefined ? {} : { annotationName: state.annotationName })}
        {...(destination.nameError === undefined ? {} : { nameError: destination.nameError })}
        sourceDisposition={scope.sourceDisposition === 'remote-temporary' ? 'remote-temporary' : 'local'}
        protectedRecovery={
          scope.sourceDisposition === 'remote-temporary'
          && saveStatus.destination.phase === 'none'
          && saveStatus.sync.phase === 'not-saved'
        }
        {...(copyProposal === undefined ? {} : { proposal: copyProposal })}
        establishing={destinationEstablishing}
        {...(saveStatus.rewriteEligibility === undefined
          ? {}
          : { rewriteEligibility: saveStatus.rewriteEligibility })}
        {...(destinationError === undefined ? {} : { error: destinationError })}
        {...(saveStatus.sync.phase === "not-saved" && saveStatus.destination.phase === "active"
          ? {
              recoveryTarget: saveStatus.destination.targetPath.split(/[\\/]/u).at(-1)!,
              ...(saveStatus.sync.failure === undefined
                ? {}
                : { recoveryFailure: saveStatus.sync.failure }),
            }
          : {})}
        onRetry={retrySave}
        onLocate={destination.onLocate}
        onChooseLocation={destination.onChooseLocation}
        onCancel={destination.onCancel}
        onConfirm={destination.onConfirm}
      />}
    </main>
  );
}
