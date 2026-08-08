import { createRoot } from "react-dom/client";
import { useState } from "react";

import { CodexDelivery } from "../../../apps/web/src/export/CodexDelivery.js";
import { FinishReviewDrawer } from "../../../apps/web/src/app/FinishReviewDrawer.js";
import { createReviewState, type ReviewState } from "../../../packages/core/src/review-model.js";

declare global {
  interface Window {
    codexHarness: {
      reset(): void;
      changeRetention(): void;
      makeEmpty(): void;
      prepared(): number;
      saved(): number;
      open(): void;
      close(): void;
      holdPrepare(): void;
      resolvePrepare(): void;
    };
  }
}

const empty = createReviewState({ sessionId: "00000000-0000-4000-8000-000000000099", source: { fileId: "file", digest: "a".repeat(64), byteLength: 10 } });
const feedback: ReviewState = {
  ...empty,
  revision: 1,
  items: [{
    id: "00000000-0000-4000-8000-000000000001", kind: "pageNote", pageIndex: 0,
    createdAt: "2026-08-07T12:00:00.000Z", updatedAt: "2026-08-07T12:00:00.000Z",
    payload: { position: { x: 1, y: 1, width: 10, height: 10 }, comment: "Review" },
  }],
};

let reset: (() => void) | undefined;
let changeRetention: (() => void) | undefined;
let makeEmpty: (() => void) | undefined;
let prepareCount = 0;
let saveCount = 0;
let setDrawerOpen: ((open: boolean) => void) | undefined;
let prepareHeld = false;
let releasePrepare: (() => void) | undefined;

function Harness() {
  const [key, setKey] = useState(0);
  const [state, setState] = useState(feedback);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [retention, setRetention] = useState("Keep until I delete it");
  const [drawerOpen, setOpen] = useState(true);
  setDrawerOpen = setOpen;
  reset = () => { setState(feedback); setKey((value) => value + 1); };
  changeRetention = () => { setRetention("Delete after check"); setKey((value) => value + 1); };
  makeEmpty = () => { setState(empty); setKey((value) => value + 1); };
  return <>
    {!drawerOpen ? <button type="button" onClick={() => setOpen(true)}>Open Finish</button> : null}
    <FinishReviewDrawer
      state={state}
      open={drawerOpen}
      onClose={() => setOpen(false)}
      onFinish={() => undefined}
      onDiscard={() => undefined}
    >
      <CodexDelivery
        key={key}
        state={state}
        sourceRoot="/tmp/source"
        provider="Codex"
        revisedPdfDestination="/tmp/result/paper-revised.pdf"
        retention={retention}
        confirmedScopeSignature={confirmed}
        onConfirmScope={setConfirmed}
        onPrepare={async () => {
          prepareCount += 1;
          if (prepareHeld) {
            await new Promise<void>((resolve) => {
              releasePrepare = resolve;
            });
          }
          return { prompt: "Full local instruction", handoffPath: "/tmp/result/handoff.json", handoffSha256: "b".repeat(64), reviewedPdfPath: "/tmp/paper-reviewed.pdf", reviewedPdfSha256: "c".repeat(64) };
        }}
        onSaveInstruction={() => { saveCount += 1; }}
        onCheckResult={async () => ({ status: "Complete", message: "Exact IDs, digests, changed paths, and clean output verified." })}
      />
    </FinishReviewDrawer>
  </>;
}

window.codexHarness = {
  reset: () => reset?.(),
  changeRetention: () => changeRetention?.(),
  makeEmpty: () => makeEmpty?.(),
  prepared: () => prepareCount,
  saved: () => saveCount,
  open: () => setDrawerOpen?.(true),
  close: () => setDrawerOpen?.(false),
  holdPrepare: () => {
    prepareHeld = true;
  },
  resolvePrepare: () => {
    prepareHeld = false;
    releasePrepare?.();
    releasePrepare = undefined;
  },
};

const root = document.querySelector("#root");
if (!root) throw new Error("Harness root missing");
createRoot(root).render(<Harness />);
