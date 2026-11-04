/** Window ownership starts before admission and ends only after detach acknowledgement.
 * `activeWindows` is the native registration count, including opening windows;
 * bootstrapping is a subset, not a separate kind of ownership.
 */
export class WindowActivityRegistry {
    private readonly windows = new Map<string, 'opening' | 'active' | 'detaching'>();
    register(helperId: string): void { this.windows.set(helperId, 'opening'); }
    activated(helperId: string): void { if (this.windows.get(helperId) === 'opening') this.windows.set(helperId, 'active'); }
    retiring(helperId: string): void { if (this.windows.has(helperId)) this.windows.set(helperId, 'detaching'); }
    detached(helperId: string): void { this.windows.delete(helperId); }
    snapshot(): { activeWindows: number; bootstrappingWindows: number } {
        return { activeWindows: this.windows.size, bootstrappingWindows: [...this.windows.values()].filter(state => state === 'opening').length };
    }
}

/** Lifecycle pipe responses are ordered; helper admission uses a separate socket.
 * Wait for this pipe's window registration before admitting on that socket.
 */
export class ActivityAcknowledgements {
    private readonly pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    private failure?: Error;
    enqueue(write: () => void): Promise<void> {
        if (this.failure) return Promise.reject(this.failure);
        return new Promise<void>((resolve, reject) => {
            this.pending.push({ resolve, reject });
            try { write(); } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
        });
    }
    acknowledge(): void { this.pending.shift()?.resolve(); }
    fail(error: Error): void { this.failure = error; for (const pending of this.pending.splice(0)) pending.reject(error); }
}
