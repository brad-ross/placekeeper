import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountSnapshotContextPicker } from '../src/snapshot-context-picker.js';
import type { ExtensionRequest, ExtensionResult } from '../../../packages/core/src/extension-protocol.js';
class Element {
    children: Element[] = [];
    textContent = '';
    value = '';
    disabled = false;
    open = false;
    onclick?: () => void;
    onsubmit?: (event: { preventDefault(): void }) => void;
    ontoggle?: () => void;
    constructor(readonly tag: string) {}
    append(...children: Element[]) { this.children.push(...children); }
    replaceChildren(...children: Element[]) { this.children = children; }
    setAttribute() {}
    remove() {}
    all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
}
const uri = `placekeeper-mention://${'a'.repeat(32)}`;
const item = { type: 'resource' as const, resourceUri: uri, title: '<b>Study.pdf</b>', subtitle: 'Snapshot · generation 2 · revision 4' };
const snapshot = JSON.stringify({ title: 'Study.pdf', capturedAt: '2026-11-05T12:00:00Z', generation: 2, revision: 4, summary: 'Captured text' });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
function fixture(request: (request: ExtensionRequest) => Promise<ExtensionResult>) {
    const root = new Element('div'), include = vi.fn();
    const dispose = mountSnapshotContextPicker(root as unknown as HTMLElement, { request, include });
    const find = (label: string) => root.all().find(node => node.textContent === label)!;
    const open = () => { const details = root.all().find(node => node.tag === 'details')!; details.open = true; details.ontoggle?.(); };
    return { root, include, dispose, find, open };
}
beforeEach(() => vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) }));
afterEach(() => vi.unstubAllGlobals());
it('searches only on demand and includes a current explicitly selected snapshot', async () => {
    const request = vi.fn(async (input: ExtensionRequest): Promise<ExtensionResult> => input.action === 'mention-search' ? { status: 'mention-results', items: [item] } : { status: 'mention-resource', text: snapshot });
    const f = fixture(request);
    expect(request).not.toHaveBeenCalled();
    f.open(); await settle();
    expect(f.find(item.title)).toBeDefined();
    expect(f.find(item.subtitle)).toBeDefined();
    expect(f.include).not.toHaveBeenCalled();
    f.find('Include snapshot').onclick?.(); await settle();
    expect(request).toHaveBeenLastCalledWith({ action: 'mention-read', uri });
    expect(f.include).toHaveBeenCalledWith({ kind: 'snapshot', id: uri, title: item.title, text: snapshot });
    expect(f.root.all().some(node => node.textContent.includes('Snapshot selected'))).toBe(true);
});
it('does not include a snapshot removed after search', async () => {
    const f = fixture(async input => input.action === 'mention-search' ? { status: 'mention-results', items: [item] } : { status: 'unavailable' });
    f.open(); await settle(); f.find('Include snapshot').onclick?.(); await settle();
    expect(f.include).not.toHaveBeenCalled();
    expect(f.root.all().some(node => node.textContent.includes('no longer available'))).toBe(true);
});
it('explains empty membership without enabling sharing', async () => {
    const request = vi.fn(async (): Promise<ExtensionResult> => ({ status: 'mention-results', items: [] }));
    const f = fixture(request); f.open(); await settle();
    expect(f.root.all().some(node => node.textContent.includes('Only explicitly included snapshots'))).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(f.include).not.toHaveBeenCalled();
});
it('ignores an older search reply and a read completed after disposal', async () => {
    const old = deferred<ExtensionResult>(), read = deferred<ExtensionResult>(); let searches = 0;
    const f = fixture(async input => input.action === 'mention-search' ? ++searches === 1 ? old.promise : { status: 'mention-results', items: [item] } : read.promise);
    f.open();
    const form = f.root.all().find(node => node.tag === 'form')!;
    form.onsubmit?.({ preventDefault() {} }); await settle();
    old.resolve({ status: 'mention-results', items: [] }); await settle();
    expect(f.find('Include snapshot')).toBeDefined();
    f.find('Include snapshot').onclick?.(); f.dispose();
    read.resolve({ status: 'mention-resource', text: snapshot }); await settle();
    expect(f.include).not.toHaveBeenCalled();
});
it('invalidates a pending include when the user changes the search', async () => {
    const read = deferred<ExtensionResult>();
    const f = fixture(async input => input.action === 'mention-search' ? { status: 'mention-results', items: [item] } : read.promise);
    f.open(); await settle(); f.find('Include snapshot').onclick?.();
    f.root.all().find(node => node.tag === 'form')!.onsubmit?.({ preventDefault() {} });
    read.resolve({ status: 'mention-resource', text: snapshot }); await settle();
    expect(f.include).not.toHaveBeenCalled();
});

it('lets a newer snapshot selection supersede an unfinished read', async () => {
    const read = deferred<ExtensionResult>();
    const second = { ...item, resourceUri: `placekeeper-mention://${'b'.repeat(32)}`, title: 'Second.pdf' };
    const f = fixture(async input => input.action === 'mention-search' ? { status: 'mention-results', items: [item, second] } : input.action === 'mention-read' && input.uri === uri ? read.promise : { status: 'mention-resource', text: 'second captured text' });
    f.open(); await settle();
    const buttons = f.root.all().filter(node => node.textContent === 'Include snapshot');
    buttons[0]!.onclick?.(); buttons[1]!.onclick?.(); await settle();
    read.resolve({ status: 'mention-resource', text: snapshot }); await settle();
    expect(f.include).toHaveBeenCalledTimes(1);
    expect(f.include).toHaveBeenCalledWith({ kind: 'snapshot', id: second.resourceUri, title: second.title, text: 'second captured text' });
    expect(buttons[0]!.disabled).toBe(false);
});
