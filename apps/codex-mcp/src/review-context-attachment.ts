import { MAX_REVIEW_CONTEXT_NOTE_LENGTH, type ReviewAgentContextInput } from '../../web/src/host/review-agent-bridge.js';
import type { ExtensionContextAttachment } from '../../web/src/host/extension-context-coordinator.js';

/** Capture values before hashing so a changing reader cannot retarget an attachment. */
export async function prepareReviewContext(input: ReviewAgentContextInput): Promise<ExtensionContextAttachment> {
    const snapshot = structuredClone(input.snapshot);
    const note = input.note?.trim() ?? '';
    if (note.length > MAX_REVIEW_CONTEXT_NOTE_LENGTH) throw Error('Keep your note under 2,000 characters.');

    const selection = input.kind === 'selection' ? snapshot.selection : null;
    const requestedIds = input.kind === 'annotations' ? new Set(input.annotationIds) : null;
    const selected = requestedIds === null ? [] : snapshot.annotations.filter(annotation => requestedIds.has(annotation.id));
    if (requestedIds === null ? !selection?.text : selected.length === 0 || selected.length !== requestedIds.size) {
        throw Error('Choose current review evidence first.');
    }

    const subject = selection ?? selected.map(annotation => annotation.id).sort();
    const identity = JSON.stringify([snapshot.source, snapshot.documentGeneration, input.kind, subject]);
    const boundedSelection = selection === null ? undefined : {
        pages: selection.pages.slice(0, 32),
        text: selection.text.slice(0, 4000),
        originalCharacters: selection.text.length,
    };
    const boundedAnnotations = requestedIds === null ? undefined : selected.slice(0, 20).map(annotation => ({
        id: annotation.id,
        page: annotation.page,
        kind: annotation.kind,
        text: annotation.text.slice(0, 1000),
        originalCharacters: annotation.text.length,
    }));
    const body = {
        kind: 'captured-review-context',
        title: snapshot.title.slice(0, 180),
        sourceDigest: snapshot.source.digest,
        documentGeneration: snapshot.documentGeneration,
        reviewRevision: snapshot.reviewRevision,
        userNote: note,
        selection: boundedSelection,
        annotations: boundedAnnotations,
        truncated: false,
    };
    if (boundedSelection && selection) {
        body.truncated = boundedSelection.text.length < boundedSelection.originalCharacters
            || boundedSelection.pages.length < selection.pages.length;
    }
    if (boundedAnnotations) {
        body.truncated = boundedAnnotations.length < selected.length
            || boundedAnnotations.some(annotation => annotation.text.length < annotation.originalCharacters);
    }

    let text = JSON.stringify(body);
    while (text.length > 6000) {
        const previousLength = text.length;
        if (boundedSelection) {
            boundedSelection.text = boundedSelection.text.slice(0, Math.floor(boundedSelection.text.length / 2));
        }
        if (boundedAnnotations) {
            if (boundedAnnotations.length > 1) {
                boundedAnnotations.pop();
            } else {
                const [annotation] = boundedAnnotations;
                if (annotation) annotation.text = annotation.text.slice(0, Math.floor(annotation.text.length / 2));
            }
        }
        body.truncated = true;
        text = JSON.stringify(body);
        if (text.length >= previousLength) throw Error('This note is too long to attach. Please shorten it.');
    }
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
    const id = 'review-' + [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const pages = selection?.pages ?? selected.map(annotation => annotation.page);
    const pageLabel = [...new Set(pages)].join(', ');
    const title = `${input.kind === 'selection' ? 'Selection' : 'Annotation'} · Page ${pageLabel} · ${snapshot.title}`;
    return { id, title, text };
}
