import type { ReviewRect } from '../../../../packages/core/src/review-commands.js';
import type { ReviewCommand, ReviewState } from '../../../../packages/core/src/review-model.js';
import type { ReviewAnnotation } from '../../../../packages/core/src/pdf-writer.js';
import type { PdfTargetVisibility, PdfViewportQuery } from '../pdf/viewer-navigation.js';
import type { ContextPlacement } from './ContextActionPalette.js';
import type { PdfAnnotationSurface } from '../pdf/annotation-surface.js';
import type {
  AuthoringAuthority,
  AuthoringAnchorSnapshot,
  AuthoringReferenceRecovery,
} from './authoring-session.js';
import type { RejectedReviewCommand } from './review-command-result.js';

export interface ReviewShellAuthoringModel {
  /** Current reliable gesture origin. A started session freezes this value. */
  surface?: PdfAnnotationSurface;
  /** Durable Reference passage metadata paired with the current gesture origin. */
  referenceRecovery?: AuthoringReferenceRecovery;
  pageMenu?: {
    readonly invocationId: string;
    readonly placement: ContextPlacement;
    readonly pageIndex: number;
    readonly position: ReviewRect;
    readonly nearbyText?: string;
    readonly surface?: PdfAnnotationSurface;
    readonly referenceRecovery?: AuthoringReferenceRecovery;
  } | null;
  placedPageNote?: {
    readonly token: number;
    readonly pageIndex: number;
    readonly position: ReviewRect;
    readonly nearbyText?: string;
    readonly surface?: PdfAnnotationSurface;
    readonly referenceRecovery?: AuthoringReferenceRecovery;
  } | null;
  keyboardPageNoteActive?: boolean;
  onRequestKeyboardPageNote?(): void;
  onCancelKeyboardPageNote?(): void;
  onPageMenuDismiss?(invocationId: string): void;
  onPageMenuConsumed?(invocationId: string): void;
  onGoToSource?(menu: NonNullable<ReviewShellAuthoringModel['pageMenu']>): void;
  onPlacedPageNoteConsumed?(token: number): void;
  onPageNoteComposerComplete?(): void;
  onCommand(
    command: ReviewCommand,
    authority?: AuthoringAuthority,
  ): Promise<ReviewState | RejectedReviewCommand>;
  authoringSessionResolution?: {
    readonly token: number;
    readonly outcome: 'accepted' | 'source-replaced';
  };
  /** Production-owned, read-only visibility/Return state for the active frozen anchor. */
  authoringAnchorNavigation?: {
    readonly token: number;
    readonly visibility: PdfTargetVisibility;
    readonly pending: boolean;
    readonly onReturn: () => void;
    readonly onCancelReturn?: () => void;
  };
  onAuthoringAnchorChange?(anchor: AuthoringAnchorSnapshot | null): void;
  onAuthoringActiveChange?(active: boolean): void;
  onAuthoringPreviewChange?(preview: readonly ReviewAnnotation[] | null): void;
  /** Publishes measured overlay geometry without changing viewer framing. */
  onAuthoringViewportChange?(viewport: PdfViewportQuery | null): void;
}
