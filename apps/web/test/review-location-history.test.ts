import { describe, expect, it, vi } from 'vitest';

import type { PlacekeeperLinkLocation } from '../../../packages/core/src/placekeeper-link.js';
import {
  BrowserReviewLocationHistory,
  type ReviewLocationHistoryEnvironment,
} from '../src/review/review-location-history.js';

class FakeEnvironment implements ReviewLocationHistoryEnvironment {
  readonly location = { hash: '#v=1&page=3' };
  readonly listeners = new Set<() => void>();
  readonly entries: Array<{ state: unknown; fragment: string }> = [
    { state: null, fragment: 'v=1&page=3' },
  ];
  cursor = 0;
  readonly history = {
    get state() { return undefined as unknown; },
    get length() { return 0; },
    replaceState: (_state: unknown, _unused: string, _url?: string | URL | null): void => undefined,
    pushState: (_state: unknown, _unused: string, _url?: string | URL | null): void => undefined,
    back: (): void => undefined,
    forward: (): void => undefined,
  };

  constructor() {
    Object.defineProperties(this.history, {
      state: { get: () => this.entries[this.cursor]?.state ?? null },
      length: { get: () => this.entries.length },
    });
    this.history.replaceState = (state, _unused, url) => {
      const fragment = String(url ?? '').replace(/^#/u, '');
      this.entries[this.cursor] = { state, fragment };
      this.location.hash = fragment ? `#${fragment}` : '';
    };
    this.history.pushState = (state, _unused, url) => {
      const fragment = String(url ?? '').replace(/^#/u, '');
      this.entries.splice(this.cursor + 1, Infinity, { state, fragment });
      this.cursor += 1;
      this.location.hash = `#${fragment}`;
    };
    this.history.back = () => this.move(-1);
    this.history.forward = () => this.move(1);
  }

  addEventListener(_type: 'popstate', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'popstate', listener: () => void): void {
    this.listeners.delete(listener);
  }

  private move(offset: number): void {
    const next = this.cursor + offset;
    if (next < 0 || next >= this.entries.length) return;
    this.cursor = next;
    this.location.hash = `#${this.entries[next]!.fragment}`;
    for (const listener of this.listeners) listener();
  }
}

const page = (value: number): PlacekeeperLinkLocation => ({ kind: 'page', page: value });
const destination = (value: number): PlacekeeperLinkLocation => ({
  kind: 'destination',
  page: value,
  mode: 'fit-horizontal',
  params: [640],
});

describe('browser review location history', () => {
  it('replaces settled reading, pushes explicit jumps once, and restores through popstate', () => {
    const environment = new FakeEnvironment();
    const restore = vi.fn();
    const history = new BrowserReviewLocationHistory(environment);
    history.start(restore);

    expect(history.read()).toEqual(page(3));
    expect(history.snapshot()).toEqual({ canBack: false, canForward: false });
    expect(environment.entries).toHaveLength(1);

    history.replace(page(4));
    expect(environment.entries).toHaveLength(1);
    expect(environment.location.hash).toBe('#v=1&page=4');

    history.push(page(9));
    expect(environment.entries).toHaveLength(2);
    expect(history.snapshot()).toEqual({ canBack: true, canForward: false });

    expect(history.back()).toBe(true);
    expect(restore).toHaveBeenCalledOnce();
    expect(history.read()).toEqual(page(4));
    expect(history.snapshot()).toEqual({ canBack: false, canForward: true });
    expect(environment.entries).toHaveLength(2);

    expect(history.forward()).toBe(true);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(history.read()).toEqual(page(9));
    expect(environment.entries).toHaveLength(2);
  });

  it('recovers forward availability when a middle entry is reloaded', () => {
    const environment = new FakeEnvironment();
    const first = new BrowserReviewLocationHistory(environment);
    first.start(() => undefined);
    first.push(page(4));
    first.push(page(8));
    first.back();
    first.dispose();

    const reloaded = new BrowserReviewLocationHistory(environment);
    reloaded.start(() => undefined);
    expect(reloaded.snapshot()).toEqual({ canBack: true, canForward: true });
    expect(reloaded.read()).toEqual(page(4));
  });

  it('round-trips durable destinations through replace, push, Back, and Forward', () => {
    const environment = new FakeEnvironment();
    const restore = vi.fn();
    const history = new BrowserReviewLocationHistory(environment);
    history.start(restore);

    history.replace(destination(3));
    expect(history.read()).toEqual(destination(3));
    expect(environment.location.hash).toBe('#v=2&page=3&mode=fit-horizontal&params=640');

    history.push(destination(7));
    expect(history.read()).toEqual(destination(7));
    expect(history.back()).toBe(true);
    expect(history.read()).toEqual(destination(3));
    expect(history.forward()).toBe(true);
    expect(history.read()).toEqual(destination(7));
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('converges malformed fragments through a safe replacement without growing history', () => {
    const environment = new FakeEnvironment();
    environment.location.hash = '#unsafe';
    environment.entries[0] = { state: null, fragment: 'unsafe' };
    const history = new BrowserReviewLocationHistory(environment);
    history.start(() => undefined);

    expect(() => history.read()).toThrow();
    history.replace(page(1));
    expect(environment.entries).toHaveLength(1);
    expect(environment.location.hash).toBe('#v=1&page=1');
  });
});
