import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ReviewShell } from '../src/app/ReviewShell.js';
import { createReviewState } from '../../../packages/core/src/review-model.js';

const state = createReviewState({
  sessionId: 'layout-test',
  source: { fileId: 'file', digest: 'a'.repeat(64), byteLength: 10 },
});

describe('review shell layout and accessibility contract', () => {
  it('exposes keyboard-equivalent controls, live status, and state-preserving drawer semantics', () => {
    const html = renderToStaticMarkup(
      <ReviewShell
        state={state}
        proofreadActive
        currentTool="highlight"
        listOpen
        onProofreadActiveChange={() => undefined}
        onToolChange={() => undefined}
        onCommand={async () => state}
      >
        <div>Document canvas</div>
      </ReviewShell>,
    );

    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-keyshortcuts="Alt+Shift+H"');
    expect(html).toContain('aria-label="Review annotations"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('data-breakpoint="1024"');
    expect(html).toContain('data-list-open="true"');
    expect(html).toContain('Highlight');
  });
});
