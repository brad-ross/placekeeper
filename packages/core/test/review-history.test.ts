import { describe, expect, it } from 'vitest';
import type { PendingReviewDraftV1, ReviewDiscardAuditV1, ReviewHistoryEntry, ReviewItem } from '../src/review-model.js';
import { appendReviewHistory, boundReviewHistory, createReviewHistoryEntry, normalizeReviewHistory, replayReviewHistoryEntry, serializedReviewHistoryBytes } from '../src/review-history.js';

const item = (id: string, comment = id): ReviewItem => ({ id, kind: 'pageNote', pageIndex: 0, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z', payload: { comment, position: { x: 1, y: 1, width: 1, height: 1 } } });
const draft = (text: string): PendingReviewDraftV1 => ({ id: 'draft', ownerViewId: 'view', baseGeneration: 0, revision: text.length, kind: 'pageNote', pageIndex: 0, text, anchor: { kind: 'page', pageIndex: 0, rect: { x: 1, y: 1, width: 1, height: 1 } }, disposition: { kind: 'resolved', generation: 0 }, status: 'protected', createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z' });
const audit = (id: string, target: 'item' | 'draft' = 'item'): ReviewDiscardAuditV1 => ({ id, target, generation: 0, revision: 1, ownerViewId: 'view', reason: 'discard', discardedAt: '2026-10-16T00:00:00Z' });
const state = (items: readonly ReviewItem[], discardAudit: readonly ReviewDiscardAuditV1[] = []) => ({ items, discardAudit });
const delta = (before: readonly ReviewItem[], after: readonly ReviewItem[]) => createReviewHistoryEntry(state(before), state(after), 0)!;
const snapshot = (beforeItems: readonly ReviewItem[], afterItems: readonly ReviewItem[]): ReviewHistoryEntry => ({ beforeItems, afterItems });

describe('compact review history', () => {
  it('reverses adds, edits, removals and ordering while preserving unrelated imported items', () => {
    const a = item('a'), b = item('b'), c = item('c'), imported = item('native');
    const entry = delta([a, b, c], [c, item('b', 'edited'), item('d')]);
    const undone = replayReviewHistoryEntry(state([c, item('b', 'edited'), item('d'), imported]), entry, 'undo');
    expect(undone.items).toEqual([a, b, c, imported]);
    expect(replayReviewHistoryEntry(undone, entry, 'redo').items).toEqual([c, item('b', 'edited'), item('d'), imported]);
  });

  it('records only changed entities and preserves current drafts and unrelated audit', () => {
    const a = item('a'), b = item('b'), discarded = audit('a'), draftAudit = audit('draft', 'draft');
    const entry = createReviewHistoryEntry(state([a, b]), state([b], [discarded]))!;
    expect(entry.itemChanges.map(change => change.id)).toEqual(['a']);
    const current = { ...state([b], [discarded, draftAudit]), pendingDrafts: [{ id: 'current-draft' }] };
    const undone = replayReviewHistoryEntry(current, entry, 'undo');
    expect(undone.items).toEqual([a, b]);
    expect(undone.discardAudit).toEqual([draftAudit]);
    expect(undone.pendingDrafts).toBe(current.pendingDrafts);
    expect(replayReviewHistoryEntry(undone, entry, 'redo').discardAudit).toEqual([discarded, draftAudit]);
  });

  it('filters structural legacy no-ops and draft-only changes with cursor and boundary mapping', () => {
    const a = item('a');
    const reordered = { ...a, payload: { position: { height: 1, width: 1, y: 1, x: 1 }, comment: 'a' } };
    const entries = [snapshot([], []), snapshot([], [a]), { ...snapshot([a], [reordered]), beforeDiscardAudit: [], afterDiscardAudit: [audit('draft', 'draft')] }, snapshot([a], [item('a', 'edited')])];
    const normalized = normalizeReviewHistory(entries, 3, 0);
    expect(normalized.history).toHaveLength(2);
    expect(normalized.historyCursor).toBe(1);
    expect(normalized.historyBoundary).toBe(0);
    expect(replayReviewHistoryEntry(state([a]), normalized.history[1]!, 'redo').items).toEqual([item('a', 'edited')]);
  });

  it('prunes unreachable pre-boundary history and retains redo after legacy no-op mapping', () => {
    const a = item('a'), edited = item('a', 'edited');
    const entries = [snapshot([], []), snapshot([], [a]), snapshot([a], [a]), { ...snapshot([a], [edited]), generation: 0 }];
    const normalized = normalizeReviewHistory(entries, 3, 2);
    expect(normalized).toEqual({ history: [delta([a], [edited])], historyCursor: 0, historyBoundary: 0 });
    expect(replayReviewHistoryEntry(state([a]), normalized.history[0]!, 'redo').items).toEqual([edited]);
  });

  it('does not copy unchanged items whose indexes shift after insertion or removal', () => {
    const a = item('a'), b = item('b'), c = item('c');
    const entry = delta([a, c], [a, b, c]);
    expect(entry.itemChanges.map(change => change.id)).toEqual(['b']);
    expect(replayReviewHistoryEntry(state([a, b, c]), entry, 'undo').items).toEqual([a, c]);
    const history = [entry, delta([a, b, c], [a, c])];
    expect(appendReviewHistory(history, 1, 0, null)).toEqual({ history, historyCursor: 1, historyBoundary: 0 });
  });

  it('uses audit identity independent of object key order', () => {
    const original = audit('a');
    const reversed = Object.fromEntries(Object.entries(original).reverse()) as unknown as ReviewDiscardAuditV1;
    expect(createReviewHistoryEntry(state([], [original]), state([], [reversed]))).toBeNull();
  });

  it('trims oldest applied entries then farthest redo and remaps boundaries', () => {
    const entries = Array.from({ length: 205 }, (_, i) => delta([], [item(String(i))]));
    const bounded = boundReviewHistory(entries, 3, 2);
    expect(bounded.history).toEqual(entries.slice(3, 203));
    expect(bounded.historyCursor).toBe(0);
    expect(bounded.historyBoundary).toBe(0);
    const appended = appendReviewHistory(entries.slice(0, 3), 1, 0, delta([], [item('branch')]));
    expect(appended.history).toHaveLength(2);
    expect(appended.historyCursor).toBe(2);
  });

  it('bounds serialized UTF-8 bytes and drops an oversized entry without touching the checkpoint', () => {
    const entry = delta([], [item('a', '🙂'.repeat(1_100_000))]);
    expect(serializedReviewHistoryBytes([entry])).toBeGreaterThan(JSON.stringify([entry]).length);
    const entries = [entry, delta([], [item('b')]), entry];
    const bounded = boundReviewHistory(entries, 1, 0);
    expect(bounded.history).toHaveLength(1);
    expect(bounded.historyCursor).toBe(0);
    expect(serializedReviewHistoryBytes(bounded.history)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(appendReviewHistory([], 0, 0, entry).history).toEqual([]);
  });

  it('bounds cumulative bytes by trimming applied entries before farthest redo and preserves replay order', () => {
    const budget = 4 * 1024 * 1024;
    const items = Array.from({ length: 6 }, (_, index) => item(String(index), '🙂'.repeat(275_000)));
    const entries = items.map((_, index) => delta(items.slice(0, index), items.slice(0, index + 1)));
    expect(entries.every(entry => serializedReviewHistoryBytes([entry]) < budget)).toBe(true);
    expect(serializedReviewHistoryBytes(entries)).toBeGreaterThan(budget);

    const imported = item('native');
    const checkpoint = state([...items.slice(0, 2), imported]);
    const bounded = boundReviewHistory(entries, 2, 1);
    // Removing both applied entries still leaves four redo entries above the byte cap.
    expect(serializedReviewHistoryBytes(entries.slice(2))).toBeGreaterThan(budget);
    expect(bounded.history).toEqual(entries.slice(2, 5));
    expect(bounded.historyCursor).toBe(0);
    expect(bounded.historyBoundary).toBe(0);
    expect(serializedReviewHistoryBytes(bounded.history)).toBeLessThanOrEqual(budget);

    let replayed = checkpoint;
    for (const entry of bounded.history) replayed = replayReviewHistoryEntry(replayed, entry, 'redo');
    expect(replayed.items.map(item => item.id)).toEqual(['0', '1', '2', '3', '4', 'native']);
    for (const entry of [...bounded.history].reverse()) replayed = replayReviewHistoryEntry(replayed, entry, 'undo');
    expect(replayed).toEqual(checkpoint);
    expect(checkpoint.items.map(item => item.id)).toEqual(['0', '1', 'native']);
  });

  it('rejects malformed versioned history and invalid cursors while accepting legacy snapshots', () => {
    const valid = delta([], [item('a')]);
    for (const bad of [{ ...valid, schemaVersion: 2 }, { ...valid, itemChanges: null }, { ...valid, itemChanges: [{ id: 'a', before: null, after: { item: item('b'), index: -1 } }] }, { ...valid, auditChanges: [{ identity: 'wrong', before: null, after: { audit: audit('draft', 'draft'), index: 0 } }] }]) {
      expect(() => normalizeReviewHistory([bad] as never, 1, 0)).toThrow();
    }
    expect(() => normalizeReviewHistory([valid], 2, 0)).toThrow();
    expect(normalizeReviewHistory([snapshot([], [item('a')])], 1, 0).history).toHaveLength(1);
  });

  it('stores edits proportional to changed items rather than all annotations', () => {
    const items = Array.from({ length: 500 }, (_, i) => item(String(i), 'x'.repeat(100)));
    const edits = Array.from({ length: 100 }, (_, i) => snapshot(items, items.map((entry, index) => index === 0 ? item(entry.id, String(i)) : entry)));
    const typing = Array.from({ length: 100 }, (_, i) => ({ ...snapshot(items, items), beforePendingDrafts: [draft('x'.repeat(i))], afterPendingDrafts: [draft('x'.repeat(i + 1))] }));
    const old = [...typing, ...edits];
    const compact = normalizeReviewHistory(old, old.length, 0).history;
    expect(compact).toHaveLength(edits.length);
    const oldBytes = serializedReviewHistoryBytes(old), compactBytes = serializedReviewHistoryBytes(compact);
    expect(compactBytes).toBeLessThan(oldBytes / 100);
  });
});
