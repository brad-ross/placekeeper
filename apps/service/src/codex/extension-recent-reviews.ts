import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseHostResourceRequest, type HostResourceFile } from '../../../../packages/core/src/host-resource-protocol.js';
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private-storage.js';
import { publishFile, stagePublication, syncPublishedFile } from '../platform/file-publication.js';

export type RecentReviewSource = { kind: 'local'; path: string } | { kind: 'host'; file: HostResourceFile };
export interface RecentReviewEntry {
  id: string;
  sessionId: string;
  title: string;
  source: RecentReviewSource;
  page?: number;
  updatedAt: string;
}
export type RecentReviewInput = Pick<RecentReviewEntry, 'sessionId' | 'title' | 'source'>;
type State = { schemaVersion: 1; entries: RecentReviewEntry[] };
const maxEntries = 50;
const maxBytes = 8 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(key => allowed.includes(key));
const session = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v);
const page = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 1_000_000;
function source(v: unknown): v is RecentReviewSource {
  if (!object(v)) return false;
  if (v.kind === 'local') return keys(v, ['kind', 'path']) && typeof v.path === 'string' && v.path.length < 32768 && isAbsolute(v.path) && !v.path.includes('\0');
  return v.kind === 'host' && keys(v, ['kind', 'file']) && parseHostResourceRequest({ action: 'host-open', file: v.file }) !== undefined;
}
function entry(v: unknown): v is RecentReviewEntry {
  return object(v) && keys(v, ['id', 'sessionId', 'title', 'source', 'page', 'updatedAt']) &&
    typeof v.id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(v.id) && session(v.sessionId) &&
    typeof v.title === 'string' && v.title.length <= 180 && source(v.source) &&
    (v.page === undefined || page(v.page)) && typeof v.updatedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.updatedAt) && Number.isFinite(Date.parse(v.updatedAt));
}

/** Private reopen hints, not authority: callers must re-admit every selected review. */
export class ExtensionRecentReviews {
  #state: State | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, readonly now: () => number = Date.now) { }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.catch(() => undefined);
    return result;
  }
  async #load(): Promise<State> {
    if (this.#state) return this.#state;
    await ensurePrivateDirectory(this.root);
    try {
      const state: unknown = JSON.parse((await readPrivateFile(join(this.root, 'extension-recent-reviews.json'), maxBytes)).toString());
      if (!object(state) || !keys(state, ['schemaVersion', 'entries']) || state.schemaVersion !== 1 ||
          !Array.isArray(state.entries) || state.entries.length > maxEntries || !state.entries.every(entry) ||
          new Set(state.entries.map(item => item.id)).size !== state.entries.length ||
          new Set(state.entries.map(item => item.sessionId)).size !== state.entries.length) throw Error('Invalid recent review store');
      return this.#state = { schemaVersion: 1, entries: state.entries };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return this.#state = { schemaVersion: 1, entries: [] };
    }
  }
  async #save(entries: RecentReviewEntry[]): Promise<void> {
    const next: State = { schemaVersion: 1, entries };
    const bytes = Buffer.from(JSON.stringify(next));
    if (bytes.byteLength > maxBytes) throw Error('Recent review storage is full');
    const path = join(this.root, 'extension-recent-reviews.json');
    const temporary = await stagePublication(path, bytes);
    try {
      await syncPublishedFile(await publishFile(temporary, path));
      this.#state = next;
    } finally { await rm(temporary, { force: true }); }
  }
  remember(input: RecentReviewInput): Promise<RecentReviewEntry> {
    // Snapshot inputs before queuing so a caller cannot change a pending write.
    const value = structuredClone(input);
    return this.#serial(async () => {
      if (!object(value) || !keys(value, ['sessionId', 'title', 'source']) || !session(value.sessionId) || typeof value.title !== 'string' || !source(value.source)) throw Error('Invalid recent review');
      const state = await this.#load(), previous = state.entries.find(item => item.sessionId === value.sessionId);
      const next: RecentReviewEntry = {
        id: previous?.id ?? randomBytes(24).toString('base64url'), sessionId: value.sessionId,
        title: value.title.replace(/[\u0000-\u001f]/g, ' ').slice(0, 180), source: value.source,
        ...(previous?.page === undefined ? {} : { page: previous.page }), updatedAt: new Date(this.now()).toISOString(),
      };
      await this.#save([next, ...state.entries.filter(item => item.sessionId !== value.sessionId)].slice(0, maxEntries));
      return structuredClone(next);
    });
  }
  position(sessionId: string, nextPage: number): Promise<void> {
    return this.#serial(async () => {
      if (!session(sessionId) || !page(nextPage)) throw Error('Invalid recent review position');
      const state = await this.#load(), previous = state.entries.find(item => item.sessionId === sessionId);
      if (!previous || previous.page === nextPage) return;
      const next = { ...previous, page: nextPage, updatedAt: new Date(this.now()).toISOString() };
      await this.#save([next, ...state.entries.filter(item => item.sessionId !== sessionId)]);
    });
  }
  list(): Promise<RecentReviewEntry[]> { return this.#serial(async () => structuredClone((await this.#load()).entries)); }
  get(id: string): Promise<RecentReviewEntry | undefined> {
    return this.#serial(async () => structuredClone((await this.#load()).entries.find(item => item.id === id)));
  }
}
