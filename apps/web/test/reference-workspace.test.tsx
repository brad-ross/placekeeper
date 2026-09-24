import { PdfZoomMode } from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { DestinationSnippetFrame } from '../src/review/DestinationSnippet.js';
import {
  LinkActionMenuContent,
  LinkActionPopover,
  linkActionDismissRestoresFocus,
  placeLinkActionPopover,
  setLinkActionOpenerExpanded,
} from '../src/review/LinkActionPopover.js';
import { PDF_LINK_ACTION_MENU_ID } from '../src/pdf/viewer-interaction-events.js';
import { OutlineNavigator } from '../src/review/OutlineNavigator.js';
import { compositeFocusIndex, horizontalTabFocusIndex } from '../src/review/menu-focus.js';
import {
  createOutlineRowCopyLink,
  createPdfTargetCopyLink,
  createSearchResultRowCopyLink,
} from '../src/review/row-link-actions.js';
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
import {
  chooseToolModeFocusTarget,
  OutlineAnnotationsWorkspace,
} from '../src/review/OutlineAnnotationsWorkspace.js';
import type { PdfOutlineItem } from '../src/pdf/pdf-outline.js';
import { RIGHT_WORKSPACE_MODES } from '../src/review/reference-navigation-state.js';
import {
  createOutlineExpansionState,
  setOutlineExpandedItemIds,
  toggleOutlineExpansionState,
} from '../src/review/outline-expansion-state.js';
import { OutlineExpansionToggle } from '../src/review/OutlineExpansionToggle.js';
import { OutlineExpansionProvider } from '../src/review/OutlineExpansionController.js';

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
    expect(linkActionDismissRestoresFocus('copy-success')).toBe(true);
  });

  // Covers AE1 (R3, R4): icon actions keep today's order in one row below the destination snippet.
  it('shows icon actions in the existing order below the destination snippet, then the page', () => {
    const html = renderToStaticMarkup(
      <LinkActionMenuContent
        label="Lemma A.7"
        pageContext="Page 18"
        pageNumeral="18"
        sourceScope="main"
        firstItemRef={() => undefined}
        snippet={<div data-destination-snippet="">snippet</div>}
        copyLink={{
          getLink: () => 'placekeeper:///tmp/Paper.pdf#v=2&page=18&mode=fit-page',
          writeText: async () => undefined,
          ariaLabel: 'Copy link to exact destination on page 18',
          title: 'Copy exact destination link',
        }}
        onChoose={() => undefined}
        onKeyDown={() => undefined}
        onBlur={() => undefined}
      />,
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain(`id="${PDF_LINK_ACTION_MENU_ID}"`);
    expect(html).toMatch(
      /data-destination-snippet[\s\S]*aria-label="Open in References"[\s\S]*aria-label="Open in main document"[\s\S]*aria-label="Copy link to exact destination on page 18"/u,
    );
    // Icon-only actions in one row, the destination page numeral last.
    expect(html).toMatch(
      /class="link-action-popover__actions"[\s\S]*lucide-chevron-right[\s\S]*lucide-link[\s\S]*class="link-action-popover__page" aria-hidden="true">18<\/span>/u,
    );
    expect(html).toContain('copy-link-control__trigger--icon-only');
    expect(html).not.toMatch(/>(Open in References|Open in main document|Copy link)<\/span>/u);
    // Enabled actions keep the shared custom tooltip, not a native title.
    expect(html).not.toContain('title="Open in References"');
    expect(html).not.toContain('title="Open in main document"');
    expect(html).not.toContain('title="Copy exact destination link"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-busy="true"');
    expect(html).toContain('Lemma A.7');
    expect(html).toContain('Page 18');
  });

  it('keeps the snippet out of the menu focus order', () => {
    const html = renderToStaticMarkup(
      <LinkActionMenuContent
        label="Lemma A.7"
        pageContext="Page 18"
        pageNumeral="18"
        sourceScope="main"
        firstItemRef={() => undefined}
        snippet={<DestinationSnippetFrame
          image={{ status: 'loading' }}
          description={null}
          resolving
        />}
        onChoose={() => undefined}
        onKeyDown={() => undefined}
        onBlur={() => undefined}
      />,
    );
    const snippetStart = html.indexOf('data-destination-snippet');
    expect(snippetStart).toBeGreaterThan(-1);
    const snippet = html.slice(snippetStart, html.indexOf('<button'));
    expect(snippetStart).toBeLessThan(html.indexOf('<button'));
    expect(snippet).not.toMatch(/tabindex|role="menuitem"|<input/u);
    expect(snippet).toContain('aria-hidden="true"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
  });

  it('puts Follow in this tab before the right-most main action inside References', () => {
    const html = renderToStaticMarkup(
      <LinkActionMenuContent
        label="Target-to-target detail link"
        pageContext="Page 3"
        pageNumeral="3"
        sourceScope="reference"
        firstItemRef={() => undefined}
        copyLink={{
          getLink: () => 'placekeeper:///tmp/Paper.pdf#v=2&page=3&mode=fit-page',
          writeText: async () => undefined,
          ariaLabel: 'Copy link to exact destination on page 3',
          title: 'Copy exact destination link',
        }}
        onChoose={() => undefined}
        onKeyDown={() => undefined}
        onBlur={() => undefined}
      />,
    );

    expect(html).toMatch(
      /aria-label="Open in References"[\s\S]*aria-label="Follow in this tab"[\s\S]*aria-label="Open in main document"[\s\S]*aria-label="Copy link to exact destination on page 3"/u,
    );
    expect(html).toMatch(/lucide-arrow-right[\s\S]*lucide-square-arrow-out-up-right/u);
    expect(html).not.toContain('title="Follow in this tab"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(4);
  });

  it('keeps main-document links available while References is displaced by authoring', () => {
    const html = renderToStaticMarkup(
      <LinkActionMenuContent
        label="Lemma A.7"
        pageContext="Page 18"
        pageNumeral="18"
        sourceScope="main"
        firstItemRef={() => undefined}
        openInReferencesDisabled
        onChoose={() => undefined}
        onKeyDown={() => undefined}
        onBlur={() => undefined}
      />,
    );

    expect(html).toMatch(/aria-label="Open in References"[^>]*disabled/u);
    expect(html).toMatch(/aria-label="Open in main document"(?![^>]*disabled)/u);
    expect(html).toMatch(/aria-label="Open in References"[^>]*disabled/u);
  });

  it('marks the chosen action busy and the menu non-interactive while its name resolves', () => {
    const html = renderToStaticMarkup(
      <LinkActionMenuContent
        label="Lemma A.7"
        pageContext="Page 18"
        pageNumeral="18"
        sourceScope="main"
        firstItemRef={() => undefined}
        busyChoice="references"
        onChoose={() => undefined}
        onKeyDown={() => undefined}
        onBlur={() => undefined}
      />,
    );

    const tag = (name: string) => html.match(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`, 'u'))?.[0] ?? '';
    expect(html).toMatch(/<div[^>]*role="menu"[^>]*aria-busy="true"/u);
    expect(tag('Open in References')).toContain('aria-busy="true"');
    expect(tag('Open in main document')).not.toContain('aria-busy="true"');
    expect(tag('Open in main document')).toContain('aria-disabled="true"');
    expect(html.match(/aria-busy="true"/g)).toHaveLength(2);
  });

  it('renders no menu without a clicked link request (R5)', () => {
    const html = renderToStaticMarkup(
      <LinkActionPopover request={null} onChoose={() => undefined} onDismiss={() => undefined} />,
    );
    expect(html).toBe('');
  });

  it('wraps menu focus for arrows and supports Home and End', () => {
    expect(compositeFocusIndex(0, 2, 'ArrowDown')).toBe(1);
    expect(compositeFocusIndex(1, 2, 'ArrowDown')).toBe(0);
    expect(compositeFocusIndex(0, 2, 'ArrowUp')).toBe(1);
    expect(compositeFocusIndex(1, 2, 'Home')).toBe(0);
    expect(compositeFocusIndex(0, 2, 'End')).toBe(1);
    expect(compositeFocusIndex(0, 2, 'PageDown')).toBeNull();
    expect(compositeFocusIndex(0, 2, 'ArrowLeft')).toBeNull();
    expect(compositeFocusIndex(2, 3, 'ArrowDown')).toBe(0);
    expect(compositeFocusIndex(0, 3, 'ArrowUp')).toBe(2);
    expect(compositeFocusIndex(0, 3, 'End')).toBe(2);
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

  it('falls back to Search when the selected Outline mode is unavailable', () => {
    const html = renderToStaticMarkup(
      <OutlineExpansionProvider discovery={{ status: 'loaded-empty', documentGeneration: 1 }}>
        <OutlineAnnotationsWorkspace
          open
          mode="outline"
          modes={RIGHT_WORKSPACE_MODES.filter((mode) => mode !== 'outline')}
          presentation="right"
          headerVariant="tools"
          outline={{ status: 'loaded-empty', documentGeneration: 1 }}
          currentOutlineItemId={null}
          annotations={<div>Owned annotation rows</div>}
          search={<div>PDF search</div>}
          onModeChange={() => undefined}
          onOutlineActivate={() => undefined}
          onOutlineReference={() => undefined}
        />
      </OutlineExpansionProvider>,
    );

    expect(html).toContain('id="review-tools-workspace"');
    expect(html).not.toContain('id="workspace-mode-outline"');
    expect(html).not.toContain('id="workspace-panel-outline"');
    expect(html).not.toContain('This PDF has no embedded outline.');
    expect(html.match(/id="workspace-panel-annotations"/g)).toHaveLength(1);
    expect(html.match(/id="workspace-panel-search"/g)).toHaveLength(1);
    expect(html).toMatch(/id="workspace-mode-search"[^>]*aria-selected="true"/u);
    const searchPanel = html.match(/<section[^>]*id="workspace-panel-search"[^>]*>/u)?.[0];
    expect(searchPanel).not.toContain('hidden');
    expect(searchPanel).not.toContain('inert');
    expect(html).toMatch(/id="workspace-panel-annotations"[^>]*aria-labelledby="workspace-mode-annotations"/u);
    expect(html).toMatch(/id="workspace-panel-annotations"[^>]*hidden/u);
    expect(html).toContain('aria-label="Search and annotations"');
    expect(html).toContain('data-workspace-mode-count="2"');
  });

  it('keeps Outline available while discovery is unavailable', () => {
    const html = renderToStaticMarkup(
      <OutlineExpansionProvider discovery={{ status: 'unavailable', documentGeneration: 1 }}>
        <OutlineAnnotationsWorkspace
          open
          mode="outline"
          modes={RIGHT_WORKSPACE_MODES}
          presentation="right"
          headerVariant="tools"
          outline={{ status: 'unavailable', documentGeneration: 1 }}
          currentOutlineItemId={null}
          annotations={<div>Owned annotation rows</div>}
          onModeChange={() => undefined}
          onOutlineActivate={() => undefined}
          onOutlineReference={() => undefined}
        />
      </OutlineExpansionProvider>,
    );

    expect(html).toContain('id="workspace-mode-outline"');
    expect(html).toContain('id="workspace-mode-search"');
    expect(html).toContain('id="workspace-panel-outline"');
    expect(html).toContain('Outline unavailable.');
    expect(html).toContain('aria-label="Outline, search, and annotations"');
    expect(html).toContain('data-workspace-mode-count="3"');
  });

  it('discards disconnected mode focus memory before a panel is restored', () => {
    const disconnected = { isConnected: false } as HTMLElement;
    const connected = { isConnected: true } as HTMLElement;
    const panel = {} as HTMLElement;

    expect(chooseToolModeFocusTarget(disconnected, panel)).toBe(panel);
    expect(chooseToolModeFocusTarget(connected, panel)).toBe(connected);
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
    expect(html).toContain('data-workspace-mode-count="4"');
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
    expect(html).toContain('class="review-workspace__activity-strip review-workspace__activity-strip--compound"');
    expect(html).toContain('aria-label="Outline"');
    expect(html).toContain('aria-label="Outline"');
    expect(html).toContain('aria-label="References"');
    expect(html).not.toContain('title="Show References"');
    expect(html.match(/data-workspace-mode-label/g)).toHaveLength(1);
    expect(html).toContain('data-workspace-mode-label="references"');
    expect(html).toContain('>References</span>');
    expect(html).toContain('review-workspace__mode-segment--compound');
    expect(html).toMatch(
      /review-workspace__mode-segment--compound[\s\S]*data-workspace-mode="references"[\s\S]*<\/div><button[^>]*data-reference-move="bottom"/u,
    );
    const workspaceTablist = html.match(
      /<div class="review-workspace__tabs" role="tablist"[\s\S]*?<\/div>/u,
    )?.[0];
    expect(workspaceTablist).toBeDefined();
    expect(workspaceTablist).not.toContain('data-reference-move');
    expect(html).toContain('data-reference-move="bottom"');
    expect(html).not.toContain('review-workspace__tab-segment--compound');
  });

  it('shows References docking only for the selected mode and a visible placement change', () => {
    const renderWorkspace = (
      mode: 'search' | 'references',
      presentation: 'right' | 'bottom',
      headerVariant: 'tabs' | 'references' = 'tabs',
    ) => renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode={mode}
        presentation={presentation}
        modes={headerVariant === 'references' ? ['references'] : ['search', 'references']}
        headerVariant={headerVariant}
        tabs={[]}
        activeTabIdentity={null}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onMoveReferencesBottom={() => undefined}
        onMoveReferencesRight={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(renderWorkspace('search', 'right')).not.toContain('data-reference-move');
    expect(renderWorkspace('references', 'right')).toContain('data-reference-move="bottom"');
    expect(renderWorkspace('references', 'right')).not.toContain('data-reference-move="right"');
    expect(renderWorkspace('references', 'bottom')).not.toContain('data-reference-move');
    expect(renderWorkspace('references', 'bottom', 'references')).toContain('data-reference-move="right"');
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
    expect(lemmaActive).toContain('aria-label="Open in main document"');
    expect(lemmaActive).not.toContain('title="Open in main document"');
    expect(lemmaActive).toContain('data-workspace-focus-token="reference-send:lemma"');
    expect(lemmaActive).toContain('aria-label="Close active reference"');
    expect(lemmaActive).not.toContain('title="Close active reference"');
    expect(lemmaActive).toContain('data-workspace-focus-token="reference-close:lemma"');
    expect(lemmaActive).toContain('aria-label="Lemma A.7, Page 18"');
    expect(referenceSemanticTabs).toHaveLength(2);
    expect(semanticTabs.every((tab) => !/<button/u.test(tab.slice(1)))).toBe(true);
    expect(lemmaActive).not.toContain('reference-panel__actions');
    expect(lemmaActive.match(/>Lemma A\.7</g)).toHaveLength(1);
    expect(lemmaActive.match(/class="reference-tab-segment__page" aria-hidden="true">18</g))
      .toHaveLength(1);
    expect(referenceSemanticTabs[0]).toContain(
      '<small class="reference-tab-segment__page-placeholder" aria-hidden="true">18</small>',
    );
    expect(referenceSemanticTabs[1]).toContain(
      '<small class="reference-tab-segment__page-label">31</small>',
    );

    expect(proofActive).toMatch(
      /data-reference-tab-segment="proof"[\s\S]*aria-selected="true"[\s\S]*data-workspace-focus-token="reference-send:proof"[\s\S]*data-workspace-focus-token="reference-close:proof"/u,
    );
    expect(proofActive).not.toContain('data-workspace-focus-token="reference-send:lemma"');
    expect(proofActive).not.toContain('data-workspace-focus-token="reference-close:lemma"');
  });

  it('places the icon-only Reference return control in the active tab actions', () => {
    const onReturn = vi.fn();
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="right"
        modes={['references']}
        tabs={[{ identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' }]}
        activeTabIdentity="lemma"
        referenceReturn={{ tabIdentity: 'lemma', available: true, pending: false }}
        onReferenceReturn={onReturn}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).toMatch(
      /data-reference-tab-segment="lemma"[\s\S]*aria-selected="true"[\s\S]*class="reference-panel__return"[\s\S]*data-reference-return="lemma"[\s\S]*lucide-locate-fixed[\s\S]*data-reference-tab-action="send"[\s\S]*data-reference-tab-action="close"/u,
    );
    expect(html.indexOf('data-reference-return="lemma"'))
      .toBeLessThan(html.indexOf('class="reference-panel__viewport"'));
    expect(html).toContain('aria-label="Return to reference"');
    expect(html).not.toContain('title="Return to reference"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('lucide-locate-fixed');
    expect(html).not.toMatch(/>Return to reference</u);
    expect(html).not.toContain('aria-busy="true"');

  });

  it('keeps a pending Reference return mounted, focusable, and busy', () => {
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="bottom"
        modes={['references']}
        tabs={[{ identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' }]}
        activeTabIdentity="lemma"
        referenceReturn={{ tabIdentity: 'lemma', available: true, pending: true }}
        onReferenceReturn={() => undefined}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).toMatch(/data-reference-return="lemma"[^>]*aria-busy="true"[^>]*aria-disabled="true"/u);
    expect(html).not.toMatch(/data-reference-return="lemma"[^>]*\sdisabled(?:=|\s|>)/u);
    expect(html).toContain('aria-label="Return to reference"');
    expect(html).not.toContain('title="Returning to reference"');
    expect(html).not.toMatch(/>Return to reference</u);
  });

  it.each([
    ['origin visible', { tabIdentity: 'lemma', available: false, pending: false }, null],
    ['another tab', { tabIdentity: 'proof', available: true, pending: false }, null],
    ['no active tab', { tabIdentity: 'lemma', available: true, pending: false }, null],
  ] as const)('hides the Reference return control for %s', (_label, referenceReturn, pendingReference) => {
    const activeTabIdentity = _label === 'no active tab' ? null : 'lemma';
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="right"
        modes={['references']}
        tabs={activeTabIdentity === null ? [] : [
          { identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' },
        ]}
        activeTabIdentity={activeTabIdentity}
        referenceReturn={referenceReturn}
        pendingReference={pendingReference}
        onReferenceReturn={() => undefined}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).not.toContain('data-reference-return');
  });

  it.each(['loading', 'error'] as const)('hides the Reference return control while %s', (status) => {
    const html = renderToStaticMarkup(
      <ReferenceWorkspace
        open
        mode="references"
        presentation="right"
        modes={['references']}
        tabs={[{ identity: 'lemma', label: 'Lemma A.7', pageContext: 'Page 18' }]}
        activeTabIdentity="lemma"
        referenceReturn={{ tabIdentity: 'lemma', available: true, pending: false }}
        pendingReference={{ status, label: 'Proof', pageContext: 'Page 31' }}
        onReferenceReturn={() => undefined}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onReferenceViewportHost={() => undefined}
      />,
    );

    expect(html).not.toContain('data-reference-return');
  });

  it('keeps selected-tab geometry stable with disabled actions while pending', () => {
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
    expect(html).toMatch(/data-reference-tab-action="send"[^>]*aria-disabled="true"/);
    expect(html).toMatch(/data-reference-tab-action="close"[^>]*aria-disabled="true"/);
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

    expect(html).toContain('aria-label="Workspace modes"');
    expect(html).toContain('data-workspace-mode-count="1"');
    expect(html).toContain('data-workspace-mode-label="references"');
    expect(html).toContain('review-workspace__activity-strip--title');
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
        target="workspace"
        open
        controls="review-tools-workspace"
        onToggle={() => undefined}
      />,
    );
    const bottomRail = renderToStaticMarkup(
      <WorkspaceEdgeRail
        surface="bottom"
        target="References"
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
    expect(loading).toContain('aria-label="Open references"');
    expect(loading).toContain('aria-disabled="true"');
    expect(loading).toContain('Equation (4)');
    expect(failed).toContain('Reference unavailable.');
    expect(failed).toContain('data-reference-panel-layout="full"');
    expect(failed).toContain('Retry reference');
    expect(failed).not.toContain('role="alert"');
  });

  it('keeps failed Reference viewport geometry measurable for draft passage recovery', () => {
    const html = renderToStaticMarkup(<ReferenceWorkspace
      open
      authoringTakeover
      mode="references"
      presentation="bottom"
      modes={['references']}
      tabs={[{ identity: 'detail', label: 'Target detail', pageContext: 'Page 3' }]}
      activeTabIdentity="detail"
      pendingReference={{ status: 'error', label: 'Primary result', pageContext: 'Page 2' }}
      onModeChange={vi.fn()}
      onReferenceTabActivate={vi.fn()}
      onReferenceTabClose={vi.fn()}
      onSendToMain={vi.fn()}
      onRetryReference={vi.fn()}
      onReferenceViewportHost={vi.fn()}
    />);
    const viewport = html.match(/<div[^>]*class="reference-panel__viewport"[^>]*>/u)?.[0] ?? '';

    expect(viewport).toContain('data-reference-viewport-concealed="true"');
    expect(viewport).toContain('inert=""');
    expect(viewport).not.toContain('hidden=""');
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

  it('builds exact Outline and page-only Search links against the current document', async () => {
    let currentGeneration = 3;
    const writeText = vi.fn(async () => undefined);
    const context = {
      appLinkBase: 'placekeeper:///tmp/Paper.pdf',
      document: { documentGeneration: 3, pageCount: 10 },
      currentDocumentGeneration: () => currentGeneration,
      writeText,
    };
    const exactTarget = {
      documentGeneration: 3,
      pageIndex: 7,
      zoom: { mode: PdfZoomMode.XYZ, params: [12, 34, 1.25] },
      identity: JSON.stringify([3, 7, PdfZoomMode.XYZ, 12, 34, 1.25]),
    };
    const pageTarget = {
      documentGeneration: 3,
      pageIndex: 2,
      zoom: { mode: PdfZoomMode.Unknown, params: [] },
      identity: JSON.stringify([3, 2, PdfZoomMode.Unknown]),
    };
    const exact = createOutlineRowCopyLink({
      id: 'exact', label: 'Results', pageContext: 'Page 8', target: exactTarget, children: [],
    }, context);
    const page = createOutlineRowCopyLink({
      id: 'page', label: 'Methods', pageContext: 'Page 3', target: pageTarget, children: [],
    }, context);
    const search = createSearchResultRowCopyLink({ pageIndex: 5 }, context);
    const clickedTarget = createPdfTargetCopyLink(exactTarget, context);

    expect(exact?.precision).toBe('exact');
    expect(exact?.getLink()).toBe(
      'placekeeper:///tmp/Paper.pdf#v=2&page=8&mode=xyz&params=12,34,1.25',
    );
    expect(page?.precision).toBe('page');
    expect(page?.getLink()).toBe('placekeeper:///tmp/Paper.pdf#v=1&page=3');
    expect(search?.getLink()).toBe('placekeeper:///tmp/Paper.pdf#v=1&page=6');
    expect(clickedTarget?.getLink()).toBe(exact?.getLink());
    expect(createSearchResultRowCopyLink({ pageIndex: 10 }, context)).toBeUndefined();
    expect(createOutlineRowCopyLink({
      id: 'stale',
      label: 'Stale',
      pageContext: 'Page 3',
      target: { ...pageTarget, documentGeneration: 2 },
      children: [],
    }, context)).toBeUndefined();
    expect(createOutlineRowCopyLink({
      id: 'unavailable', label: 'Unavailable', pageContext: null, target: null, children: [],
    }, context)).toBeUndefined();

    await exact?.writeText(exact.getLink());
    expect(writeText).toHaveBeenCalledOnce();
    currentGeneration = 4;
    await expect(page?.writeText(page.getLink())).rejects.toThrow('replaced PDF');
    await expect(clickedTarget?.writeText(clickedTarget.getLink())).rejects.toThrow('replaced PDF');
    expect(writeText).toHaveBeenCalledOnce();
  });

  it('uses nested native lists, separate disclosures, safe destinations, and current location', () => {
    const html = renderToStaticMarkup(
      <OutlineNavigator
        discovery={{ status: 'loaded-tree', documentGeneration: 3, items }}
        currentItemId="setup"
        onActivate={() => undefined}
        onOpenReference={() => undefined}
        expandedItemIds={new Set(['intro'])}
        onExpandedItemIdsChange={() => undefined}
      />,
    );

    expect(html).toMatch(/<nav[^>]*aria-label="Document outline"/u);
    expect(html).toContain('<ul');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="outline-children-intro"');
    expect(html).toContain('class="outline-navigator__children"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('Setup');
  });

  it('renders ordered target actions without manufacturing a link for unavailable groups', () => {
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
        expandedItemIds={new Set(['group', 'intro'])}
        onExpandedItemIdsChange={() => undefined}
        copyLinkForItem={(item) => item.target === null ? undefined : {
          precision: item.id === 'results' ? 'exact' : 'page',
          getLink: () => item.id === 'results'
            ? 'placekeeper:///tmp/Paper.pdf#v=2&page=8&mode=fit-page'
            : `placekeeper:///tmp/Paper.pdf#v=1&page=${item.target!.pageIndex + 1}`,
          writeText: async () => undefined,
        }}
      />,
    );
    const groupingRow = html.slice(html.indexOf('data-outline-item="group"'), html.indexOf('data-outline-item="intro"'));
    const introductionRow = html.slice(html.indexOf('data-outline-item="intro"'), html.indexOf('data-outline-item="setup"'));
    const resultsRow = html.slice(html.indexOf('data-outline-item="results"'));

    expect(groupingRow).toContain('outline-navigator__disclosure');
    expect(groupingRow).toContain('outline-navigator__destination');
    expect(groupingRow).not.toContain('row-action-group');
    expect(introductionRow).toMatch(
      /class="outline-navigator__destination"[\s\S]*?<\/button><div class="row-action-group"/u,
    );
    expect(introductionRow).toContain('aria-label="Open Introduction, Page 1 in References"');
    expect(introductionRow).toContain('aria-label="Copy page link for Introduction, Page 1"');
    expect(introductionRow).toContain('aria-label="Open Introduction, Page 1 in References"');
    expect(introductionRow).toContain('lucide-panels-top-left');
    expect(resultsRow).toContain('aria-current="location"');
    expect(resultsRow).toContain('data-current="true"');
    expect(resultsRow).toContain('aria-label="Copy exact destination link for Results, Page 8"');
    expect(resultsRow).toContain('lucide-link');
    expect(resultsRow).toContain('aria-label="Secondary actions for Results, Page 8"');
    expect(resultsRow).toContain('aria-haspopup="menu"');
    expect(resultsRow).toContain('aria-expanded="false"');
    expect(resultsRow).toMatch(/aria-controls="row-actions-menu-[^"]+"/u);
    expect(resultsRow).toContain(
      '<span class="outline-navigator__summary"><span class="outline-navigator__title">Results</span><small class="outline-navigator__page" aria-hidden="true">8</small></span>',
    );
    expect(resultsRow).not.toContain('outline-navigator__separator');
    expect(resultsRow).not.toContain('>Page 8</small>');
    expect(html.match(/data-row-action="open-reference"/g)).toHaveLength(3);
  });

  it('distinguishes loading, loaded-empty, and unavailable states', () => {
    const render = (status: 'loading' | 'loaded-empty' | 'unavailable') => renderToStaticMarkup(
      <OutlineNavigator
        discovery={{ status, documentGeneration: 3 }}
        currentItemId={null}
        onActivate={() => undefined}
        onOpenReference={() => undefined}
        expandedItemIds={new Set()}
        onExpandedItemIdsChange={() => undefined}
      />,
    );
    expect(render('loading')).toContain('Outline is loading');
    expect(render('loaded-empty')).toContain('This PDF has no embedded outline.');
    expect(render('unavailable')).toContain('Outline unavailable.');
    expect(render('unavailable')).not.toContain('role="alert"');
  });
});

describe('outline expansion toggle', () => {
  it('restores the exact expansion set captured before a bulk collapse', () => {
    const initial = createOutlineExpansionState(new Set(['intro', 'results']));
    const collapsed = toggleOutlineExpansionState(initial);

    expect([...collapsed.expandedItemIds]).toEqual([]);
    expect([...collapsed.restoreItemIds!]).toEqual(['intro', 'results']);

    const restored = toggleOutlineExpansionState(collapsed);
    expect([...restored.expandedItemIds]).toEqual(['intro', 'results']);
    expect(restored.restoreItemIds).toBeNull();
  });

  it('does not enter restore mode when every branch is already collapsed manually', () => {
    const initial = createOutlineExpansionState(new Set());
    expect(toggleOutlineExpansionState(initial)).toBe(initial);
  });

  it('keeps the captured restore set while individual branches are used', () => {
    const collapsed = toggleOutlineExpansionState(
      createOutlineExpansionState(new Set(['intro', 'results'])),
    );
    const manuallyExpanded = setOutlineExpandedItemIds(collapsed, new Set(['methods']));

    expect([...manuallyExpanded.expandedItemIds]).toEqual(['methods']);
    expect([...manuallyExpanded.restoreItemIds!]).toEqual(['intro', 'results']);
    expect([
      ...toggleOutlineExpansionState(manuallyExpanded).expandedItemIds,
    ]).toEqual(['intro', 'results']);
  });

  it('flips inward collapse carets outward while restore is pending', () => {
    const collapse = renderToStaticMarkup(
      <OutlineExpansionToggle restorePending={false} disabled={false} onToggle={() => undefined} />,
    );
    const restore = renderToStaticMarkup(
      <OutlineExpansionToggle restorePending disabled={false} onToggle={() => undefined} />,
    );

    expect(collapse).toContain('aria-label="Collapse all outline entries"');
    expect(collapse).toContain('lucide-fold-vertical');
    expect(restore).toContain('aria-label="Restore previous outline expansion"');
    expect(restore).toContain('lucide-unfold-vertical');
  });
});
