import {
  decodePlacekeeperLinkFragment,
  encodePlacekeeperLinkFragment,
  type PlacekeeperLinkLocation,
} from '../../../../packages/core/src/placekeeper-link.js';

export interface ReviewLocationHistorySnapshot {
  readonly canBack: boolean;
  readonly canForward: boolean;
}

export interface ReviewLocationHistoryPort {
  start(onPop: (direction: 'back' | 'forward' | 'unknown') => void): void;
  read(): PlacekeeperLinkLocation;
  replace(location: PlacekeeperLinkLocation): void;
  push(location: PlacekeeperLinkLocation): void;
  back(): boolean;
  forward(): boolean;
  snapshot(): ReviewLocationHistorySnapshot;
  subscribe(listener: (snapshot: ReviewLocationHistorySnapshot) => void): () => void;
  dispose(): void;
}

export interface ReviewLocationHistoryEnvironment {
  readonly location: { hash: string };
  readonly history: Pick<History, 'state' | 'length' | 'replaceState' | 'pushState' | 'back' | 'forward'>;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

interface PlacekeeperHistoryState {
  readonly placekeeperReviewLocation: 1;
  readonly index: number;
  readonly baseline: number;
}

function historyState(value: unknown): PlacekeeperHistoryState | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<PlacekeeperHistoryState>;
  return candidate.placekeeperReviewLocation === 1
    && Number.isSafeInteger(candidate.index)
    && (candidate.index ?? -1) >= 0
    && Number.isSafeInteger(candidate.baseline)
    && (candidate.baseline ?? -1) >= 0
    ? candidate as PlacekeeperHistoryState
    : null;
}

export class BrowserReviewLocationHistory implements ReviewLocationHistoryPort {
  private index = 0;
  private maximumIndex = 0;
  private baseline = 0;
  private onPop: ((direction: 'back' | 'forward' | 'unknown') => void) | null = null;
  private readonly listeners = new Set<(snapshot: ReviewLocationHistorySnapshot) => void>();
  private lastPublishedSnapshot: ReviewLocationHistorySnapshot = {
    canBack: false,
    canForward: false,
  };
  private started = false;

  constructor(private readonly environment: ReviewLocationHistoryEnvironment) {}

  start(onPop: (direction: 'back' | 'forward' | 'unknown') => void): void {
    this.onPop = onPop;
    if (this.started) return;
    this.started = true;
    const existing = historyState(this.environment.history.state);
    if (existing === null) {
      this.index = 0;
      this.baseline = Math.max(0, this.environment.history.length - 1);
      this.maximumIndex = 0;
      this.environment.history.replaceState(this.entryState(), '', this.currentHash());
    } else {
      this.index = existing.index;
      this.baseline = existing.baseline;
      this.maximumIndex = Math.max(
        this.index,
        this.environment.history.length - this.baseline - 1,
      );
    }
    this.environment.addEventListener('popstate', this.handlePop);
    this.publish();
  }

  read(): PlacekeeperLinkLocation {
    return decodePlacekeeperLinkFragment(this.environment.location.hash.replace(/^#/u, ''));
  }

  replace(location: PlacekeeperLinkLocation): void {
    const fragment = encodePlacekeeperLinkFragment(location);
    if (this.currentHash() === `#${fragment}` && historyState(this.environment.history.state) !== null) {
      return;
    }
    this.environment.history.replaceState(this.entryState(), '', `#${fragment}`);
  }

  push(location: PlacekeeperLinkLocation): void {
    this.index += 1;
    this.maximumIndex = this.index;
    this.environment.history.pushState(
      this.entryState(),
      '',
      `#${encodePlacekeeperLinkFragment(location)}`,
    );
    this.publish();
  }

  back(): boolean {
    if (this.index <= 0) return false;
    this.environment.history.back();
    return true;
  }

  forward(): boolean {
    if (this.index >= this.maximumIndex) return false;
    this.environment.history.forward();
    return true;
  }

  snapshot(): ReviewLocationHistorySnapshot {
    return { canBack: this.index > 0, canForward: this.index < this.maximumIndex };
  }

  subscribe(listener: (snapshot: ReviewLocationHistorySnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.started) this.environment.removeEventListener('popstate', this.handlePop);
    this.started = false;
    this.onPop = null;
    this.listeners.clear();
  }

  private readonly handlePop = () => {
    const state = historyState(this.environment.history.state);
    if (state === null || state.baseline !== this.baseline) return;
    const direction = state.index < this.index
      ? 'back'
      : state.index > this.index ? 'forward' : 'unknown';
    this.index = state.index;
    this.maximumIndex = Math.max(
      this.maximumIndex,
      this.environment.history.length - this.baseline - 1,
    );
    this.publish();
    this.onPop?.(direction);
  };

  private entryState(): PlacekeeperHistoryState {
    return { placekeeperReviewLocation: 1, index: this.index, baseline: this.baseline };
  }

  private currentHash(): string {
    return this.environment.location.hash || '';
  }

  private publish(): void {
    const snapshot = this.snapshot();
    if (
      snapshot.canBack === this.lastPublishedSnapshot.canBack &&
      snapshot.canForward === this.lastPublishedSnapshot.canForward
    ) return;
    this.lastPublishedSnapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
