import type { UpgradeReviewStatus, UpgradeReviewSettlement } from '../../../../packages/core/src/upgrade-review-protocol.js';

/** One serial poll owns each mounted view. Stale completions cannot close a successor. */
export class ReviewUpgradePreparation {
  #attempt: string | undefined;
  #protectedAttempt: string | undefined;
  #stopped = false;
  #running = false;
  constructor(readonly port: {
    poll(): Promise<UpgradeReviewStatus>;
    settle(request: UpgradeReviewSettlement): Promise<UpgradeReviewStatus>;
    protectInput(): Promise<void>;
    frozen(value: boolean, reason?: string): void;
    /** False leaves host-owned native closure pending, so cancellation remains observable. */
    close(): Promise<void | false>;
  }) {}
  async tick(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      let status = await this.port.poll();
      if (this.#stopped) return;
      if (status.phase === 'preparing' && (status.attemptId !== this.#attempt || status.settlementRequired === true)) {
        this.#attempt = status.attemptId;
        this.port.frozen(true, 'Preparing this review for the upgrade. Your pending input is being protected.');
        let error: string | undefined;
        try {
          if (this.#protectedAttempt !== this.#attempt) {
            await this.port.protectInput();
            this.#protectedAttempt = this.#attempt;
          }
        }
        catch (failure) { error = failure instanceof Error ? failure.message : 'Input could not be protected'; }
        if (this.#stopped) return;
        status = await this.port.settle({ attemptId: this.#attempt!, ...(error === undefined ? {} : { error: error.slice(0, 1024) }) });
      }
      if (this.#stopped) return;
      if (status.phase === 'canceled' || status.phase === 'none' || status.phase === 'preview') {
        this.#attempt = undefined;
        this.#protectedAttempt = undefined;
        this.port.frozen(false, status.phase === 'canceled' ? status.reason ?? 'Upgrade canceled. Your review is still open.' : undefined);
      } else if (status.phase === 'committed' && status.attemptId === this.#attempt) {
        const closed = await this.port.close();
        if (closed !== false) this.#stopped = true;
      }
    } catch (error) {
      if (!this.#stopped && this.#attempt !== undefined) this.port.frozen(true, 'The upgrade connection was interrupted. Keep this review open until preparation is canceled or the connection returns.');
    } finally { this.#running = false; }
  }
  stop(): void { this.#stopped = true; }
}

/** Freeze consumes queued host tokens, so cancellation cannot replay a command. */
export class UpgradeCommandGate {
  readonly #discarded = new Map<'native' | 'host', number>();
  filter(invocation: import('../review/review-command-surface.js').ReviewCommandInvocation | undefined, frozen: boolean, source: 'native' | 'host') {
    if (invocation === undefined) return undefined;
    if (frozen) {
      this.#discarded.set(source, Math.max(this.#discarded.get(source) ?? 0, invocation.token));
      return undefined;
    }
    return invocation.token <= (this.#discarded.get(source) ?? 0) ? undefined : invocation;
  }
}
