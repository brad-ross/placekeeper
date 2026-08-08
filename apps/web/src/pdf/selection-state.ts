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

export class SelectionReadAuthority {
  private generation = 0;
  private active: { readonly documentId: string; readonly generation: number } | null = null;

  begin(documentId: string): { readonly generation: number; readonly started: boolean } {
    if (this.active?.documentId === documentId) {
      return { generation: this.active.generation, started: false };
    }
    const generation = ++this.generation;
    this.active = { documentId, generation };
    return { generation, started: true };
  }

  finish(documentId: string): number | null {
    if (this.active?.documentId !== documentId) return null;
    const { generation } = this.active;
    this.active = null;
    return generation;
  }

  invalidate(): Extract<SelectionUpdate, { readonly kind: 'cleared' }> {
    this.active = null;
    return { kind: 'cleared', generation: ++this.generation };
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

const SELECTION_PENDING_MESSAGE = 'Reading the selected text…';

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
