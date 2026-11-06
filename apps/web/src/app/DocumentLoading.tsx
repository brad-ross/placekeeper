/** Shared presentation for initial document preparation in every reader host. */
export function DocumentLoading() {
  return <div className="document-loading" role="status" aria-label="Opening document">
    <div className="document-loading__content">
      <span className="document-loading__indicator" aria-hidden="true" />
      <span>Opening document…</span>
    </div>
  </div>;
}
