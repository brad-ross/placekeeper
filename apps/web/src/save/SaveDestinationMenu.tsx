import type { ProductionSaveStatus } from "../app/ProductionReviewApp.js";

export interface SaveDestinationMenuProps {
  readonly open: boolean;
  readonly documentTitle: string;
  readonly status: ProductionSaveStatus;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onCopy: () => void;
  readonly onOriginal: () => void;
  readonly onRetry: () => void;
  readonly onLocate: () => void;
}

function targetName(status: ProductionSaveStatus): string | undefined {
  if (status.destination.phase !== "active") return undefined;
  return status.destination.targetPath.split(/[\\/]/u).at(-1);
}

export function SaveDestinationMenu(props: SaveDestinationMenuProps) {
  if (!props.open) return null;
  const target = targetName(props.status);
  return (
    <section className="save-destination-menu" role="menu" aria-label="Save options">
      <header>
        <strong>{props.documentTitle}</strong>
        {props.status.destination.phase === "active" ? (
          <small title={props.status.destination.targetPath}>
            {props.status.destination.kind === "copy" ? `Saving to ${target}` : "Modifying the original"}
          </small>
        ) : <small>Choose where annotations should be saved</small>}
        {props.status.sync.phase === "not-saved" ? (
          <span className="save-destination-menu__warning">Not saved — your work is protected</span>
        ) : null}
      </header>
      {props.error ? <p className="save-destination-error" role="alert">{props.error}</p> : null}
      {props.status.sync.phase === "not-saved" && props.status.destination.phase === "active" ? (
        <>
          <button type="button" role="menuitem" onClick={props.onRetry}>Retry saving</button>
          <button type="button" role="menuitem" onClick={props.onLocate}>Locate saved PDF…</button>
        </>
      ) : null}
      <button type="button" role="menuitem" onClick={props.onCopy}>
        {props.status.destination.phase === "none" ? "Save to a copy" : "Save to another copy"}
      </button>
      <button type="button" role="menuitem" onClick={props.onOriginal}>Modify the original PDF</button>
      <button type="button" role="menuitem" onClick={props.onClose}>Close</button>
    </section>
  );
}
