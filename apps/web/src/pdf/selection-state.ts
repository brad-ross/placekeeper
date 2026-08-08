import type { ReliabilityDiagnostic } from './text-reliability.js';
import type { SelectionAnchor, SelectionAnchorResult } from './selection-anchor.js';

export type SelectionUpdate =
  | { readonly kind: 'cleared'; readonly generation: number }
  | { readonly kind: 'pending'; readonly generation: number }
  | { readonly kind: 'reliable'; readonly generation: number; readonly anchor: SelectionAnchor }
  | {
      readonly kind: 'unreliable';
      readonly generation: number;
      readonly userMessage: string;
      readonly diagnostic: ReliabilityDiagnostic;
    };

export const INITIAL_SELECTION_UPDATE: SelectionUpdate = {
  kind: 'cleared',
  generation: 0,
};

export const SELECTION_PENDING_MESSAGE = 'Reading the selected text…';

/** Keep parent mutation authority monotonic even if an obsolete callback arrives late. */
export function acceptSelectionUpdate(
  current: SelectionUpdate,
  next: SelectionUpdate,
): SelectionUpdate {
  if (next.generation < current.generation) return current;
  if (next.generation > current.generation) return next;
  if (current.kind !== 'pending') return current;
  return next.kind === 'reliable' || next.kind === 'unreliable' ? next : current;
}

export function terminalSelectionUpdate(
  generation: number,
  result: SelectionAnchorResult,
): SelectionUpdate {
  return result.ok
    ? { kind: 'reliable', generation, anchor: result.anchor }
    : {
        kind: 'unreliable',
        generation,
        userMessage: result.userMessage,
        diagnostic: result.diagnostic,
      };
}

export function reliableSelection(update: SelectionUpdate): SelectionAnchor | null {
  return update.kind === 'reliable' ? update.anchor : null;
}

export function selectionReadinessMessage(update: SelectionUpdate): string | null {
  if (update.kind === 'pending') return SELECTION_PENDING_MESSAGE;
  if (update.kind === 'unreliable') return update.userMessage;
  return null;
}
