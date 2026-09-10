import type { ReviewCommand, ReviewState } from '../../../../packages/core/src/review-model.js';
import { authoringAuthorityMatches, authoringAuthorityFor, type AuthoringAuthority } from '../review/authoring-session.js';
export type PendingDestinationOutcome =
  | 'cancelled'
  | 'accepted'
  | 'rejected'
  | 'source-replaced';

export function pendingDestinationDisposition(outcome: PendingDestinationOutcome): {
  readonly closeDialog: boolean;
  readonly notifyAuthoringShell: boolean;
  readonly preserveDraft: boolean;
} {
  if (outcome === 'cancelled') {
    return { closeDialog: true, notifyAuthoringShell: false, preserveDraft: true };
  }
  if (outcome === 'rejected') {
    return { closeDialog: true, notifyAuthoringShell: false, preserveDraft: true };
  }
  return { closeDialog: true, notifyAuthoringShell: true, preserveDraft: false };
}

export function pendingDestinationIsCurrent(
  pending: Pick<PendingAuthoringCommand, 'authority'>,
  state: Pick<ReviewState, 'sessionId' | 'source'>,
  documentGeneration: number,
): boolean {
  return authoringAuthorityMatches(
    pending.authority,
    authoringAuthorityFor(state, documentGeneration),
  );
}

export function pendingDestinationAttemptIsCurrent(
  attempt: number,
  currentAttempt: number,
  pending: Pick<PendingAuthoringCommand, 'authority'> | undefined,
  state: Pick<ReviewState, 'sessionId' | 'source'>,
  documentGeneration: number,
): boolean {
  return attempt === currentAttempt
    && (pending === undefined || pendingDestinationIsCurrent(
      pending,
      state,
      documentGeneration,
    ));
}

export interface PendingAuthoringCommand {
  readonly command: ReviewCommand;
  readonly authority: AuthoringAuthority;
}
