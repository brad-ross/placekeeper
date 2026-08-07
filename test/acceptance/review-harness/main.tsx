import { createRoot } from 'react-dom/client';
import { useState } from 'react';

import { ReviewShell } from '../../../apps/web/src/app/ReviewShell.js';
import { projectReviewItems } from '../../../apps/web/src/review/annotation-projection.js';
import type { CaretAnchor, SelectionAnchor } from '../../../apps/web/src/pdf/selection-anchor.js';
import { createReviewState, type ReviewCommand, type ReviewItemKind, type ReviewState } from '../../../packages/core/src/review-model.js';
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
  const [proofread, setProofread] = useState(false);
  const [tool, setTool] = useState<ReviewItemKind>('replace');
  const [anchorKind, setAnchorKind] = useState<'selection' | 'caret'>('selection');
  const [navigated, setNavigated] = useState('none');

  const accept = async (command: ReviewCommand): Promise<ReviewState> => {
    await Promise.resolve();
    const next = reduceReview(state, command);
    setState(next);
    return next;
  };

  return (
    <ReviewShell
      state={state}
      proofreadActive={proofread}
      currentTool={tool}
      selectionAnchor={anchorKind === 'selection' ? selection : null}
      caretAnchor={anchorKind === 'caret' ? caret : null}
      pageNoteAnchor={{ pageIndex: 0, position: { x: 300, y: 220, width: 18, height: 18 }, nearbyText: 'nearby paragraph' }}
      onProofreadActiveChange={setProofread}
      onToolChange={setTool}
      onCommand={accept}
      onNavigate={(item) => setNavigated(item.id)}
    >
      <div>
        <button type="button" onClick={() => setAnchorKind('selection')}>Use selection</button>
        <button type="button" onClick={() => setAnchorKind('caret')}>Use caret</button>
        <div role="application" aria-label="PDF review canvas" tabIndex={0}>PDF page</div>
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
