import { createRoot } from 'react-dom/client';
import { useState } from 'react';

import { ReviewShell } from '../../../apps/web/src/app/ReviewShell.js';
import { projectReviewItems } from '../../../apps/web/src/review/annotation-projection.js';
import type { CaretAnchor, SelectionAnchor } from '../../../apps/web/src/pdf/selection-anchor.js';
import { createReviewState, type ReviewCommand, type ReviewState } from '../../../packages/core/src/review-model.js';
import { reduceReview } from '../../../packages/core/src/review-reducer.js';

const root = document.querySelector('#root');
if (!root) throw new Error('Review harness root is missing');

const selection: SelectionAnchor = {
  pageIndex: 0,
  quote: 'unique equilibrium',
  prefix: 'the ',
  suffix: ' exists',
  rect: { x: 72, y: 92, width: 120, height: 14 },
  segmentRects: [{ x: 72, y: 92, width: 120, height: 14 }],
  reliable: true,
};
const caret: CaretAnchor = {
  pageIndex: 0,
  position: { x: 192, y: 92, width: 2, height: 14 },
  leftContext: 'the unique equilibrium',
  rightContext: ' exists',
  reliable: true,
};

function Harness() {
  const [state, setState] = useState(() => createReviewState({
    sessionId: 'acceptance',
    source: { fileId: 'source', digest: 'a'.repeat(64), byteLength: 100 },
  }));
  const [anchorKind, setAnchorKind] = useState<'selection' | 'caret' | 'none'>('selection');
  const [navigated, setNavigated] = useState('none');
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [keyboardPageNoteActive, setKeyboardPageNoteActive] = useState(false);
  const [placedPageNote, setPlacedPageNote] = useState<{ token: number; pageIndex: number; position: { x: number; y: number; width: number; height: number }; nearbyText: string } | null>(null);

  const accept = async (command: ReviewCommand): Promise<ReviewState> => {
    await Promise.resolve();
    const next = reduceReview(state, command);
    setState(next);
    return next;
  };

  return (
    <ReviewShell
      state={state}
      selectionUpdate={anchorKind === 'selection'
        ? { kind: 'reliable', generation: 0, anchor: selection }
        : { kind: 'cleared', generation: 0 }}
      caretAnchor={anchorKind === 'caret' ? caret : null}
      selectionPlacement={anchorKind === 'selection' ? { left: 240, top: 120, suggestTop: false } : null}
      caretPlacement={anchorKind === 'caret' ? { left: 240, top: 120, suggestTop: true } : null}
      pageMenu={pageMenuOpen ? {
        invocationId: 'harness-menu',
        placement: { left: 300, top: 220 },
        pageIndex: 0,
        position: { x: 300, y: 220, width: 18, height: 18 },
        nearbyText: 'nearby paragraph',
      } : null}
      placedPageNote={placedPageNote}
      keyboardPageNoteActive={keyboardPageNoteActive}
      onRequestKeyboardPageNote={() => setKeyboardPageNoteActive(true)}
      onCancelKeyboardPageNote={() => setKeyboardPageNoteActive(false)}
      onPageMenuDismiss={() => setPageMenuOpen(false)}
      onPageMenuConsumed={() => setPageMenuOpen(false)}
      onPlacedPageNoteConsumed={() => setPlacedPageNote(null)}
      onCommand={accept}
      onNavigate={(item) => setNavigated(item.id)}
    >
      <div>
        <button type="button" onClick={() => setAnchorKind('selection')}>Use selection</button>
        <button type="button" onClick={() => setAnchorKind('caret')}>Use caret</button>
        <button type="button" onClick={() => setAnchorKind('none')}>Clear anchors</button>
        <button type="button" onClick={() => setPageMenuOpen(true)}>Open page actions</button>
        {keyboardPageNoteActive ? (
          <button type="button" onClick={() => {
            setKeyboardPageNoteActive(false);
            setPlacedPageNote({
              token: Date.now(),
              pageIndex: 0,
              position: { x: 300, y: 220, width: 18, height: 18 },
              nearbyText: 'nearby paragraph',
            });
          }}>Place Page Note</button>
        ) : null}
        <div role="application" aria-label="PDF review canvas" tabIndex={0}>PDF page</div>
        <label>
          Native input
          <input aria-label="Native input" defaultValue="native input" />
        </label>
        <label>
          Native textarea
          <textarea aria-label="Native textarea" defaultValue="native textarea" />
        </label>
        <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Contenteditable editor">
          contenteditable text
        </div>
        <div data-review-editor>
          <div contentEditable suppressContentEditableWarning role="textbox" aria-label="Review editor">
            review editor text
          </div>
        </div>
        <div aria-label="Owned annotation overlays" data-owned-annotation-layer>
          {projectReviewItems(state.items).map((annotation) => (
            <span key={annotation.id} data-owned-mark={annotation.kind}>{annotation.contents}</span>
          ))}
        </div>
        <output data-revision={state.revision} data-kinds={state.items.map(({ kind }) => kind).join(',')} data-navigated={navigated}>
          Revision {state.revision}
        </output>
      </div>
    </ReviewShell>
  );
}

createRoot(root).render(<Harness />);
