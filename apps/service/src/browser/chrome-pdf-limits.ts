// Browser responses are untrusted and PDFium/Wasm memory is not bounded by
// V8's old-space flag. Keep remote inputs materially below local-file limits.
export const MAX_CHROME_PDF_BYTES = 64 * 1024 * 1024;
export const MAX_CHROME_STAGING_BYTES = 2 * MAX_CHROME_PDF_BYTES;
