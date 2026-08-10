import { PdfZoomMode } from '@embedpdf/models';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  LinkActionMenuContent,
  compositeFocusIndex,
  horizontalTabFocusIndex,
  placeLinkActionPopover,
  setLinkActionOpenerExpanded,
} from '../src/review/LinkActionPopover.js';
import { PDF_LINK_ACTION_MENU_ID } from '../src/pdf/viewer-interaction-events.js';
import {
  OutlineNavigator,
  findCurrentOutlineItem,
  type OutlineOrderPoint,
} from '../src/review/OutlineNavigator.js';
import {
  chooseWorkspaceModeFocusTarget,
  ReferenceWorkspace,
} from '../src/review/ReferenceWorkspace.js';
import type { PdfOutlineItem } from '../src/pdf/pdf-outline.js';

const target = (identity: string, pageIndex: number) => ({
  documentGeneration: 3,
  pageIndex,
  zoom: { mode: PdfZoomMode.FitPage, params: [] },
  identity,
});

describe('link action chooser', () => {
  it('keeps the default action first and exposes a nonmodal menu contract', () => {
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
    expect(html).toMatch(/Open in References[\s\S]*Open in main/u);
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
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
        outline={{ status: 'loaded-empty', documentGeneration: 3 }}
        onModeChange={() => undefined}
        onReferenceTabActivate={() => undefined}
        onReferenceTabClose={() => undefined}
        onSendToMain={() => undefined}
        onRetryReference={() => undefined}
        onOutlineActivate={() => undefined}
        onDismiss={() => undefined}
        onReferenceViewportHost={() => undefined}
        annotations={<div>Annotation inventory</div>}
      />,
    );

    expect(html).toContain('aria-label="Workspace modes"');
    expect(html.match(/role="tab"/g)).toHaveLength(5);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(2);
    expect(html.match(/tabindex="0"/g)).toHaveLength(2);
    expect(html).toMatch(/id="workspace-mode-references"[^>]*aria-controls="workspace-panel-references"/u);
    expect(html).toMatch(/id="workspace-panel-references"[^>]*aria-labelledby="workspace-mode-references"/u);
    expect(html).toMatch(/id="workspace-panel-outline"[^>]*hidden=""[^>]*inert=""/u);
    expect(html).toMatch(/id="workspace-panel-annotations"[^>]*hidden=""[^>]*inert=""/u);
    expect(html).toContain('aria-label="Open references"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('data-reference-viewport-host');
    expect(html).toContain('aria-label="Close active reference"');
    expect(html).not.toMatch(/role="tab"[^>]*>[^<]*Close/u);
    expect(html).toContain('aria-live="polite"');
  });

  it('keeps empty, loading, and failure reference regions stable and retryable', () => {
    const base = {
      open: true,
      mode: 'references' as const,
      presentation: 'bottom' as const,
      tabs: [],
      activeTabIdentity: null,
      outline: { status: 'loading' as const, documentGeneration: 3 },
      onModeChange: vi.fn(),
      onReferenceTabActivate: vi.fn(),
      onReferenceTabClose: vi.fn(),
      onSendToMain: vi.fn(),
      onRetryReference: vi.fn(),
      onOutlineActivate: vi.fn(),
      onDismiss: vi.fn(),
      onReferenceViewportHost: vi.fn(),
      annotations: <div />,
    };
    const empty = renderToStaticMarkup(<ReferenceWorkspace {...base} />);
    const loading = renderToStaticMarkup(<ReferenceWorkspace
      {...base}
      pendingReference={{ status: 'loading', label: 'Equation (4)', pageContext: 'Page 6' }}
    />);
    const failed = renderToStaticMarkup(<ReferenceWorkspace
      {...base}
      pendingReference={{ status: 'error', label: 'Equation (4)', pageContext: 'Page 6' }}
    />);

    expect(empty).toContain('data-reference-empty');
    expect(empty).toContain('An internal PDF link can open a reference here.');
    expect(empty).toContain('tabindex="-1"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Equation (4)');
    expect(failed).toContain('Reference unavailable.');
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
      />,
    );

    expect(html).toMatch(/<nav[^>]*aria-label="Document outline"/u);
    expect(html).toContain('<ul');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="outline-children-intro"');
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('Setup');
  });

  it('chooses the deepest safely ordered destination and fails closed on unknown ordering', () => {
    const order = new Map<string, OutlineOrderPoint>([
      ['intro-target', { pageIndex: 0, offset: 0 }],
      ['setup-target', { pageIndex: 2, offset: 20 }],
      ['results-target', { pageIndex: 7, offset: 10 }],
    ]);
    expect(findCurrentOutlineItem(items, { pageIndex: 2, offset: 30 }, (item) => (
      item.target ? order.get(item.target.identity) ?? null : null
    ))?.id).toBe('setup');
    expect(findCurrentOutlineItem(items, { pageIndex: 8, offset: 0 }, () => null)).toBeNull();
  });

  it('prefers depth before later document order and then the later equal-depth sibling', () => {
    const tiedItems: readonly PdfOutlineItem[] = [{
      id: 'parent',
      label: 'Parent',
      pageContext: 'Page 4',
      target: target('parent-target', 3),
      children: [{
        id: 'first-child',
        label: 'First child',
        pageContext: 'Page 4',
        target: target('first-child-target', 3),
        children: [],
      }, {
        id: 'later-child',
        label: 'Later child',
        pageContext: 'Page 4',
        target: target('later-child-target', 3),
        children: [],
      }],
    }, {
      id: 'later-root',
      label: 'Later root',
      pageContext: 'Page 4',
      target: target('later-root-target', 3),
      children: [],
    }];
    const current = findCurrentOutlineItem(
      tiedItems,
      { pageIndex: 3, offset: 20 },
      () => ({ pageIndex: 3, offset: 20 }),
    );
    expect(current?.id).toBe('later-child');
  });

  it('distinguishes loading, loaded-empty, and unavailable states', () => {
    const render = (status: 'loading' | 'loaded-empty' | 'unavailable') => renderToStaticMarkup(
      <OutlineNavigator
        discovery={{ status, documentGeneration: 3 }}
        currentItemId={null}
        onActivate={() => undefined}
      />,
    );
    expect(render('loading')).toContain('Outline is loading');
    expect(render('loaded-empty')).toContain('This PDF has no embedded outline.');
    expect(render('unavailable')).toContain('Outline unavailable.');
    expect(render('unavailable')).not.toContain('role="alert"');
  });
});
