import { describe, expect, it } from 'vitest';

import {
  addDelete,
  addHighlight,
  addInsert,
  addPageNote,
  addReplace,
  editAnnotation,
  removeAnnotation,
  type DocumentCommandFactory,
} from '../src/document-commands.js';
import {
  anchorEvidenceFromAnnotation,
  canonicalizeAnnotation,
  createDocumentState,
  normalizeDocumentSelectionAnchor,
  startDocumentGeneration,
  type PendingDocumentDraftV1,
  type DocumentCommand,
  type DocumentState,
} from '../src/document-model.js';
import {
  InvalidDocumentCommandError,
  MAX_DOCUMENT_SELECTION_SEGMENTS,
  reduceDocument,
} from '../src/document-reducer.js';
import {
  PORTABLE_ANNOTATION_MAX_BYTES,
  serializePortableAnnotationGroup,
} from '../src/portable-annotation.js';

const source = { fileId: 'source-file', digest: 'a'.repeat(64), byteLength: 10 };
const selection = {
  pageIndex: 0,
  quote: 'unique equilibrium',
  prefix: 'the ',
  suffix: ' exists',
  rect: { x: 72, y: 92, width: 120, height: 14 },
  segmentRects: [{ x: 72, y: 92, width: 120, height: 14 }],
  reliable: true as const,
};
const crossPageSelection = {
  ...selection,
  quote: 'unique equilibrium\ncontinued argument',
  suffix: ' concludes',
  pages: [
    {
      pageIndex: 0,
      quote: 'unique equilibrium',
      prefix: 'the ',
      suffix: '',
      rect: selection.rect,
      segmentRects: selection.segmentRects,
    },
    {
      pageIndex: 1,
      quote: 'continued argument',
      prefix: '',
      suffix: ' concludes',
      rect: { x: 72, y: 40, width: 140, height: 14 },
      segmentRects: [{ x: 72, y: 40, width: 140, height: 14 }],
    },
  ],
  pageBoundaries: [{ afterPageIndex: 0, separator: '\n' }],
};
const caret = {
  pageIndex: 0,
  position: { x: 192, y: 92, width: 2, height: 14 },
  leftContext: 'the equilibrium',
  rightContext: ' exists',
  reliable: true as const,
};

function setup(): { state: DocumentState; commands: DocumentCommandFactory } {
  let id = 0;
  const commands = new (class implements DocumentCommandFactory {
    createId() {
      id += 1;
      return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
    }
    now() {
      return '2026-08-07T12:00:00.000Z';
    }
  })();
  return {
    state: createDocumentState({ sessionId: 'session', source }),
    commands,
  };
}

function protectedDraft(state: DocumentState, text: string): PendingDocumentDraftV1 {
  return { id: '00000000-0000-4000-8000-000000000999', ownerViewId: 'panel-a',
    baseGeneration: state.workflow.documentGeneration, revision: 0, kind: 'highlight', pageIndex: 0, text,
    anchor: { kind: 'selection', ...selection }, disposition: { kind: 'resolved', generation: state.workflow.documentGeneration },
    status: 'protected', createdAt: '2026-08-07T12:00:00.000Z', updatedAt: '2026-08-07T12:00:00.000Z' };
}

describe('canonical review commands', () => {
  it('keeps hundreds of durable draft updates outside semantic history and Apply consumes the draft permanently', () => {
    let { state } = setup();
    for (let index = 0; index < 300; index++) {
      state = reduceDocument(state, { type: 'put-draft', expectedRevision: state.revision,
        expectedDraftRevision: index - 1, draft: protectedDraft(state, `text ${index}`) });
    }
    expect(state.revision).toBe(300);
    expect(state.pendingDrafts[0]?.revision).toBe(299);
    expect(state.history).toHaveLength(0);
    state = reduceDocument(state, { type: 'apply-draft', expectedRevision: state.revision,
      id: state.pendingDrafts[0]!.id, expectedDraftRevision: 299, ownerViewId: 'panel-a', updatedAt: '2026-08-07T12:01:00.000Z' });
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ schemaVersion: 1, itemChanges: [{ before: null }] });
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items).toEqual([]);
    expect(state.pendingDrafts).toEqual([]);
  });

  it('undoes an applied edit to its previous item without reopening its consumed draft', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addHighlight(state, selection, 'Original', commands));
    const original = state.items[0]!;
    state = reduceDocument(state, { type: 'put-draft', expectedRevision: state.revision, expectedDraftRevision: -1,
      draft: { ...protectedDraft(state, 'Revised'), targetItemId: original.id } });
    state = reduceDocument(state, { type: 'apply-draft', expectedRevision: state.revision, id: state.pendingDrafts[0]!.id,
      expectedDraftRevision: 0, ownerViewId: 'panel-a', updatedAt: '2026-08-07T12:01:00.000Z' });
    expect(state.items[0]?.payload.comment).toBe('Revised');
    expect(state.history).toHaveLength(2);
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items).toEqual([original]);
    expect(state.pendingDrafts).toEqual([]);
    state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items[0]?.payload.comment).toBe('Revised');
    expect(state.pendingDrafts).toEqual([]);
  });

  it('preserves redo and other current drafts and their audit through document undo', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addHighlight(state, selection, 'Keep', commands));
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    state = reduceDocument(state, { type: 'put-draft', expectedRevision: state.revision,
      expectedDraftRevision: -1, draft: protectedDraft(state, 'other view text') });
    expect(state.historyCursor).toBe(0);
    expect(state.history).toHaveLength(1);
    state = reduceDocument(state, { type: 'discard-reconciliation', target: 'draft', id: state.pendingDrafts[0]!.id,
      expectedRevision: state.revision, expectedTargetRevision: 0, ownerViewId: 'panel-a', reason: 'discard draft', discardedAt: '2026-08-07T12:02:00.000Z' });
    expect(state.historyCursor).toBe(0);
    state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    state = reduceDocument(state, { type: 'discard-reconciliation', target: 'item', id: state.items[0]!.id,
      expectedRevision: state.revision, expectedTargetRevision: 0, ownerViewId: 'panel-a', reason: 'discard item', discardedAt: '2026-08-07T12:03:00.000Z' });
    state = reduceDocument(state, { type: 'put-draft', expectedRevision: state.revision,
      expectedDraftRevision: -1, draft: protectedDraft(state, 'latest other view text') });
    state = reduceDocument(state, { type: 'discard-reconciliation', target: 'draft', id: state.pendingDrafts[0]!.id,
      expectedRevision: state.revision, expectedTargetRevision: 0, ownerViewId: 'panel-a', reason: 'later draft discard', discardedAt: '2026-08-07T12:04:00.000Z' });
    state = reduceDocument(state, { type: 'put-draft', expectedRevision: state.revision,
      expectedDraftRevision: -1, draft: protectedDraft(state, 'latest other view text') });
    const drafts = state.pendingDrafts;
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items).toHaveLength(1);
    expect(state.pendingDrafts).toEqual(drafts);
    expect(state.discardAudit.map(({ target, reason }) => ({ target, reason }))).toEqual([
      { target: 'draft', reason: 'discard draft' }, { target: 'draft', reason: 'later draft discard' },
    ]);
    state = startDocumentGeneration(state, { documentGeneration: 2 });
    expect(state.history).toEqual([]);
    expect(state.historyCursor).toBe(0);
    expect(state.items).toHaveLength(1);
    expect(state.pendingDrafts[0]).toMatchObject({ text: 'latest other view text', status: 'frozen' });
  });

  it('dispatches legacy snapshot undo without restoring consumed or unrelated draft snapshots', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addHighlight(state, selection, 'Keep', commands));
    const draft = protectedDraft(state, 'current draft');
    state = { ...state, pendingDrafts: [draft], history: [{ beforeItems: [], afterItems: state.items,
      beforePendingDrafts: [], afterPendingDrafts: [] }], historyCursor: 1 };
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items).toEqual([]);
    expect(state.pendingDrafts).toEqual([draft]);
    state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items).toHaveLength(1);
    expect(state.pendingDrafts).toEqual([draft]);
  });

  it.each([
    ['replace', (state: DocumentState, commands: DocumentCommandFactory) => addReplace(state, crossPageSelection, 'revised', commands)],
    ['delete', (state: DocumentState, commands: DocumentCommandFactory) => addDelete(state, crossPageSelection, commands)],
    ['highlight', (state: DocumentState, commands: DocumentCommandFactory) => addHighlight(state, crossPageSelection, 'Keep', commands)],
  ])('creates one atomic cross-page %s item and history entry', (_kind, build) => {
    let { state, commands } = setup();
    state = reduceDocument(state, build(state, commands));

    expect(state.items).toHaveLength(1);
    expect(state.history).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      pageIndex: 0,
      payload: {
        quote: crossPageSelection.quote,
        pages: crossPageSelection.pages,
        pageBoundaries: crossPageSelection.pageBoundaries,
      },
    });

    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items).toEqual([]);
    state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.payload.pages).toEqual(crossPageSelection.pages);
  });

  it('normalizes legacy selection evidence without changing compatibility fields', () => {
    expect(normalizeDocumentSelectionAnchor(selection)).toEqual({
      ...selection,
      pages: [{
        pageIndex: selection.pageIndex,
        quote: selection.quote,
        prefix: selection.prefix,
        suffix: selection.suffix,
        rect: selection.rect,
        segmentRects: selection.segmentRects,
      }],
      pageBoundaries: [],
    });
  });

  it('rejects malformed and over-limit cross-page selections before state changes', () => {
    const { state, commands } = setup();
    const malformed = [
      { ...crossPageSelection, pages: [crossPageSelection.pages[0]!, { ...crossPageSelection.pages[1]!, pageIndex: 2 }] },
      { ...crossPageSelection, pages: [crossPageSelection.pages[0]!, { ...crossPageSelection.pages[1]!, pageIndex: 0 }] },
      { ...crossPageSelection, pages: [crossPageSelection.pages[1]!, crossPageSelection.pages[0]!] },
      { ...crossPageSelection, pages: [crossPageSelection.pages[0]!, { ...crossPageSelection.pages[1]!, quote: 'different' }] },
      { ...crossPageSelection, pages: [crossPageSelection.pages[0]!, { ...crossPageSelection.pages[1]!, rect: { x: 0, y: 0, width: -1, height: 2 } }] },
    ];
    for (const anchor of malformed) {
      expect(() => reduceDocument(state, addDelete(state, anchor, commands))).toThrow(InvalidDocumentCommandError);
      expect(state).toMatchObject({ revision: 0, items: [], history: [] });
    }

    const pages = Array.from({ length: 13 }, (_, pageIndex) => ({
      pageIndex,
      quote: `p${pageIndex}`,
      prefix: '',
      suffix: '',
      rect: selection.rect,
      segmentRects: selection.segmentRects,
    }));
    const twelvePages = pages.slice(0, 12);
    expect(() => reduceDocument(state, addDelete(state, {
      ...selection,
      quote: twelvePages.map(({ quote }) => quote).join('\n'),
      prefix: '',
      suffix: '',
      pages: twelvePages,
      pageBoundaries: twelvePages.slice(0, -1).map(({ pageIndex }) => ({ afterPageIndex: pageIndex, separator: '\n' })),
    }, commands))).not.toThrow();
    expect(() => reduceDocument(state, addDelete(state, {
      ...selection,
      quote: pages.map(({ quote }) => quote).join('\n'),
      prefix: '',
      suffix: '',
      pages,
      pageBoundaries: pages.slice(0, -1).map(({ pageIndex }) => ({ afterPageIndex: pageIndex, separator: '\n' })),
    }, commands))).toThrow(/at most 12 pages/iu);
  });

  it('applies the 256 segment limit to the complete group', () => {
    const { state, commands } = setup();
    const pageWithSegments = (pageIndex: number, count: number) => ({
      pageIndex,
      quote: `p${pageIndex}`,
      prefix: '',
      suffix: '',
      rect: selection.rect,
      segmentRects: Array.from({ length: count }, () => ({ ...selection.rect })),
    });
    const anchor = (count: number) => {
      const pages = [pageWithSegments(0, 128), pageWithSegments(1, count - 128)];
      return {
        ...selection,
        quote: 'p0\np1',
        prefix: '',
        suffix: '',
        rect: pages[0]!.rect,
        segmentRects: pages[0]!.segmentRects,
        pages,
        pageBoundaries: [{ afterPageIndex: 0, separator: '\n' }],
      };
    };

    expect(() => reduceDocument(state, addHighlight(state, anchor(256), undefined, commands))).not.toThrow();
    expect(() => reduceDocument(state, addHighlight(state, anchor(257), undefined, commands)))
      .toThrow(/at most 256 text segments/iu);
  });

  it('rejects a final child envelope over 32 KiB before acknowledgement', () => {
    const { state, commands } = setup();
    const build = (length: number) => {
      const suffix = 'x'.repeat(length);
      return addReplace(state, {
        ...crossPageSelection,
        suffix,
        pages: [
          crossPageSelection.pages[0]!,
          { ...crossPageSelection.pages[1]!, suffix },
        ],
      }, 'y'.repeat(8_000), commands);
    };
    const size = (length: number) => {
      const command = build(length);
      if (command.type !== 'add') throw new Error('Expected add');
      return serializePortableAnnotationGroup(command.item).at(-1)!.byteLength;
    };
    let low = 0;
    let high = PORTABLE_ANNOTATION_MAX_BYTES;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (size(middle) <= PORTABLE_ANNOTATION_MAX_BYTES) low = middle;
      else high = middle - 1;
    }

    expect(size(low)).toBeLessThanOrEqual(PORTABLE_ANNOTATION_MAX_BYTES);
    expect(size(low + 1)).toBeGreaterThan(PORTABLE_ANNOTATION_MAX_BYTES);
    for (const length of [low, low + 1]) {
      const command = build(length);
      if (command.type !== 'add') throw new Error('Expected add');
      const before = serializePortableAnnotationGroup(command.item);
      const after = serializePortableAnnotationGroup(canonicalizeAnnotation(command.item, {
        ownerViewId: 'main',
        baseGeneration: state.workflow.documentGeneration,
      }));
      expect(after.map(({ serialized }) => serialized))
        .toEqual(before.map(({ serialized }) => serialized));
      expect(after.map(({ byteLength }) => byteLength))
        .toEqual(before.map(({ byteLength }) => byteLength));
    }
    expect(() => reduceDocument(state, build(low))).not.toThrow();
    expect(() => reduceDocument(state, build(low + 1))).toThrow(/too much text or geometry/iu);
    expect(state).toMatchObject({ revision: 0, items: [], history: [] });
  });

  it('rejects importer-unsafe grouped metadata before acknowledgement', () => {
    const { state, commands } = setup();
    const pageQuote = 'x'.repeat(8_500);
    const pages = crossPageSelection.pages.map((page, index) => ({
      ...page,
      quote: index === 0 ? pageQuote : `y${pageQuote.slice(1)}`,
    }));
    const fullQuote = pages.map(({ quote }) => quote).join('\n');
    const command = addDelete(state, {
      ...crossPageSelection,
      quote: fullQuote,
      pages,
    }, commands);
    if (command.type !== 'add') throw new Error('Expected add');

    const children = serializePortableAnnotationGroup(command.item);
    expect(fullQuote.length).toBeGreaterThan(16 * 1024);
    expect(children).toHaveLength(2);
    expect(children.every(({ byteLength }) =>
      byteLength < PORTABLE_ANNOTATION_MAX_BYTES)).toBe(true);
    expect(() => reduceDocument(state, command)).toThrow(/too complex to preserve/iu);
    expect(state).toMatchObject({ revision: 0, items: [], history: [] });
  });

  it('keeps generated-output items and pending authoring generation-bound and revisioned', () => {
    let state = createDocumentState({
      sessionId: 'session',
      source,
      workflowMode: 'generated-output',
      documentGeneration: 4,
    });
    const commands = setup().commands;
    const addCommand = addReplace(state, selection, 'locally unique equilibrium', commands);
    if (addCommand.type !== 'add') throw new Error('Expected add');
    state = reduceDocument(state, {
      ...addCommand,
      authoring: { ownerViewId: 'panel-a', baseGeneration: 4 },
    });

    expect(state.workflow).toMatchObject({
      mode: 'generated-output',
      documentRole: 'generated-output',
      documentGeneration: 4,
    });
    expect(state.items[0]?.reconciliation).toMatchObject({
      ownerViewId: 'panel-a',
      baseGeneration: 4,
      revision: 0,
      disposition: { kind: 'resolved', generation: 4 },
    });

    state = reduceDocument(state, {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: -1,
      draft: {
        id: '00000000-0000-4000-8000-000000000099',
        ownerViewId: 'panel-a',
        baseGeneration: 4,
        revision: 0,
        kind: 'replace',
        pageIndex: 0,
        text: 'draft replacement',
        anchor: anchorEvidenceFromAnnotation(state.items[0]!),
        disposition: { kind: 'resolved', generation: 4 },
        status: 'protected',
        createdAt: '2026-08-07T12:00:00.000Z',
        updatedAt: '2026-08-07T12:00:00.000Z',
      },
    });
    expect(state.pendingDrafts[0]).toMatchObject({ revision: 0, status: 'protected' });

    expect(() => reduceDocument(state, {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: -1,
      draft: { ...state.pendingDrafts[0]!, text: 'racing update' },
    })).toThrow(/draft revision/iu);

    state = reduceDocument(state, {
      type: 'apply-draft',
      expectedRevision: state.revision,
      id: state.pendingDrafts[0]!.id,
      expectedDraftRevision: state.pendingDrafts[0]!.revision,
      ownerViewId: 'panel-a',
      updatedAt: '2026-08-07T12:01:00.000Z',
    });
    expect(state.pendingDrafts).toEqual([]);
    expect(state.items[1]).toMatchObject({
      id: '00000000-0000-4000-8000-000000000099',
      kind: 'replace',
      payload: { proposedText: 'draft replacement' },
      reconciliation: { disposition: { kind: 'resolved', generation: 4 } },
    });
  });

  it('initializes ordinary review reconciliation metadata before a generation transition', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addHighlight(state, selection, 'Keep', commands));

    expect(state.workflow.mode).toBe('standard');
    expect(state.items[0]?.reconciliation).toMatchObject({
      baseGeneration: 1,
      revision: 0,
      disposition: { kind: 'resolved', generation: 1 },
    });

    state = startDocumentGeneration(state, { documentGeneration: 2 });
    expect(state.workflow).toMatchObject({ documentGeneration: 2, historyBoundary: 0 });
    expect(() => reduceDocument(state, { type: 'undo', expectedRevision: state.revision }))
      .toThrow(/no document command to undo/iu);
  });

  it('applies an acknowledged protected draft in an ordinary review', () => {
    let { state } = setup();
    state = reduceDocument(state, {
      type: 'put-draft',
      expectedRevision: state.revision,
      expectedDraftRevision: -1,
      draft: {
        id: '00000000-0000-4000-8000-000000000199',
        ownerViewId: 'attachment-ordinary',
        baseGeneration: state.workflow.documentGeneration,
        revision: 0,
        kind: 'highlight',
        pageIndex: 0,
        text: 'ordinary protected text',
        anchor: { kind: 'selection', ...selection },
        disposition: { kind: 'resolved', generation: state.workflow.documentGeneration },
        status: 'protected',
        createdAt: '2026-09-15T12:00:00.000Z',
        updatedAt: '2026-09-15T12:00:01.000Z',
      },
    });
    state = reduceDocument(state, {
      type: 'apply-draft',
      expectedRevision: state.revision,
      id: state.pendingDrafts[0]!.id,
      expectedDraftRevision: state.pendingDrafts[0]!.revision,
      ownerViewId: 'attachment-ordinary',
      updatedAt: '2026-09-15T12:00:02.000Z',
    });
    expect(state.workflow.mode).toBe('standard');
    expect(state.pendingDrafts).toEqual([]);
    expect(state.items[0]).toMatchObject({
      kind: 'highlight',
      payload: { comment: 'ordinary protected text' },
      reconciliation: { ownerViewId: 'attachment-ordinary' },
    });
  });

  it('reattaches while preserving proposed text and fences undo at a rebuild boundary', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addReplace(state, selection, 'same semantics', commands));
    const before = state.items[0]!;
    state = startDocumentGeneration(state, { documentGeneration: 2 });
    expect(state.items[0]?.reconciliation?.disposition.kind).toBe('missing');

    const nextAnchor = {
      ...anchorEvidenceFromAnnotation(before),
      pageIndex: 2,
      rect: { x: 20, y: 30, width: 40, height: 10 },
      segmentRects: [{ x: 20, y: 30, width: 40, height: 10 }],
    };
    state = reduceDocument(state, {
      type: 'reattach',
      expectedRevision: state.revision,
      id: before.id,
      expectedReconciliationRevision: 1,
      ownerViewId: 'panel-b',
      anchor: nextAnchor,
      updatedAt: '2026-08-07T12:05:00.000Z',
    });
    expect(state.items[0]?.payload).toMatchObject({
      quote: 'unique equilibrium',
      proposedText: 'same semantics',
      rect: { x: 20, y: 30, width: 40, height: 10 },
      pages: [{ pageIndex: 2, quote: 'unique equilibrium' }],
      pageBoundaries: [],
    });
    expect(state.items[0]?.pageIndex).toBe(2);
    expect(state.items[0]?.reconciliation).toMatchObject({
      revision: 2,
      disposition: { kind: 'resolved', generation: 2 },
      anchor: { pageIndex: 2 },
    });

    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items[0]?.reconciliation?.disposition.kind).toBe('missing');
    expect(() => reduceDocument(state, { type: 'undo', expectedRevision: state.revision }))
      .toThrow(/no document command to undo/iu);
  });

  it('reattaches a complete cross-page anchor and synchronizes its payload in one history entry', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addReplace(state, selection, 'same semantics', commands));
    const before = state.items[0]!;
    state = startDocumentGeneration(state, { documentGeneration: 2 });
    const beforeHistoryLength = state.history.length;
    const pages = [2, 3].map((pageIndex) => ({
      pageIndex,
      quote: pageIndex === 2 ? 'replacement' : 'target',
      prefix: pageIndex === 2 ? 'left ' : '',
      suffix: pageIndex === 3 ? ' right' : '',
      rect: { x: 20, y: pageIndex === 2 ? 30 : 10, width: 40, height: 10 },
      segmentRects: [{ x: 20, y: pageIndex === 2 ? 30 : 10, width: 40, height: 10 }],
    }));
    const nextAnchor = {
      kind: 'selection' as const,
      pageIndex: 2,
      quote: 'replacement\ntarget',
      prefix: 'left ',
      suffix: ' right',
      rect: pages[0]!.rect,
      segmentRects: pages[0]!.segmentRects,
      pages,
      pageBoundaries: [{ afterPageIndex: 2, separator: '\n' }],
    };

    state = reduceDocument(state, {
      type: 'reattach',
      expectedRevision: state.revision,
      id: before.id,
      expectedReconciliationRevision: 1,
      ownerViewId: 'panel-b',
      anchor: nextAnchor,
      updatedAt: '2026-08-07T12:05:00.000Z',
    });

    expect(state.history).toHaveLength(beforeHistoryLength + 1);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.reconciliation?.anchor).toEqual(nextAnchor);
    expect(state.items[0]?.payload).toMatchObject({
      quote: 'replacement\ntarget',
      prefix: 'left ',
      suffix: ' right',
      proposedText: 'same semantics',
      pages,
      pageBoundaries: [{ afterPageIndex: 2, separator: '\n' }],
    });
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items[0]?.reconciliation?.anchor).toEqual(anchorEvidenceFromAnnotation(before));
    expect(state.items[0]?.payload).toEqual(before.payload);
  });

  it('rejects unknown and item-incompatible reattachment anchors', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addReplace(state, selection, 'same semantics', commands));
    state = startDocumentGeneration(state, { documentGeneration: 2 });
    const item = state.items[0]!;
    const command = {
      type: 'reattach',
      expectedRevision: state.revision,
      id: item.id,
      expectedReconciliationRevision: item.reconciliation!.revision,
      ownerViewId: 'panel-b',
      updatedAt: '2026-08-07T12:05:00.000Z',
    } as const;

    expect(() => reduceDocument(state, {
      ...command,
      anchor: {
        kind: 'unknown',
        pageIndex: 0,
        rect: { x: 20, y: 30, width: 40, height: 10 },
      },
    } as unknown as DocumentCommand)).toThrow(/anchor kind/iu);

    expect(() => reduceDocument(state, {
      ...command,
      anchor: {
        kind: 'caret',
        pageIndex: 0,
        leftContext: 'before',
        rightContext: 'after',
        rect: { x: 20, y: 30, width: 2, height: 10 },
      },
    })).toThrow(/requires a selection anchor/iu);
  });

  it('drops predecessor redo entries when a rebuild starts', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addReplace(state, selection, 'first', commands));
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.historyCursor).toBe(0);
    expect(state.history).toHaveLength(1);

    state = startDocumentGeneration(state, { documentGeneration: 2 });

    expect(state.history).toHaveLength(0);
    expect(state.historyCursor).toBe(0);
    expect(state.workflow.historyBoundary).toBe(0);
    expect(() => reduceDocument(state, { type: 'redo', expectedRevision: state.revision }))
      .toThrow(/no document command to redo/iu);
  });

  it('creates all five v1 tools as stable semantic items and advances one revision each', () => {
    let { state, commands } = setup();
    const commandBuilders = [
      () => addReplace(state, selection, 'locally unique equilibrium', commands),
      () => addDelete(state, selection, commands),
      () => addInsert(state, caret, 'perhaps ', commands),
      () => addHighlight(state, selection, 'Check this claim.', commands),
      () => addPageNote(state, 1, { x: 44, y: 55, width: 18, height: 18 }, 'Rewrite this paragraph.', commands),
    ];

    for (const build of commandBuilders) state = reduceDocument(state, build());

    expect(state.revision).toBe(5);
    expect(state.items.map(({ kind }) => kind)).toEqual([
      'replace', 'delete', 'insert', 'highlight', 'pageNote',
    ]);
    expect(new Set(state.items.map(({ id }) => id)).size).toBe(5);
    expect(state.items[0]?.payload).toMatchObject({
      quote: 'unique equilibrium',
      reliable: true,
      proposedText: 'locally unique equilibrium',
    });
    expect(state.items[2]?.payload).toMatchObject({
      leftContext: 'the equilibrium',
      rightContext: ' exists',
      reliable: true,
      proposedText: 'perhaps ',
    });
    expect(state.items[2]?.payload).not.toHaveProperty('quote');

    const ids = state.items.map(({ id }) => id);
    for (let index = 0; index < 5; index += 1) {
      state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    }
    expect(state.items).toEqual([]);
    for (let index = 0; index < 5; index += 1) {
      state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    }
    expect(state.items.map(({ id }) => id)).toEqual(ids);
  });

  it('preserves an ID through edits and undo/redo, while delete-and-recreate gets a new ID', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addHighlight(state, selection, undefined, commands));
    const firstId = state.items[0]!.id;
    state = reduceDocument(state, editAnnotation(state, firstId, { comment: 'Keep this.' }, commands));
    expect(state.items[0]).toMatchObject({ id: firstId, payload: { comment: 'Keep this.' } });

    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    expect(state.items[0]).toMatchObject({ id: firstId, payload: {} });
    state = reduceDocument(state, { type: 'redo', expectedRevision: state.revision });
    expect(state.items[0]).toMatchObject({ id: firstId, payload: { comment: 'Keep this.' } });

    state = reduceDocument(state, removeAnnotation(state, firstId));
    state = reduceDocument(state, addHighlight(state, selection, 'Keep this.', commands));
    expect(state.items[0]!.id).not.toBe(firstId);
  });

  it('persists canonical undo/redo history through recovery serialization', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addReplace(state, selection, 'locally unique equilibrium', commands));
    state = reduceDocument(state, addDelete(state, { ...selection, quote: 'clearly' }, commands));
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });

    const recovered = JSON.parse(JSON.stringify(state)) as DocumentState;
    const redone = reduceDocument(recovered, { type: 'redo', expectedRevision: recovered.revision });
    expect(redone.items.map(({ kind }) => kind)).toEqual(['replace', 'delete']);
    expect(redone.revision).toBe(4);
    const backAgain = reduceDocument(redone, { type: 'undo', expectedRevision: redone.revision });
    expect(backAgain.items.map(({ kind }) => kind)).toEqual(['replace']);
  });

  it('clears redo after a new mutation and preserves meaningful whitespace suggestions', () => {
    let { state, commands } = setup();
    state = reduceDocument(state, addReplace(state, selection, 'first', commands));
    state = reduceDocument(state, addDelete(state, selection, commands));
    state = reduceDocument(state, { type: 'undo', expectedRevision: state.revision });
    state = reduceDocument(state, addInsert(state, caret, ' ', commands));

    expect(state.historyCursor).toBe(2);
    expect(state.history).toHaveLength(2);
    expect(state.items.map(({ kind }) => kind)).toEqual(['replace', 'insert']);
    expect(state.items[1]?.payload.proposedText).toBe(' ');
    expect(() => reduceDocument(state, { type: 'redo', expectedRevision: state.revision }))
      .toThrow(InvalidDocumentCommandError);
  });

  it('rejects payloads that do not deeply match their semantic tool', () => {
    const { state, commands } = setup();
    const command = addHighlight(state, selection, undefined, commands);
    if (command.type !== 'add') throw new Error('Expected an add command');
    const invalid = {
      ...command,
      item: { ...command.item, payload: { comment: 'missing anchor' } },
    };

    expect(() => reduceDocument(state, invalid)).toThrow(InvalidDocumentCommandError);

    const deleteCommand = addDelete(state, selection, commands);
    if (deleteCommand.type !== 'add') throw new Error('Expected an add command');
    const { reliable: _reliable, ...untrustedPayload } = deleteCommand.item.payload;
    expect(() => reduceDocument(state, {
      ...deleteCommand,
      item: { ...deleteCommand.item, payload: untrustedPayload },
    })).toThrow(InvalidDocumentCommandError);
  });

  it('accepts bounded long selections and rejects larger ones with an actionable error', () => {
    const { state, commands } = setup();
    const segment = { x: 72, y: 92, width: 12, height: 8 };
    expect(MAX_DOCUMENT_SELECTION_SEGMENTS).toBe(256);
    const maximum = {
      ...selection,
      segmentRects: Array.from({ length: MAX_DOCUMENT_SELECTION_SEGMENTS }, () => ({ ...segment })),
    };
    expect(() => reduceDocument(state, addHighlight(state, maximum, undefined, commands)))
      .not.toThrow();

    const tooLong = {
      ...selection,
      segmentRects: [...maximum.segmentRects, { ...segment }],
    };
    expect(() => reduceDocument(state, addHighlight(state, tooLong, undefined, commands)))
      .toThrow(`Selections can contain at most ${MAX_DOCUMENT_SELECTION_SEGMENTS} text segments. Shorten the selection and try again.`);
  });
});
