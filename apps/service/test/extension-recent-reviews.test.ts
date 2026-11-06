import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ExtensionRecentReviews } from '../src/codex/extension-recent-reviews.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'recent-reviews-')); roots.push(root);
  let now = Date.parse('2026-11-05T00:00:00Z');
  return { root, store: new ExtensionRecentReviews(root, () => now), advance: () => { now += 1000; } };
}
const local = (sessionId: string) => ({ sessionId, title: 'Paper', source: { kind: 'local' as const, path: '/papers/paper.pdf' } });

it('retains stable review identity and reading position across restart and subsequent opens', async () => {
  const f = await fixture();
  expect(await f.store.list()).toEqual([]);
  const first = await f.store.remember(local('session-one'));
  expect(first.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  f.advance(); await f.store.position('session-one', 9);
  f.advance(); const reopened = await f.store.remember({ ...local('session-one'), title: 'Renamed paper' });
  expect(reopened).toMatchObject({ id: first.id, page: 9, title: 'Renamed paper', updatedAt: '2026-11-05T00:00:02.000Z' });
  const restarted = new ExtensionRecentReviews(f.root);
  expect(await restarted.get(first.id)).toEqual(reopened);
  expect(await restarted.get('/papers/paper.pdf')).toBeUndefined();
  expect(await restarted.list()).toEqual([reopened]);
  if (process.platform !== 'win32') expect((await stat(join(f.root, 'extension-recent-reviews.json'))).mode & 0o777).toBe(0o600);
});

it('keeps independent reviews distinct and persists host file identity without runtime authority', async () => {
  const f = await fixture();
  const one = await f.store.remember(local('session-one'));
  f.advance(); const two = await f.store.remember({ sessionId: 'session-two', title: 'Paper', source: { kind: 'host', file: { name: 'paper.pdf', resourceUri: 'host-file:///paper' } } });
  expect(two.id).not.toBe(one.id);
  expect(await new ExtensionRecentReviews(f.root).list()).toEqual([two, one]);
  const raw = JSON.parse(await readFile(join(f.root, 'extension-recent-reviews.json'), 'utf8'));
  expect(Object.keys(raw.entries[0]).sort()).toEqual(['id', 'sessionId', 'source', 'title', 'updatedAt']);
  two.source = { kind: 'local', path: '/not-the-stored-path.pdf' };
  expect((await f.store.get(two.id))?.source).toEqual({ kind: 'host', file: { name: 'paper.pdf', resourceUri: 'host-file:///paper' } });
});

it('ignores unchanged positions and serializes concurrent updates without losing entries', async () => {
  const f = await fixture();
  await Promise.all([f.store.remember(local('session-one')), f.store.remember(local('session-two'))]);
  await f.store.position('session-one', 3);
  const before = await readFile(join(f.root, 'extension-recent-reviews.json'), 'utf8');
  f.advance(); await f.store.position('session-one', 3); await f.store.position('unknown-session', 2);
  expect(await readFile(join(f.root, 'extension-recent-reviews.json'), 'utf8')).toBe(before);
  expect(await f.store.list()).toHaveLength(2);
  await expect(f.store.position('session-one', 0)).rejects.toThrow();
  await expect(f.store.position('session-one', 1_000_001)).rejects.toThrow();
  await expect(f.store.position('session-one', 1.5)).rejects.toThrow();
});

it('keeps the fifty most recently used reviews', async () => {
  const f = await fixture();
  const first = await f.store.remember(local('session-first'));
  for (let i = 0; i < 50; i++) { f.advance(); await f.store.remember(local(`session-${i}`)); }
  const list = await f.store.list();
  expect(list).toHaveLength(50);
  expect(list[0]?.sessionId).toBe('session-49');
  expect(await f.store.get(first.id)).toBeUndefined();
});

it('rejects malformed stored entries and extra authority fields rather than using their paths', async () => {
  const f = await fixture();
  await expect(f.store.remember({ ...local('session-one'), source: { kind: 'host', file: { name: 'paper.pdf', resourceUri: '' } } })).rejects.toThrow();
  await f.store.remember(local('session-one'));
  const path = join(f.root, 'extension-recent-reviews.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  stored.entries[0].grant = 'unexpected-runtime-authority';
  await writeFile(path, JSON.stringify(stored));
  await expect(new ExtensionRecentReviews(f.root).list()).rejects.toThrow('Invalid recent review store');
});
