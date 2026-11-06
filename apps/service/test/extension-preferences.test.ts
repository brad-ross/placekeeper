import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ExtensionPreferences } from '../src/codex/extension-preferences.js';
it('persists defaults and serializes disabling against reads and capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preferences-'));
    try {
        const store = new ExtensionPreferences(root);
        expect(await store.values()).toEqual({ backgroundContext: true, selectionSharing: true, mentions: false });
        await store.update({ mentions: true, backgroundContext: false });
        await store.capture('private-source', () => ({ title: 'Paper', generation: 2, revision: 3, sourceDigest: 'a'.repeat(64), summary: 'Document snapshot', annotations: [{ page: 1, text: 'Evidence' }] }));
        const items = await store.search('Evidence');
        expect(items).toHaveLength(1);
        expect(items[0]!.subtitle).toContain('Captured ');
        const uri = items[0]!.resourceUri;
        await store.update({ selectionSharing: false, backgroundContext: true });
        expect(await store.read(uri)).toContain('Evidence');
        expect(await store.read(uri)).toContain('"generation":2');
        const restarted = new ExtensionPreferences(root);
        expect(await restarted.values()).toMatchObject({ mentions: true, backgroundContext: true, selectionSharing: false });
        expect(await restarted.read(uri)).toContain('Evidence');
        const disabling = restarted.update({ mentions: false });
        const reading = restarted.read(uri);
        await disabling;
        expect(await reading).toBeUndefined();
        await restarted.update({ mentions: true });
        expect(await restarted.read(uri)).toBeUndefined();
        expect(await restarted.search('')).toEqual([]);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
it('orders capture and opt-out and invalidates old snapshot revisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-race-'));
    try {
        const s = new ExtensionPreferences(root);
        await s.update({ mentions: true });
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const input = { title: 'Paper', generation: 1, revision: 1, sourceDigest: 'a'.repeat(64), summary: 'summary', annotations: [] };
        const capture = s.capture('source', async () => { entered(); await waiting; return input; });
        await started;
        const disable = s.update({ mentions: false });
        release();
        await capture;
        await disable;
        expect(await s.search('')).toEqual([]);
        await expect(s.capture('source', () => input)).rejects.toThrow('Mentions disabled');
        await s.update({ mentions: true });
        await s.capture('source', () => input);
        const old = (await s.search(''))[0]!.resourceUri;
        await s.capture('source', () => ({ ...input, revision: 2 }));
        expect(await s.read(old)).toBeUndefined();
        expect(await s.settings()).toMatchObject({ revision: 3 });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});

it('labels bounded excerpts with original totals rather than claiming a complete document',async()=>{
 const root=await mkdtemp(join(tmpdir(),'excerpt-'));
 try {
 const s=new ExtensionPreferences(root);await s.update({mentions:true});
 await s.capture('source',()=>({title:'Paper',generation:4,revision:9,sourceDigest:'a'.repeat(64),summary:'s'.repeat(8100),annotations:Array.from({length:101},()=>({page:1,text:'a'.repeat(2100)}))}));
 const document=(await s.search('Paper'))[0]!;
 const resource=JSON.parse((await s.read(document.resourceUri))!);
 expect(resource).toMatchObject({truncated:true,totals:{summaryCharacters:8100,annotations:101},generation:4,revision:9});
 expect(resource.summary).toHaveLength(8000);expect(resource.annotations).toHaveLength(100);expect(resource.annotations[0].text).toHaveLength(2000);
 }finally{await rm(root,{recursive:true,force:true});}
});
