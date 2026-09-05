export interface ReadinessRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function renderedPdfPageIsUsable(input: {
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  readonly pageRect: ReadinessRect;
  readonly viewportRect: ReadinessRect;
  readonly display: string;
  readonly visibility: string;
}): boolean {
  if (!input.complete || !positiveFinite(input.naturalWidth) || !positiveFinite(input.naturalHeight)
    || !positiveFinite(input.pageRect.width) || !positiveFinite(input.pageRect.height)
    || !positiveFinite(input.viewportRect.width) || !positiveFinite(input.viewportRect.height)
    || input.display === 'none' || input.visibility === 'hidden' || input.visibility === 'collapse') {
    return false;
  }
  const width = Math.min(input.pageRect.right, input.viewportRect.right)
    - Math.max(input.pageRect.left, input.viewportRect.left);
  const height = Math.min(input.pageRect.bottom, input.viewportRect.bottom)
    - Math.max(input.pageRect.top, input.viewportRect.top);
  return positiveFinite(width) && positiveFinite(height);
}
