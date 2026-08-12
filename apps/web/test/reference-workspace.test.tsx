import { PdfZoomMode } from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  LinkActionMenuContent,
  compositeFocusIndex,
  horizontalTabFocusIndex,
  linkActionDismissRestoresFocus,
  placeLinkActionPopover,
  setLinkActionOpenerExpanded,
} from '../src/review/LinkActionPopover.js';
import { PDF_LINK_ACTION_MENU_ID } from '../src/pdf/viewer-interaction-events.js';
import { OutlineNavigator } from '../src/review/OutlineNavigator.js';
import {
  chooseWorkspaceModeFocusTarget,
  referenceTabFocusIndex,
  ReferenceWorkspace,
  WORKSPACE_MODES,
} from '../src/review/ReferenceWorkspace.js';
import {
  ReferenceResizeHandle,
  referenceResizeKeyValue,
  referenceResizePointerValue,
} from '../src/review/ReferenceResizeHandle.js';
import { WorkspaceEdgeRail } from '../src/review/WorkspaceEdgeRail.js';
import { OutlineAnnotationsWorkspace } from '../src/review/OutlineAnnotationsWorkspace.js';
import type { PdfOutlineItem } from '../src/pdf/pdf-outline.js';

const target = (identity: string, pageIndex: number) => ({
  documentGeneration: 3,
  pageIndex,
  zoom: { mode: PdfZoomMode.FitPage, params: [] },
  identity,
});

describe('link action chooser', () => {
  it('lets Tab keep native focus movement while cancellation returns to the source', () => {
    expect(linkActionDismissRestoresFocus('tab')).toBe(false);
    expect(linkActionDismissRestoresFocus('escape')).toBe(true);
    expect(linkActionDismissRestoresFocus('outside')).toBe(true);
    expect(linkActionDismissRestoresFocus('anchor-invalidated')).toBe(true);
  });

  it('keeps the default action first in a compact icon-only nonmodal menu', () => {
    const html = renderToStaticMarkup(
      <LinkActionMenuContent
        label="Lemma A.7"
        pageContext="Page 18"
        firstItemRef={() => undefined}
        secondItemRef={() => undefined}
        onChoose={() => undefined}
        onKeyDown={() => undefined}
      />,
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain(`id="${PDF_LINK_ACTION_MENU_ID}"`);
    expect(html).toMatch(/aria-label="Open in References"[\s\S]*aria-label="Open in main"/u);
    expect(html).toMatch(/title="Open in References"[\s\S]*title="Open in main"/u);
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).not.toContain('<small>');
    expect(html).not.toContain('<span>Open in');
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('Lemma A.7');
    expect(html).toContain('Page 18');
  });

  it('wraps menu focus for arrows and supports Home and End', () => {
    expect(compositeFocusIndex(0, 2, 'ArrowDown')).toBe(1);
    expect(compositeFocusIndex(1, 2, 'ArrowDown')).toBe(0);
    expect(compositeFocusIndex(0, 2, 'ArrowUp')).toBe(1);
    expect(compositeFocusIndex(1, 2, 'Home')).toBe(0);
    expect(compositeFocusIndex(0, 2, 'End')).toBe(1);
    expect(compositeFocusIndex(0, 2, 'PageDown')).toBeNull();
    expect(compositeFocusIndex(0, 2, 'ArrowLeft')).toBeNull();
  });

  it('keeps horizontal tab navigation to Left, Right, Home, and End', () => {
    expect(horizontalTabFocusIndex(0, 3, 'ArrowRight')).toBe(1);
    expect(horizontalTabFocusIndex(0, 3, 'ArrowLeft')).toBe(2);
    expect(horizontalTabFocusIndex(2, 3, 'Home')).toBe(0);
    expect(horizontalTabFocusIndex(0, 3, 'End')).toBe(2);
    expect(horizontalTabFocusIndex(1, 3, 'ArrowUp')).toBeNull();
    expect(horizontalTabFocusIndex(1, 3, 'ArrowDown')).toBeNull();
  });

  it('sets and restores only the transient opener expanded state', () => {
    const setAttribute = vi.fn();
    const opener = { setAttribute } as unknown as HTMLButtonElement;
    setLinkActionOpenerExpanded(opener, true);
    setLinkActionOpenerExpanded(opener, false);
    expect(setAttribute.mock.calls).toEqual([
      ['aria-expanded', 'true'],
      ['aria-expanded', 'false'],
    ]);
  });

  it('flips above and clamps both axes inside the visible app viewport', () => {
    expect(placeLinkActionPopover({
      anchor: { left: 760, top: 550, right: 780, bottom: 570, width: 20, height: 20 },
      menu: { width: 260, height: 112 },
      viewport: { left: 0, top: 0, right: 800, bottom: 600 },
      gap: 8,
      margin: 12,
    })).toEqual({ left: 528, top: 430, placement: 'above' });
  });
});

describe('shared reference workspace', () => {
  it('keeps Search between Outline and Annotations with References right-most', () => {
    expect(WORKSPACE_MODES).toEqual(['outline', 'search', 'annotations', 'references']);
  });

  it('keeps Outline and Annotations under one tools-surface owner', () => {
    const html = renderToStaticMarkup(
      <OutlineAnnotationsWorkspace
        open
        mode="outline"
        presentation="right"
        headerVariant="tools"
        outline={{ status: 'loaded-empty', documentGeneration: 1 }}
        currentOutlineItemId={null}
        annotations={<div>Owned annotation rows</div>}
        onModeChange={() => undefined}
        onOutlineActivate={() => undefined}
        onOutlineReference={() => undefined}
      />,
    );

    expect(html).toContain('id="review-tools-workspace"');
    expect(html.match(/id="workspace-panel-outline"/g)).toHaveLength(1);
    expect(html.match(/id="workspace-panel-annotations"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Outline, search, and annotations"');
    expect(html.match(/id="workspace-panel-search"/g)).toHaveLength(1);
  });
  it('prioritizes a newly available retry control over remembered loading-panel focus', () => {
    const remembered = { isConnected: true } as HTMLElement;
    const retry = {} as HTMLElement;
    expect(chooseWorkspaceModeFocusTarget({
      mode: 'references',
      pendingStatus: 'error',
      remembered,
      panel: remembered,
      retry,
      activeReference: null,
      emptyReference: null,
    })).toBe(retry);
  });

  it('focuses the current empty References state instead of stale connected panel memory', () => {
    const remembered = { isConnected: true } as HTMLElement;
    const emptyReference = {} as HTMLElement;
    expect(chooseWorkspaceModeFocusTarget({
      mode: 'references',
      pendingStatus: null,
      remembered,
      panel: remembered,
      retry: null,
      activeReference: null,
      emptyReference,
    })).toBe(emptyReference);
  });

  it('renders one selected outer mode, hidden inert siblings, and manual reference tabs', () => {
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="right"
        tabs={[
          { identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' },
          { identity: 'proof', label: 'Proof', pageContext: 'Page 31' },
        ]}
        activeTabIdentity="lemma"
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onMoveReferencesBottom={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Workspace modes"');
    expect(html).not.toContain('aria-label="Close workspace"');
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(2);
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
    expect(html).toMatch(/id="workspace-mode-references"[^>]*aria-controls="workspace-panel-references"/u);
    expect(html).toMatch(/id="workspace-panel-references"[^>]*aria-labelledby="workspace-mode-references"/u);
    expect(html).not.toContain('id="workspace-panel-outline"');
    expect(html).not.toContain('id="workspace-panel-annotations"');
    expect(html).toContain('aria-label="Open references"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('data-reference-tabs-orientation="horizontal"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('data-reference-viewport-host');
    expect(html).toContain('aria-label="Close active reference"');
    expect(html).not.toMatch(/role="tab"[^>]*>[^<]*Close/u);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('review-workspace__tab-segment--compound');
    expect(html).toContain('class="review-workspace__tab-label" aria-hidden="true">References</span>');
    expect(html).toMatch(/data-workspace-tab-segment="references"[^>]*data-workspace-tab-selected="true"[\s\S]*data-reference-move="bottom"/u);
  });

  it('keeps active reference actions beside, rather than inside, the selected semantic tab', () => {
    const renderReferences = (activeTabIdentity: string) => renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="right"
        modes={['references']}
        tabs={[
          { identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' },
          { identity: 'proof', label: 'Proof', pageContext: 'Page 31' },
        ]}
        activeTabIdentity={activeTabIdentity}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    const lemmaActive = renderReferences('lemma');
    const proofActive = renderReferences('proof');
    const semanticTabs = lemmaActive.match(/<button[^>]*role="tab"[\s\S]*?<\/button>/gu) ?? [];
    const referenceSemanticTabs = semanticTabs.filter((tab) => tab.includes('data-reference-tab='));

    expect(lemmaActive.match(/data-reference-tab-segment=/g)).toHaveLength(2);
    expect(lemmaActive.match(/data-reference-tab[^>]*aria-selected="true"/g)).toHaveLength(1);
    expect(lemmaActive.match(/data-reference-tab-action=/g)).toHaveLength(2);
    expect(lemmaActive).toMatch(
      /data-reference-tab-segment="lemma"[\s\S]*role="tab"[\s\S]*aria-selected="true"[\s\S]*data-reference-tab-action="send"[\s\S]*data-reference-tab-action="close"/u,
    );
    expect(lemmaActive).toContain('aria-label="Send to main"');
    expect(lemmaActive).toContain('title="Send to main"');
    expect(lemmaActive).toContain('data-workspace-focus-token="reference-send:lemma"');
    expect(lemmaActive).toContain('aria-label="Close active reference"');
    expect(lemmaActive).toContain('title="Close active reference"');
    expect(lemmaActive).toContain('data-workspace-focus-token="reference-close:lemma"');
    expect(lemmaActive).toContain('aria-label="Lemma A.7, Page 18"');
    expect(referenceSemanticTabs).toHaveLength(2);
    expect(semanticTabs.every((tab) => !/<button/u.test(tab.slice(1)))).toBe(true);
    expect(lemmaActive).not.toContain('reference-panel__actions');
    expect(lemmaActive.match(/>Lemma A\.7</g)).toHaveLength(1);
    expect(lemmaActive.match(/>Page 18</g)).toHaveLength(1);

    expect(proofActive).toMatch(
      /data-reference-tab-segment="proof"[\s\S]*aria-selected="true"[\s\S]*data-workspace-focus-token="reference-send:proof"[\s\S]*data-workspace-focus-token="reference-close:proof"/u,
    );
    expect(proofActive).not.toContain('data-workspace-focus-token="reference-send:lemma"');
    expect(proofActive).not.toContain('data-workspace-focus-token="reference-close:lemma"');
  });

  it('does not expose selected-tab actions while a reference is pending', () => {
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="right"
        modes={['references']}
        tabs={[{ identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' }]}
        activeTabIdentity="lemma"
        pendingReference={{ status: 'loading', label: 'Proof', pageContext: 'Page 31' }}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Opening reference…');
    expect(html).not.toContain('data-reference-tab-action');
  });

  it('stacks reference tabs vertically beside the PDF only in the independent bottom tray', () => {
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="bottom"
        modes={['references']}
        headerVariant="references"
        tabs={[
          { identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' },
          { identity: 'proof', label: 'Proof', pageContext: 'Page 31' },
        ]}
        activeTabIdentity="lemma"
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onMoveReferencesRight={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).not.toContain('aria-label="Workspace modes"');
    expect(html).toContain('aria-label="Open references"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('data-reference-tabs-orientation="vertical"');
    expect(html).toContain('data-reference-panel-layout="split"');
    expect(html).toContain('data-reference-move="right"');
  });

  it('uses the arrow axis that matches the rendered reference-tab orientation', () => {
    expect(referenceTabFocusIndex(0, 3, 'ArrowDown', 'vertical')).toBe(1);
    expect(referenceTabFocusIndex(0, 3, 'ArrowUp', 'vertical')).toBe(2);
    expect(referenceTabFocusIndex(0, 3, 'ArrowRight', 'vertical')).toBeNull();
    expect(referenceTabFocusIndex(0, 3, 'ArrowRight', 'horizontal')).toBe(1);
    expect(referenceTabFocusIndex(0, 3, 'ArrowDown', 'horizontal')).toBeNull();
  });

  it('exposes surface-specific rails and an accessible reference splitter', () => {
    const rightRail = renderToStaticMarkup(
      <WorkspaceEdgeRail
        surface="right"
        open
        controls="review-tools-workspace"
        onToggle={() => undefined}
      />,
    );
    const bottomRail = renderToStaticMarkup(
      <WorkspaceEdgeRail
        surface="bottom"
        open={false}
        controls="review-workspace"
        onToggle={() => undefined}
      />,
    );
    const splitter = renderToStaticMarkup(
      <ReferenceResizeHandle
        dock="bottom"
        controls="workspace-panel-references"
        value={384}
        min={192}
        max={640}
        onChange={() => undefined}
      />,
    );

    expect(rightRail).toContain('data-workspace-edge-rail="right"');
    expect(rightRail).toContain('aria-expanded="true"');
    expect(rightRail).toContain('aria-controls="review-tools-workspace"');
    expect(bottomRail).toContain('data-workspace-edge-rail="bottom"');
    expect(bottomRail).toContain('aria-expanded="false"');
    expect(splitter).toContain('role="separator"');
    expect(splitter).toContain('aria-orientation="horizontal"');
    expect(splitter).toContain('aria-valuemin="192"');
    expect(splitter).toContain('aria-valuemax="640"');
    expect(splitter).toContain('aria-valuenow="384"');
    expect(splitter).toContain('aria-controls="workspace-panel-references"');
  });

  it('adjusts each splitter axis by one rem and honors its exact limits', () => {
    expect(referenceResizeKeyValue({
      dock: 'right', key: 'ArrowLeft', value: 384, min: 288, max: 640,
    })).toBe(400);
    expect(referenceResizeKeyValue({
      dock: 'right', key: 'ArrowRight', value: 384, min: 288, max: 640,
    })).toBe(368);
    expect(referenceResizeKeyValue({
      dock: 'bottom', key: 'ArrowUp', value: 384, min: 192, max: 640,
    })).toBe(400);
    expect(referenceResizeKeyValue({
      dock: 'bottom', key: 'ArrowDown', value: 384, min: 192, max: 640,
    })).toBe(368);
    expect(referenceResizeKeyValue({
      dock: 'bottom', key: 'Home', value: 384, min: 192, max: 640,
    })).toBe(192);
    expect(referenceResizeKeyValue({
      dock: 'bottom', key: 'End', value: 384, min: 192, max: 640,
    })).toBe(640);
    expect(referenceResizeKeyValue({
      dock: 'bottom', key: 'ArrowLeft', value: 384, min: 192, max: 640,
    })).toBeNull();
  });

  it('translates captured pointer movement into clamped dock size', () => {
    expect(referenceResizePointerValue({
      dock: 'right', startCoordinate: 1000, currentCoordinate: 920,
      startValue: 384, min: 288, max: 640,
    })).toBe(464);
    expect(referenceResizePointerValue({
      dock: 'bottom', startCoordinate: 700, currentCoordinate: 520,
      startValue: 384, min: 192, max: 500,
    })).toBe(500);
  });

  it('keeps empty, loading, and failure reference regions stable and retryable', () => {
    const base = {
      open: true,
      mode: 'references' as const,
      presentation: 'bottom' as const,
      tabs: [],
      activeTabIdentity: null,
      onModeChange: vi.fn(),
      onReferenceTabActivate: vi.fn(),
      onReferenceTabClose: vi.fn(),
      onSendToMain: vi.fn(),
      onRetryReference: vi.fn(),
      onReferenceViewportHost: vi.fn(),
    };
    const empty = renderToStaticMarkup(<ReferenceWorkspace {...base} />);
    const loading = renderToStaticMarkup(<ReferenceWorkspace
      {...base}
      headerVariant="references"
      pendingReference={{ status: 'loading', label: 'Equation (4)', pageContext: 'Page 6' }}
    />);
    const failed = renderToStaticMarkup(<ReferenceWorkspace
      {...base}
      pendingReference={{ status: 'error', label: 'Equation (4)', pageContext: 'Page 6' }}
    />);

    expect(empty).toContain('data-reference-empty');
    expect(empty).toContain('data-reference-panel-layout="full"');
    expect(empty).toContain('An internal PDF link can open a reference here.');
    expect(empty).toContain('tabindex="-1"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('data-reference-panel-layout="split"');
    expect(loading).not.toContain('aria-label="Open references"');
    expect(loading).toContain('Equation (4)');
    expect(failed).toContain('Reference unavailable.');
    expect(failed).toContain('data-reference-panel-layout="full"');
    expect(failed).toContain('Retry reference');
    expect(failed).not.toContain('role="alert"');
  });
});

describe('outline navigator', () => {
  const items: readonly PdfOutlineItem[] = [{
    id: 'intro',
    label: 'Introduction',
    pageContext: 'Page 1',
    target: target('intro-target', 0),
    children: [{
      id: 'setup',
      label: 'Setup',
      pageContext: 'Page 3',
      target: target('setup-target', 2),
      children: [],
    }],
  }, {
    id: 'results',
    label: 'Results',
    pageContext: 'Page 8',
    target: target('results-target', 7),
    children: [],
  }];

  it('uses nested native lists, separate disclosures, safe destinations, and current location', () => {
    const html = renderToStaticMarkup(
      <OutlineNavigator
        discovery={{ status: 'loaded-tree', documentGeneration: 3, items }}
        currentItemId="setup"
        onActivate={() => undefined}
        onOpenReference={() => undefined}
      />,
    );

    expect(html).toMatch(/<nav[^>]*aria-label="Document outline"/u);
    expect(html).toContain('<ul');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="outline-children-intro"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('Setup');
  });

  it('renders target-only References actions as sibling controls with the shared icon', () => {
    const groupingItem: PdfOutlineItem = {
      id: 'group',
      label: 'Appendices',
      pageContext: null,
      target: null,
      children: [items[0]!],
    };
    const html = renderToStaticMarkup(
      <OutlineNavigator
        discovery={{
          status: 'loaded-tree',
          documentGeneration: 3,
          items: [groupingItem, items[1]!],
        }}
        currentItemId="results"
        onActivate={() => undefined}
        onOpenReference={() => undefined}
      />,
    );
    const rows = html.match(/<div class="outline-navigator__row">[\s\S]*?<\/div>/gu) ?? [];
    const groupingRow = rows.find((row) => row.includes('Appendices')) ?? '';
    const introductionRow = rows.find((row) => row.includes('Introduction')) ?? '';
    const resultsRow = rows.find((row) => row.includes('Results')) ?? '';

    expect(groupingRow).toContain('outline-navigator__disclosure');
    expect(groupingRow).toContain('outline-navigator__destination');
    expect(groupingRow).not.toContain('outline-navigator__reference');
    expect(introductionRow).toMatch(
      /class="outline-navigator__destination"[\s\S]*?<\/button><button[^>]*class="outline-navigator__reference"/u,
    );
    expect(introductionRow).toContain('aria-label="Open Introduction, Page 1 in References"');
    expect(introductionRow).toContain('title="Open in References"');
    expect(introductionRow).toContain('lucide-panels-top-left');
    expect(resultsRow).toContain('aria-current="location"');
    expect(html.match(/class="outline-navigator__reference"/g)).toHaveLength(3);
  });

  it('distinguishes loading, loaded-empty, and unavailable states', () => {
    const render = (status: 'loading' | 'loaded-empty' | 'unavailable') => renderToStaticMarkup(
      <OutlineNavigator
        discovery={{ status, documentGeneration: 3 }}
        currentItemId={null}
        onActivate={() => undefined}
        onOpenReference={() => undefined}
      />,
    );
    expect(render('loading')).toContain('Outline is loading');
    expect(render('loaded-empty')).toContain('This PDF has no embedded outline.');
    expect(render('unavailable')).toContain('Outline unavailable.');
    expect(render('unavailable')).not.toContain('role="alert"');
  });
});
