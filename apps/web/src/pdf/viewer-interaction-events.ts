export type ViewerInteractionEvent =
  | { readonly type: 'readiness'; readonly ready: boolean; readonly reason?: string }
  | { readonly type: 'page'; readonly currentPage: number; readonly totalPages: number }
  | { readonly type: 'zoom'; readonly zoomPercent: number }
  | { readonly type: 'scroll' };

export type ViewerInteractionListener = (event: ViewerInteractionEvent) => void;
