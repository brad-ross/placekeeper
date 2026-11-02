import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Native paths stay in main; pending opens also participate in duplicate routing. */
export class DocumentWindowRegistry<T> {
    private readonly documents = new Map<string, Promise<T>>();
    async open(sourcePath: string, create: (path: string) => Promise<T>, focus: (window: T) => void): Promise<T> {
        const path = await realpath(resolve(sourcePath));
        const existing = this.documents.get(path);
        if (existing) { const window = await existing; focus(window); return window; }
        const pending = create(path);
        this.documents.set(path, pending);
        try { return await pending; }
        catch (error) { if (this.documents.get(path) === pending) this.documents.delete(path); throw error; }
    }
    remove(window: T): void {
        for (const [path, pending] of this.documents) void pending.then(value => {
            if (value === window && this.documents.get(path) === pending) this.documents.delete(path);
        }, () => undefined);
    }
}
