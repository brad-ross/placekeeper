/** Window destruction precedes asynchronous helper detach and its final activity
 * acknowledgement. Keep the lifecycle pipe alive until those retirements end. */
export class WindowRetirementBarrier {
    private readonly pending = new Set<Promise<void>>();

    get hasPending(): boolean { return this.pending.size > 0; }

    track(retirement: Promise<void>): Promise<void> {
        const tracked = retirement.finally(() => { this.pending.delete(tracked); });
        this.pending.add(tracked);
        return tracked;
    }

    async wait(): Promise<void> {
        while (this.pending.size > 0) await Promise.all([...this.pending]);
    }
}
