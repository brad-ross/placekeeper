import type { ReactNode } from "react";

import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import { ReviewIcon } from "../review/ReviewIcon.js";

export function CodexDrawer(props: {
  readonly state: Pick<ReviewState, "items">;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <aside
      id="review-finish-drawer"
      className="review-finish-drawer"
      data-codex-drawer
      data-surface-open={props.open ? "true" : "false"}
      aria-labelledby="codex-drawer-heading"
      aria-hidden={!props.open}
      inert={!props.open}
    >
      <header className="finish-review-drawer__header">
        <div>
          <p className="finish-review-drawer__eyebrow">Optional handoff</p>
          <h2 id="codex-drawer-heading">Work with Codex</h2>
        </div>
        <button type="button" className="finish-review-drawer__close" aria-label="Close Codex options" onClick={props.onClose}>
          <ReviewIcon name="close" />
        </button>
      </header>
      <p className="finish-review-drawer__summary">
        <strong>{props.state.items.length} annotation{props.state.items.length === 1 ? "" : "s"}</strong>
      </p>
      <p className="finish-review-drawer__guidance">
        Prepare a separate, frozen PDF and instruction bundle for Codex. This does not change where your annotations are saved.
      </p>
      <div className="finish-review-drawer__delivery-options">{props.children}</div>
    </aside>
  );
}
