/** Product limit shared by PDF Copy and selection-based review actions. */
export const PDF_SELECTION_PAGE_LIMIT = 12;

/**
 * Resource headroom for detecting an over-limit selection before product validation.
 * Cache eviction must never decide whether a 12- or 13-page selection is supported.
 */
export const PDF_SELECTION_GEOMETRY_CACHE_PAGE_LIMIT = PDF_SELECTION_PAGE_LIMIT + 4;

export const PDF_SELECTION_PAGE_LIMIT_MESSAGE =
  `Selections can span at most ${PDF_SELECTION_PAGE_LIMIT} pages. Shorten the selection and try again.`;
