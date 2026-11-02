interface PendingVisibility { readonly token: string; readonly generation?: number; readonly failed: boolean }
/** Correlates a focused target with its own settled navigation and paint. */
export class FocusedVisibilityGate {
    private pending: PendingVisibility | undefined;
    begin(token: string): PendingVisibility | undefined {
        const previous = this.pending;
        this.pending = { token, failed: false };
        return previous;
    }
    current(token: string): boolean { return this.pending?.token === token; }
    admitted(token: string, generation: number): boolean {
        if (!this.current(token)) return false;
        this.pending = { token, generation, failed: false }; return true;
    }
    fail(token: string): void { if (this.pending?.token === token) this.pending = { ...this.pending, failed: true }; }
    restore(token: string, previous: PendingVisibility | undefined): void { if (this.current(token)) this.pending = previous; }
    accepts(token: unknown, generation: number): boolean {
        return this.pending === undefined ? token === undefined
            : !this.pending.failed && this.pending.token === token && this.pending.generation === generation;
    }
    commit(token: unknown, generation: number): boolean {
        if (!this.accepts(token, generation)) return false;
        this.pending = undefined; return true;
    }
}
