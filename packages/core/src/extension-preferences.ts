export interface ExtensionPreferenceValues {
    backgroundContext: boolean;
    selectionSharing: boolean;
    mentions: boolean;
}
export const extensionPreferenceDefaults: ExtensionPreferenceValues = { backgroundContext: true, selectionSharing: true, mentions: false };
export const extensionPreferenceSchema = { type: 'object' as const, additionalProperties: false, required: ['backgroundContext', 'selectionSharing', 'mentions'], properties: {
        backgroundContext: { type: 'boolean', title: 'Background context', description: 'Global default for document context. App-local removals remain in effect.' },
        selectionSharing: { type: 'boolean', title: 'Selection sharing', description: 'Global default for sharing the current selection.' },
        mentions: { type: 'boolean', title: 'Mention catalogue', description: 'Allow explicitly included review snapshots in other chats. Turning off removes all included snapshots.' }
    } };
export const extensionPreferenceLayout = [{ kind: 'group', title: 'Global preferences', items: Object.keys(extensionPreferenceDefaults).map(property => ({ kind: 'property', property })) }];
export function parsePreferenceSet(v: unknown): Partial<ExtensionPreferenceValues> | undefined {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return;
    const entries = Object.entries(v);
    if (!entries.length || !entries.every(([k, x]) => Object.hasOwn(extensionPreferenceDefaults, k) && typeof x === 'boolean'))
        return;
    return Object.fromEntries(entries);
}
export interface MentionItem {
    type: 'resource';
    resourceUri: string;
    title: string;
    subtitle: string;
}
export interface SnapshotLabel {
    generation: number;
    revision: number;
    capturedAt: string;
}
export type PreferenceRequest = {
    action: 'settings-read';
} | {
    action: 'settings-update';
    set: Partial<ExtensionPreferenceValues>;
} | {
    action: 'catalogue';
    grant: string;
    operation: 'status' | 'capture' | 'remove';
} | {
    action: 'mention-search';
    query: string;
} | {
    action: 'mention-read';
    uri: string;
};
export type PreferenceResult = {
    status: 'settings';
    values: ExtensionPreferenceValues;
    revision: number;
} | {
    status: 'catalogue';
    included: boolean;
    snapshot?: SnapshotLabel;
} | {
    status: 'mention-results';
    items: MentionItem[];
} | {
    status: 'mention-resource';
    text: string;
};
