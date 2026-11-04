import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { ReviewBridge } from './review-bridge.js';
/** Streams bounded service chunks; adoption happens only after digest and length verification. */
export function documentResponse(bridge: ReviewBridge, generation: number): Response {
    const p = bridge.projection;
    if (p === undefined || p.generation !== generation || bridge.resourceId === undefined)
        return new Response(null, { status: 404 });
    const descriptor = p.document;
    const resourceId = bridge.resourceId;
    let offset = 0;
    const abort = new AbortController();
    const digest = createHash('sha256');
    return new Response(new ReadableStream<Uint8Array>({
        cancel() { abort.abort(); },
        async pull(controller) {
            try {
                if (offset < descriptor.byteLength) {
                    const length = Math.min(65536, descriptor.byteLength - offset);
                    const result = await bridge.send({ type: 'read-resource', resourceId, generation, offset, length, role: 'document' }, abort.signal);
                    if (result.type !== 'resource-bytes')
                        throw new Error('Invalid resource response');
                    const bytes = Buffer.from(result.data, 'base64');
                    if (bytes.length !== length)
                        throw new Error('Invalid resource length');
                    offset += bytes.length;
                    digest.update(bytes);
                    controller.enqueue(bytes);
                    return;
                }
                const sha256 = digest.digest('hex');
                if (sha256 !== descriptor.sha256)
                    throw new Error('Document digest mismatch');
                const adopted = await bridge.send({ type: 'adopt-resource', resourceId, generation, byteLength: offset, digest: sha256 });
                if (adopted.type !== 'resource-adopted')
                    throw new Error('Document adoption failed');
                bridge.validatedGeneration = generation;
                await bridge.activate();
                controller.close();
            }
            catch (error) {
                controller.error(error);
            }
        },
    }), { headers: { 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' } });
}
export async function assetResponse(root: string, inventory: ReadonlySet<string>, requestUrl: string): Promise<Response> {
    const url = new URL(requestUrl);
    const name = decodeURIComponent(url.pathname).replace(/^\//u, '');
    if (url.protocol !== 'placekeeper-app:' || url.host !== 'bundle' || url.search || url.hash || !inventory.has(name))
        return new Response(null, { status: 404 });
    const base = await realpath(root);
    const path = await realpath(resolve(base, name));
    if (!path.startsWith(base + sep))
        return new Response(null, { status: 403 });
    const types: Record<string, string> = { js: 'text/javascript', css: 'text/css', html: 'text/html', wasm: 'application/wasm', woff2: 'font/woff2' };
    return new Response(await readFile(path), { headers: { 'Content-Type': types[name.split('.').at(-1)!] ?? 'application/octet-stream', 'Cache-Control': 'no-store' } });
}
