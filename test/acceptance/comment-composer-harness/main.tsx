import { createRoot } from 'react-dom/client';

import { CommentComposer } from '../../../apps/web/src/review/CommentComposer.js';

const root = document.querySelector<HTMLElement>('#root');
if (root === null) throw new Error('Comment composer harness root is unavailable.');

let saveCalls = 0;
createRoot(root).render(
  <CommentComposer
    title="Edit Page Note"
    initialValue="Durably saved terminal text"
    optional
    saveLabel="Apply"
    terminalPending
    terminalPendingMessage="Saved. Waiting for the latest review state; retrying automatically."
    onSave={() => {
      saveCalls += 1;
      root.dataset.saveCalls = String(saveCalls);
    }}
    onDismiss={() => undefined}
  />,
);
