import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ensurePrivateDirectory, readPrivateFile } from '../platform/private-storage.js';
import { stagePublication, publishFile, syncPublishedFile } from '../platform/file-publication.js';
import { extensionPreferenceDefaults, parsePreferenceSet, type ExtensionPreferenceValues, type MentionItem, type SnapshotLabel } from '../../../../packages/core/src/extension-preferences.js';
export interface SnapshotInput {
    title: string;
    generation: number;
    revision: number;
    sourceDigest: string;
    summary: string;
    annotations: {
        page: number;
        text: string;
    }[];
}
type Snapshot = SnapshotInput & SnapshotLabel & {
    id: string;
    sourceKey: string;
    totals: {summaryCharacters:number;annotations:number;annotationTextCharacters:number[]};
    truncated:boolean;
};
type State = {
    schemaVersion: 1;
    revision: number;
    values: ExtensionPreferenceValues;
    snapshots: Snapshot[];
};
const bounded = (v: string, n: number) => v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n);
const key = (source: string) => createHash('sha256').update(source).digest('hex');
const uri = (s: Snapshot, index?: number) => `placekeeper-mention://${s.id}${index === undefined ? '' : `/${index}`}`;
/** One serialized authority owns settings, membership, capture and every resource read. */
export class ExtensionPreferences {
    #state: State | undefined;
    #tail: Promise<unknown> = Promise.resolve();
    constructor(readonly root: string) { }
    #serial<T>(fn: () => Promise<T>): Promise<T> { const result = this.#tail.then(fn, fn); this.#tail = result.catch(() => undefined); return result; }
    async #load(): Promise<State> {
        if (this.#state)
            return this.#state;
        await ensurePrivateDirectory(this.root);
        try {
            const state = JSON.parse((await readPrivateFile(join(this.root, 'extension-preferences.json'), 16 * 1024 * 1024)).toString()) as State;
            const values = parsePreferenceSet(state.values);
            if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || !values || Object.keys(values).length !== 3 || !Array.isArray(state.snapshots) || !state.snapshots.every(s => typeof s.id === 'string' && /^[a-zA-Z0-9_-]{32}$/.test(s.id) && typeof s.sourceKey === 'string' && typeof s.title === 'string' && typeof s.summary === 'string' && Array.isArray(s.annotations) && s.annotations.every(a => Number.isSafeInteger(a.page) && typeof a.text === 'string') && Number.isSafeInteger(s.generation) && Number.isSafeInteger(s.revision) && typeof s.sourceDigest === 'string' && typeof s.capturedAt === 'string'))
                throw Error('Invalid preference store');
            return this.#state = state;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            return this.#state = { schemaVersion: 1, revision: 0, values: { ...extensionPreferenceDefaults }, snapshots: [] };
        }
    }
    async #save(next: State) { const bytes = Buffer.from(JSON.stringify(next));
        if (bytes.byteLength > 16 * 1024 * 1024) throw Error('Mention snapshot storage is full');
        const temp = await stagePublication(join(this.root, 'extension-preferences.json'), bytes); try {
        await syncPublishedFile(await publishFile(temp, join(this.root, 'extension-preferences.json')));
        this.#state = next;
    }
    finally {
        await rm(temp, { force: true });
    } }
    settings() { return this.#serial(async () => { const s = await this.#load(); return { values: { ...s.values }, revision: s.revision }; }); }
    values() { return this.#serial(async () => ({ ...((await this.#load()).values) })); }
    update(set: Partial<ExtensionPreferenceValues>) { return this.#serial(async () => { if (!parsePreferenceSet(set))
        throw Error('Invalid preferences'); const state = await this.#load(), values = { ...state.values, ...set }; await this.#save({ ...state, revision: state.revision + 1, values, snapshots: values.mentions ? state.snapshots : [] }); return { ...values }; }); }
    status(source: string) { return this.#serial(async () => { const state = await this.#load(), s = state.values.mentions ? state.snapshots.find(s => s.sourceKey === key(source)) : undefined; return { included: !!s, ...(s ? { snapshot: { generation: s.generation, revision: s.revision, capturedAt: s.capturedAt } } : {}) }; }); }
    capture(source: string, capture: () => SnapshotInput | Promise<SnapshotInput>) {
        return this.#serial(async () => {
            const state = await this.#load();
            if (!state.values.mentions)
                throw Error('Mentions disabled');
            const input = await capture();
            // Only explicitly selected document text fields enter the cross-chat snapshot.
            const snapshot: Snapshot = { totals:{summaryCharacters:input.summary.length,annotations:input.annotations.length,annotationTextCharacters:input.annotations.slice(0,100).map(a=>a.text.length)}, truncated:input.summary.length>8000||input.annotations.length>100||input.annotations.some(a=>a.text.length>2000), id: randomBytes(24).toString('base64url'), sourceKey: key(source), title: bounded(input.title, 180), generation: input.generation, revision: input.revision, sourceDigest: input.sourceDigest, capturedAt: new Date().toISOString(), summary: bounded(input.summary, 8000), annotations: input.annotations.slice(0, 100).map(a => ({ page: a.page, text: bounded(a.text, 2000) })) };
            await this.#save({ ...state, snapshots: [...state.snapshots.filter(s => s.sourceKey !== snapshot.sourceKey), snapshot] });
            return { included: true, snapshot: { generation: snapshot.generation, revision: snapshot.revision, capturedAt: snapshot.capturedAt } };
        });
    }
    remove(source: string) { return this.#serial(async () => { const state = await this.#load(); await this.#save({ ...state, snapshots: state.snapshots.filter(s => s.sourceKey !== key(source)) }); return { included: false }; }); }
    search(query: string): Promise<MentionItem[]> {
        return this.#serial(async () => {
            const state = await this.#load();
            if (!state.values.mentions)
                return [];
            const q = query.toLocaleLowerCase();
            return state.snapshots.flatMap(s => {
                const subtitle = `Captured ${s.capturedAt} · generation ${s.generation} · revision ${s.revision}`;
                const items: MentionItem[] = [];
                if (`${s.title} ${s.summary}`.toLocaleLowerCase().includes(q))
                    items.push({ type: 'resource', resourceUri: uri(s), title: s.title, subtitle });
                s.annotations.forEach((a, i) => { if (`${s.title} ${a.text}`.toLocaleLowerCase().includes(q))
                    items.push({ type: 'resource', resourceUri: uri(s, i), title: `${s.title} · page ${a.page}`, subtitle }); });
                return items;
            }).slice(0, 50);
        });
    }
    read(resourceUri: string) { return this.#serial(async () => { const state = await this.#load(); if (!state.values.mentions)
        return; for (const s of state.snapshots) {
        const index = s.annotations.findIndex((_, i) => uri(s, i) === resourceUri);
        if (resourceUri !== uri(s) && index < 0)
            continue;
        return JSON.stringify({ kind: 'untrusted-document-snapshot', title: s.title, generation: s.generation, revision: s.revision, capturedAt: s.capturedAt, sourceDigest: s.sourceDigest, truncated:s.truncated, totals:s.totals, limits:{summaryCharacters:8000,annotations:100,annotationTextCharacters:2000}, ...(index < 0 ? { summary: s.summary, annotations: s.annotations } : { annotation: s.annotations[index] }) });
    } return; }); }
}
