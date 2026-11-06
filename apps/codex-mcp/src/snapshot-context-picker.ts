import type { CodexAppResponse } from '../../../packages/core/src/codex-mcp-protocol.js';
import type { ExtensionRequest, ExtensionResult } from '../../../packages/core/src/extension-protocol.js';

export interface SnapshotContextPickerOptions {
    request(request: ExtensionRequest): Promise<ExtensionResult | CodexAppResponse>;
    include(snapshot: { kind: 'snapshot'; id: string; title: string; text: string }): void | Promise<void>;
}

/** Include only an explicitly chosen, still-authorized captured snapshot. Never sends a message. */
export function mountSnapshotContextPicker(container: HTMLElement, options: SnapshotContextPickerOptions): () => void {
    const details = document.createElement('details'); details.className = 'snapshot-context-picker';
    const summary = document.createElement('summary'); summary.textContent = 'Include review context';
    const description = document.createElement('p');
    description.textContent = 'Choose a captured snapshot to attach to this chat. Only explicitly included snapshots appear. Captured snapshots do not update automatically.';
    const form = document.createElement('form');
    const label = document.createElement('label'); label.textContent = 'Search included snapshots';
    const input = document.createElement('input'); input.type = 'search'; input.maxLength = 4096; label.append(input);
    const searchButton = document.createElement('button'); searchButton.type = 'submit'; searchButton.textContent = 'Search';
    form.append(label, searchButton);
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    const results = document.createElement('div');
    details.append(summary, description, form, status, results); container.append(details);
    let disposed = false, opened = false, searchEpoch = 0, selectionEpoch = 0;
    const search = async () => {
        const epoch = ++searchEpoch;
        selectionEpoch++;
        results.replaceChildren(); status.textContent = 'Searching snapshots…';
        try {
            const response = await options.request({ action: 'mention-search', query: input.value.slice(0, 4096) });
            if (disposed || epoch !== searchEpoch) return;
            if (response.status !== 'mention-results') throw Error('Search unavailable');
            status.textContent = response.items.length ? 'Choose a snapshot to include.' : 'No matching snapshots. Only explicitly included snapshots appear; include a review snapshot in its Sharing settings first.';
            for (const item of response.items) {
                const row = document.createElement('div');
                const title = document.createElement('p'); title.textContent = item.title;
                const subtitle = document.createElement('p'); subtitle.textContent = item.subtitle;
                const include = document.createElement('button'); include.type = 'button'; include.textContent = 'Include snapshot';
                include.onclick = () => {
                    if (disposed || epoch !== searchEpoch || include.disabled) return;
                    const selection = ++selectionEpoch;
                    const current = () => !disposed && epoch === searchEpoch && selection === selectionEpoch;
                    include.disabled = true;
                    status.textContent = 'Checking snapshot availability…';
                    void (async () => {
                        // Search results confer no authority: read checks membership again at selection time.
                        const selected = await options.request({ action: 'mention-read', uri: item.resourceUri });
                        if (!current()) return;
                        if (selected.status !== 'mention-resource') {
                            status.textContent = 'This snapshot is no longer available. Search again to refresh the list.';
                            return;
                        }
                        await options.include({ kind: 'snapshot', id: item.resourceUri, title: item.title, text: selected.text });
                        if (!current()) return;
                        status.textContent = 'Snapshot selected for this chat. Check context status to confirm availability. This is captured context, not a live review.';
                    })().catch(() => { if (current()) status.textContent = 'The snapshot could not be included. Try again.'; })
                        .finally(() => { if (!disposed && epoch === searchEpoch) include.disabled = false; });
                };
                row.append(title, subtitle, include); results.append(row);
            }
        } catch { if (!disposed && epoch === searchEpoch) status.textContent = 'Snapshots could not be loaded. Try searching again.'; }
    };
    form.onsubmit = event => { event.preventDefault(); if (!disposed) void search(); };
    details.ontoggle = () => { if (details.open && !opened && !disposed) { opened = true; void search(); } };
    return () => { disposed = true; searchEpoch++; selectionEpoch++; details.remove(); };
}
