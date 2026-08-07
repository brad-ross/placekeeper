import { createRoot } from "react-dom/client";
import { useState } from "react";

import { HumanDelivery } from "../../../apps/web/src/export/HumanDelivery.js";
import { createReviewState, type ReviewState } from "../../../packages/core/src/review-model.js";

declare global {
  interface Window {
    deliveryHarness: {
      addFeedback(): void;
      resolveSave(): void;
      resolveReplace(): void;
      replaceCalls(): number;
    };
  }
}

const empty = createReviewState({
  sessionId: "delivery-harness",
  source: { fileId: "source", digest: "a".repeat(64), byteLength: 100 },
});
const feedback: ReviewState = {
  ...empty,
  revision: 1,
  items: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      kind: "pageNote",
      pageIndex: 0,
      createdAt: "2026-08-07T12:00:00.000Z",
      updatedAt: "2026-08-07T12:00:00.000Z",
      payload: {
        position: { x: 10, y: 10, width: 20, height: 20 },
        comment: "Review this page",
      },
    },
  ],
};

let releaseSave: (() => void) | undefined;
let releaseReplace: (() => void) | undefined;
let replaceCount = 0;
let setFeedback: (() => void) | undefined;

function Harness() {
  const [state, setState] = useState<ReviewState>(empty);
  setFeedback = () => setState(feedback);
  return (
    <HumanDelivery
      state={state}
      onSave={() => new Promise((resolve) => {
        releaseSave = () => resolve({ path: "/tmp/paper-reviewed.pdf" });
      })}
      onReplaceOriginal={() => new Promise((resolve) => {
        replaceCount += 1;
        releaseReplace = () => resolve({ path: "/tmp/paper.pdf" });
      })}
      onFinish={() => undefined}
      onDiscard={() => undefined}
    />
  );
}

window.deliveryHarness = {
  addFeedback: () => setFeedback?.(),
  resolveSave: () => releaseSave?.(),
  resolveReplace: () => releaseReplace?.(),
  replaceCalls: () => replaceCount,
};

const root = document.querySelector("#root");
if (!root) throw new Error("Delivery harness root is missing");
createRoot(root).render(<Harness />);
