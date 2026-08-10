import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { ReferenceResizeHandle } from '../../../apps/web/src/review/ReferenceResizeHandle.js';

const events = { changes: [] as number[], commits: 0 };

(globalThis as typeof globalThis & {
  __referenceResizeHandleEvents: typeof events;
}).__referenceResizeHandleEvents = events;

createRoot(document.querySelector('#root')!).render(createElement(ReferenceResizeHandle, {
  dock: 'bottom',
  controls: 'references',
  value: 384,
  min: 192,
  max: 640,
  onChange: (value: number) => events.changes.push(value),
  onCommit: () => { events.commits += 1; },
}));
