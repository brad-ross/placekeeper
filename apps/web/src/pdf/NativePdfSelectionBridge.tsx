import { useLayoutEffect, useMemo, useRef } from 'react';

import type {
  PdfCopyOwner,
  PdfCopySnapshots,
} from './selection-state.js';
import { resolvePdfCopyCommand } from './selection-state.js';

interface NativePdfSelectionBridgeProps {
  readonly owner: PdfCopyOwner;
  readonly snapshots: PdfCopySnapshots;
}

function selectedPdfText(
  owner: PdfCopyOwner,
  snapshots: PdfCopySnapshots,
): string | null {
  const command = resolvePdfCopyCommand({
    nativeCopyHasPrecedence: false,
    owner,
    snapshots,
  });
  return command.kind === 'copy' && command.text.length > 0 ? command.text : null;
}

function selectionBelongsToElement(selection: Selection, element: HTMLElement): boolean {
  if (selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (
      !element.contains(range.startContainer)
      || !element.contains(range.endContainer)
    ) return false;
  }
  return true;
}

export function nativeSelectionBelongsToPdfBridge(selection: Selection | null): boolean {
  if (selection === null || selection.isCollapsed) return false;
  return Array.from(document.querySelectorAll<HTMLElement>('[data-pdf-native-selection-bridge]'))
    .some((element) => selectionBelongsToElement(selection, element));
}

function clearBridgeSelection(selection: Selection, element: HTMLElement): void {
  if (selectionBelongsToElement(selection, element)) selection.removeAllRanges();
}

/**
 * Mirror the focused semantic PDF selection into the browser's native Selection.
 * The off-screen range gives platform copy, lookup, and context-menu services the
 * exact semantic text without replacing EmbedPDF's visual/geometry selection.
 */
export function NativePdfSelectionBridge({
  owner,
  snapshots,
}: NativePdfSelectionBridgeProps) {
  const elementRef = useRef<HTMLSpanElement>(null);
  const text = useMemo(() => selectedPdfText(owner, snapshots), [owner, snapshots]);

  useLayoutEffect(() => {
    const element = elementRef.current;
    const selection = element?.ownerDocument.getSelection();
    if (!element || !selection) return;
    if (text === null) {
      clearBridgeSelection(selection, element);
      return;
    }

    const selectBridgeText = (force = false) => {
      if (
        !force
        && !selection.isCollapsed
        && !selectionBelongsToElement(selection, element)
      ) return;
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    selectBridgeText();

    const preserveForNativeMenu = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const surface = target.closest<HTMLElement>('[data-pdf-copy-surface]')
        ?.dataset.pdfCopySurface;
      if (surface === owner) selectBridgeText(true);
    };
    element.ownerDocument.addEventListener('contextmenu', preserveForNativeMenu, true);

    return () => {
      element.ownerDocument.removeEventListener('contextmenu', preserveForNativeMenu, true);
      clearBridgeSelection(selection, element);
    };
  }, [owner, text]);

  return (
    <span
      ref={elementRef}
      aria-hidden="true"
      data-pdf-native-selection-bridge={owner ?? 'none'}
      style={{
        position: 'fixed',
        left: '-10000px',
        top: 0,
        whiteSpace: 'pre',
        pointerEvents: 'none',
        userSelect: 'text',
        WebkitUserSelect: 'text',
      }}
    >
      {text ?? ''}
    </span>
  );
}
