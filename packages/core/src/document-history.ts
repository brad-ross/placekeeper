import type { DocumentDiscardAuditV1, LegacyDocumentHistoryEntry, Annotation } from './document-model.js';

export interface DocumentHistoryItemValue { readonly item: Annotation; readonly index: number }
export interface DocumentHistoryAuditValue { readonly audit: DocumentDiscardAuditV1; readonly index: number }
export interface CompactDocumentHistoryEntry {
  readonly schemaVersion: 1;
  readonly generation?: number;
  readonly itemChanges: readonly { readonly id: string; readonly before: DocumentHistoryItemValue | null; readonly after: DocumentHistoryItemValue | null }[];
  readonly auditChanges: readonly { readonly identity: string; readonly before: DocumentHistoryAuditValue | null; readonly after: DocumentHistoryAuditValue | null }[];
}
export type DocumentHistoryInput = LegacyDocumentHistoryEntry | CompactDocumentHistoryEntry;
export interface DocumentHistoryContent { readonly items: readonly Annotation[]; readonly discardAudit: readonly DocumentDiscardAuditV1[] }
export interface NormalizedDocumentHistory {
  readonly history: readonly CompactDocumentHistoryEntry[];
  readonly historyCursor: number;
  readonly historyBoundary: number;
}
export const MAX_DOCUMENT_HISTORY_ENTRIES = 200;
export const MAX_DOCUMENT_HISTORY_BYTES = 4 * 1024 * 1024;

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => structurallyEqual(value, b[index]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]));
}

/** Item audit identity is independent of JSON object key order and mutable reason text. */
export function documentHistoryAuditIdentity(audit: DocumentDiscardAuditV1): string {
  return JSON.stringify([audit.target, audit.id, audit.generation, audit.revision, audit.ownerViewId, audit.discardedAt]);
}

function changedEntities<T>(before: readonly T[], after: readonly T[], identity: (value: T) => string) {
  const left = new Map(before.map((value, index) => [identity(value), { value, index }]));
  const right = new Map(after.map((value, index) => [identity(value), { value, index }]));
  const commonBefore = before.map(identity).filter(id => right.has(id));
  const commonAfter = after.map(identity).filter(id => left.has(id));
  const relativePositions = new Map(commonAfter.map((id, index) => [id, index]));
  const reordered = new Set(commonBefore.filter((id, index) => relativePositions.get(id) !== index));
  return [...new Set([...left.keys(), ...right.keys()])].flatMap(id => {
    const previous = left.get(id), next = right.get(id);
    return previous && next && !reordered.has(id) && structurallyEqual(previous.value, next.value)
      ? [] : [{ id, before: previous ?? null, after: next ?? null }];
  });
}

export function createDocumentHistoryEntry(before: DocumentHistoryContent, after: DocumentHistoryContent, generation?: number): CompactDocumentHistoryEntry | null {
  const itemChanges = changedEntities(before.items, after.items, item => item.id).map(change => ({
    id: change.id,
    before: change.before && { item: change.before.value, index: change.before.index },
    after: change.after && { item: change.after.value, index: change.after.index },
  }));
  const auditChanges = changedEntities(before.discardAudit.filter(audit => audit.target === 'item'), after.discardAudit.filter(audit => audit.target === 'item'), documentHistoryAuditIdentity).map(change => ({
    identity: change.id,
    before: change.before && { audit: change.before.value, index: before.discardAudit.indexOf(change.before.value) },
    after: change.after && { audit: change.after.value, index: after.discardAudit.indexOf(change.after.value) },
  }));
  return itemChanges.length || auditChanges.length
    ? { schemaVersion: 1, ...(generation === undefined ? {} : { generation }), itemChanges, auditChanges } : null;
}

export function replayDocumentHistoryEntry<T extends DocumentHistoryContent>(current: T, entry: CompactDocumentHistoryEntry, direction: 'undo' | 'redo'): T {
  const side = direction === 'undo' ? 'before' : 'after';
  const changedItems = new Set(entry.itemChanges.map(change => change.id));
  const items = current.items.filter(item => !changedItems.has(item.id));
  for (const value of entry.itemChanges.flatMap(change => change[side] ? [change[side]!] : []).sort((a, b) => a.index - b.index)) {
    items.splice(Math.min(value.index, items.length), 0, value.item);
  }
  const changedAudit = new Set(entry.auditChanges.map(change => change.identity));
  const discardAudit = current.discardAudit.filter(audit => !changedAudit.has(documentHistoryAuditIdentity(audit)));
  for (const value of entry.auditChanges.flatMap(change => change[side] ? [change[side]!] : []).sort((a, b) => a.index - b.index)) {
    discardAudit.splice(Math.min(value.index, discardAudit.length), 0, value.audit);
  }
  return { ...current, items, discardAudit };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function malformed(): never { throw new Error('Malformed compact document history'); }
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return Array.isArray(value) ? value.every(jsonValue) : object(value) && Object.values(value).every(jsonValue);
}

/** Validate the storage envelope before replay; item semantics remain validated at recovery/command boundaries. */
export function assertCompactDocumentHistoryEntry(value: unknown): asserts value is CompactDocumentHistoryEntry {
  if (!object(value) || value.schemaVersion !== 1 || (value.generation !== undefined && !index(value.generation)) || !Array.isArray(value.itemChanges) || !Array.isArray(value.auditChanges)) malformed();
  if (Object.keys(value).some(key => !['schemaVersion', 'generation', 'itemChanges', 'auditChanges'].includes(key))) malformed();
  const itemIds = new Set<string>(), auditIds = new Set<string>();
  for (const change of value.itemChanges) {
    if (!object(change) || typeof change.id !== 'string' || itemIds.has(change.id) || (change.before === null && change.after === null)) malformed();
    itemIds.add(change.id);
    for (const side of [change.before, change.after]) {
      if (side === null) continue;
      if (!object(side) || !index(side.index) || !object(side.item)) malformed();
      const item = side.item;
      if (item.id !== change.id || !['replace', 'delete', 'insert', 'highlight', 'pageNote', 'pdfAnnotation'].includes(item.kind as string) || !index(item.pageIndex) || typeof item.createdAt !== 'string' || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt)) || !object(item.payload) || !jsonValue(item)) malformed();
    }
  }
  for (const change of value.auditChanges) {
    if (!object(change) || typeof change.identity !== 'string' || auditIds.has(change.identity) || (change.before === null && change.after === null)) malformed();
    auditIds.add(change.identity);
    for (const side of [change.before, change.after]) {
      if (side === null) continue;
      if (!object(side) || !index(side.index) || !object(side.audit)) malformed();
      const audit = side.audit;
      if (audit.target !== 'item' || typeof audit.id !== 'string' || !index(audit.generation) || !index(audit.revision) || typeof audit.ownerViewId !== 'string' || typeof audit.reason !== 'string' || typeof audit.discardedAt !== 'string' || !Number.isFinite(Date.parse(audit.discardedAt)) || documentHistoryAuditIdentity(audit as unknown as DocumentDiscardAuditV1) !== change.identity) malformed();
    }
  }
}

function assertCursors(length: number, cursor: number, boundary: number): void {
  if (!index(cursor) || cursor > length || !index(boundary) || boundary > cursor) malformed();
}

export function normalizeDocumentHistory(history: readonly DocumentHistoryInput[], historyCursor: number, historyBoundary: number): NormalizedDocumentHistory {
  assertCursors(history.length, historyCursor, historyBoundary);
  const compact: CompactDocumentHistoryEntry[] = [];
  let cursor = 0, boundary = 0;
  history.forEach((entry, position) => {
    let converted: CompactDocumentHistoryEntry | null;
    if ('schemaVersion' in entry) {
      assertCompactDocumentHistoryEntry(entry);
      converted = entry.itemChanges.length || entry.auditChanges.length ? entry : null;
    } else {
      converted = createDocumentHistoryEntry({ items: entry.beforeItems, discardAudit: entry.beforeDiscardAudit ?? [] }, { items: entry.afterItems, discardAudit: entry.afterDiscardAudit ?? [] }, entry.generation);
    }
    if (converted) {
      compact.push(converted);
      if (position < historyCursor) cursor++;
      if (position < historyBoundary) boundary++;
    }
  });
  return boundDocumentHistory(compact.slice(boundary), cursor - boundary, 0);
}

export function serializedDocumentHistoryBytes(history: readonly unknown[]): number {
  return new TextEncoder().encode(JSON.stringify(history)).byteLength;
}

export function boundDocumentHistory(history: readonly CompactDocumentHistoryEntry[], historyCursor: number, historyBoundary: number): NormalizedDocumentHistory {
  assertCursors(history.length, historyCursor, historyBoundary);
  const sizes = history.map(entry => new TextEncoder().encode(JSON.stringify(entry)).byteLength);
  let start = 0, end = history.length, cursor = historyCursor, boundary = historyBoundary;
  let bytes = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, history.length - 1);
  while (end > start && (end - start > MAX_DOCUMENT_HISTORY_ENTRIES || bytes > MAX_DOCUMENT_HISTORY_BYTES)) {
    if (cursor > 0) {
      bytes -= sizes[start++]! + (end - start > 0 ? 1 : 0);
      cursor--;
      boundary = Math.max(0, boundary - 1);
    } else {
      bytes -= sizes[--end]! + (end - start > 0 ? 1 : 0);
    }
  }
  return { history: history.slice(start, end), historyCursor: cursor, historyBoundary: boundary };
}

export function appendDocumentHistory(history: readonly CompactDocumentHistoryEntry[], historyCursor: number, historyBoundary: number, entry: CompactDocumentHistoryEntry | null): NormalizedDocumentHistory {
  assertCursors(history.length, historyCursor, historyBoundary);
  if (entry === null) return boundDocumentHistory(history, historyCursor, historyBoundary);
  const appended = [...history.slice(0, historyCursor), entry];
  return boundDocumentHistory(appended, appended.length, historyBoundary);
}
