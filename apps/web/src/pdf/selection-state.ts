import type { ReliabilityDiagnostic } from './text-reliability.js';
import type { SelectionAnchor, SelectionAnchorResult } from './selection-anchor.js';
import { PDF_SELECTION_PAGE_LIMIT } from './selection-page-limit.js';
import {
  samePdfAnnotationSurface,
  type PdfAnnotationSurface,
} from './annotation-surface.js';

export type SelectionUpdate = (
  | { readonly kind: 'cleared'; readonly generation: number }
  | { readonly kind: 'pending'; readonly generation: number }
  | { readonly kind: 'reliable'; readonly generation: number; readonly anchor: SelectionAnchor }
  | { readonly kind: 'over-limit'; readonly generation: number; readonly userMessage: string }
  | {
      readonly kind: 'unreliable';
      readonly generation: number;
      readonly userMessage: string;
      readonly diagnostic: ReliabilityDiagnostic;
    }
) & { readonly surface?: PdfAnnotationSurface };

export const INITIAL_SELECTION_UPDATE: SelectionUpdate = {
  kind: 'cleared',
  generation: 0,
};

/** @deprecated Import PdfAnnotationSurface for shared viewer-origin evidence. */
export type PdfCopySurface = PdfAnnotationSurface;

export type CopySelectionUpdate =
  | { readonly kind: 'cleared'; readonly surface: PdfCopySurface; readonly generation: number }
  | { readonly kind: 'pending'; readonly surface: PdfCopySurface; readonly generation: number }
  | {
      readonly kind: 'ready';
      readonly surface: PdfCopySurface;
      readonly generation: number;
      readonly text: string;
      readonly pageCount: number;
    }
  | { readonly kind: 'unavailable'; readonly surface: PdfCopySurface; readonly generation: number };

export interface PdfCopySnapshots {
  readonly main: CopySelectionUpdate | null;
  readonly reference: CopySelectionUpdate | null;
}

export type PdfCopyOwner = 'main' | 'reference' | null;

export type PdfCopyCommand =
  | { readonly kind: 'native' }
  | { readonly kind: 'default' }
  | { readonly kind: 'copy'; readonly text: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'over-limit' };

export function nativeCopyHasPrecedence(input: {
  readonly editableTarget: boolean;
  readonly domSelectionCollapsed: boolean;
  readonly domSelectionText: string;
  readonly domSelectionOwnedByPdf: boolean;
}): boolean {
  return input.editableTarget
    || (
      !input.domSelectionOwnedByPdf
      && !input.domSelectionCollapsed
      && input.domSelectionText.length > 0
    );
}

/** Keep one surface snapshot fenced to its exact document/tab and selection generation. */
export function acceptCopySelectionUpdate(
  current: CopySelectionUpdate | null,
  next: CopySelectionUpdate,
): CopySelectionUpdate {
  if (current === null) return next;
  if (!samePdfAnnotationSurface(current.surface, next.surface)) {
    return next.kind === 'cleared' ? next : current;
  }
  if (next.generation < current.generation) return current;
  if (next.generation > current.generation) return next;
  if (current.kind !== 'pending') return current;
  return next.kind === 'ready' || next.kind === 'unavailable' ? next : current;
}

export function copySelectionUpdateFromEvidence(
  surface: PdfCopySurface,
  generation: number,
  evidence: {
    readonly stable: boolean;
    readonly selection: {
      readonly start: { readonly page: number; readonly index?: number };
      readonly end: { readonly page: number; readonly index?: number };
    } | null;
    readonly pageCount: number;
    readonly pages: ReadonlyArray<{
      readonly pageIndex: number;
      readonly text: string | null;
      readonly sliceCount: number;
    }>;
    readonly text: readonly string[];
  },
): CopySelectionUpdate {
  const { selection } = evidence;
  const expectedPageCount = selection === null
    ? 0
    : selection.end.page - selection.start.page + 1;
  if (
    evidence.stable
    && selection !== null
    && evidence.pageCount === expectedPageCount
    && evidence.pageCount > PDF_SELECTION_PAGE_LIMIT
  ) {
    // Preserve a commandable over-limit snapshot without materializing text that
    // can never be copied. resolvePdfCopyCommand rejects it before clipboard I/O.
    return {
      kind: 'ready',
      surface,
      generation,
      text: '',
      pageCount: evidence.pageCount,
    };
  }
  const completePageText = selection !== null
    && evidence.pageCount === expectedPageCount
    && evidence.pages.length === expectedPageCount
    && evidence.text.length === expectedPageCount
    && evidence.pages.every((page, index) => (
      page.pageIndex === selection.start.page + index
      && page.sliceCount > 0
      && page.text !== null
      && page.text === evidence.text[index]
    ));
  if (!evidence.stable || !completePageText) {
    return { kind: 'unavailable', surface, generation };
  }
  return {
    kind: 'ready',
    surface,
    generation,
    text: evidence.text.join('\n'),
    pageCount: evidence.pageCount,
  };
}

export function resolvePdfCopyCommand(input: {
  readonly nativeCopyHasPrecedence: boolean;
  readonly owner: PdfCopyOwner;
  readonly snapshots: PdfCopySnapshots;
}): PdfCopyCommand {
  if (input.nativeCopyHasPrecedence) return { kind: 'native' };
  if (input.owner === null) return { kind: 'default' };
  const snapshot = input.snapshots[input.owner];
  if (snapshot === null || snapshot.kind === 'cleared') return { kind: 'default' };
  if (snapshot.kind === 'pending') return { kind: 'pending' };
  if (snapshot.kind === 'unavailable') return { kind: 'unavailable' };
  if (snapshot.pageCount > PDF_SELECTION_PAGE_LIMIT) return { kind: 'over-limit' };
  return { kind: 'copy', text: snapshot.text };
}

export function applyPdfCopyCommand(
  command: PdfCopyCommand,
  event: {
    readonly clipboardData: { setData(type: string, value: string): void } | null;
    preventDefault(): void;
  },
  callbacks: {
    readonly onPending: () => void;
    readonly onError: (kind: 'unavailable' | 'over-limit') => void;
  },
): void {
  if (command.kind === 'copy') {
    if (event.clipboardData === null) return;
    event.clipboardData.setData('text/plain', command.text);
    event.preventDefault();
    return;
  }
  if (command.kind === 'pending') {
    event.preventDefault();
    callbacks.onPending();
  } else if (command.kind === 'unavailable' || command.kind === 'over-limit') {
    event.preventDefault();
    callbacks.onError(command.kind);
  }
}

export class SelectionReadAuthority {
  private generation = 0;
  private active: {
    readonly documentId: string;
    readonly generation: number;
    readonly surface?: PdfAnnotationSurface;
  } | null = null;
  private currentSurface: PdfAnnotationSurface | undefined;

  begin(
    documentId: string,
    surface?: PdfAnnotationSurface,
  ): { readonly generation: number; readonly started: boolean } {
    if (this.active?.documentId === documentId
      && sameOptionalSurface(this.active.surface, surface)) {
      return { generation: this.active.generation, started: false };
    }
    const generation = ++this.generation;
    this.active = { documentId, generation, ...(surface === undefined ? {} : { surface }) };
    this.currentSurface = surface;
    return { generation, started: true };
  }

  finish(documentId: string, surface?: PdfAnnotationSurface): number | null {
    if (this.active?.documentId !== documentId
      || !sameOptionalSurface(this.active.surface, surface)) return null;
    const { generation } = this.active;
    this.active = null;
    return generation;
  }

  invalidate(surface?: PdfAnnotationSurface): Extract<SelectionUpdate, { readonly kind: 'cleared' }> {
    this.active = null;
    this.currentSurface = surface;
    return {
      kind: 'cleared',
      generation: ++this.generation,
      ...(surface === undefined ? {} : { surface }),
    };
  }

  invalidateIfCurrent(
    surface: PdfAnnotationSurface,
  ): Extract<SelectionUpdate, { readonly kind: 'cleared' }> | null {
    if (!sameOptionalSurface(this.currentSurface, surface)) return null;
    return this.invalidate(surface);
  }

  isCurrent(generation: number, surface?: PdfAnnotationSurface): boolean {
    return generation === this.generation
      && sameOptionalSurface(this.currentSurface, surface);
  }
}

function sameOptionalSurface(
  left: PdfAnnotationSurface | undefined,
  right: PdfAnnotationSurface | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return samePdfAnnotationSurface(left, right);
}

const SELECTION_PENDING_MESSAGE = 'Reading the selected text…';

/** Keep parent mutation authority monotonic even if an obsolete callback arrives late. */
export function acceptSelectionUpdate(
  current: SelectionUpdate,
  next: SelectionUpdate,
): SelectionUpdate {
  if (next.generation < current.generation) return current;
  if (next.generation > current.generation) return next;
  if (!sameOptionalSurface(current.surface, next.surface)) return current;
  if (current.kind !== 'pending') return current;
  return next.kind === 'reliable' || next.kind === 'over-limit' || next.kind === 'unreliable'
    ? next
    : current;
}

export function terminalSelectionUpdate(
  generation: number,
  result: SelectionAnchorResult,
): SelectionUpdate {
  if (result.ok) return { kind: 'reliable', generation, anchor: result.anchor };
  if (result.diagnostic === 'selection-page-limit-exceeded') {
    return { kind: 'over-limit', generation, userMessage: result.userMessage };
  }
  return {
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
  if (update.kind === 'over-limit') return update.userMessage;
  if (update.kind === 'unreliable') return update.userMessage;
  return null;
}
