import { REVIEW_RUNTIME_PROTOCOL, REVIEW_RUNTIME_VERSION, type ReviewRuntimeMethod } from '../../../../packages/core/src/review-runtime-protocol.js';
import type { CodexResourceDescriptor } from '../../../../packages/core/src/codex-mcp-protocol.js';
import { VerifiedResourceMaterializer, resourceDescriptors } from '../../../codex-mcp/src/resources.js';
import { createRpcHostRuntime, type MaterializedViewerResource } from './vscode-runtime.js';
import type { HostRuntime, HostRuntimeInvalidation } from './runtime.js';

export interface CodexRuntimePort {
  readonly runtimeId: string;
  call(method: ReviewRuntimeMethod | 'resource', payload: unknown): Promise<unknown>;
  subscribeInvalidations(listener: (event: HostRuntimeInvalidation) => void): () => void;
}

/** Only an admitted shell supplies this port; no task or presentation authority is inferred here. */
export function createCodexHostRuntime(port: CodexRuntimePort, environment: {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  digest?: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
} = {}): HostRuntime {
  let disposed = false;
  let bootstrapRequestId: string | undefined;
  const descriptors = new Map<string, CodexResourceDescriptor>();
  const listeners = new Set<(message: unknown) => void>();
  const materializers = new Map<string, VerifiedResourceMaterializer>();
  const createURL = environment.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeURL = environment.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const digest = environment.digest ?? (async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(byte => byte.toString(16).padStart(2, '0')).join(''));
  const publish = (message: unknown) => { if (!disposed) for (const listener of listeners) listener(message); };
  const unsubscribe = port.subscribeInvalidations(event => publish({ protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'event', runtimeId: port.runtimeId, event: 'session-invalidated', payload: event }));
  const materialize = (role: 'document' | 'pdfiumWasm' | 'worker') => async (handle: string): Promise<MaterializedViewerResource> => {
    const descriptor = descriptors.get(handle);
    if (descriptor === undefined) throw new Error('Native resource is unavailable.');
    let materializer = materializers.get(role);
    if (materializer === undefined) { materializer = new VerifiedResourceMaterializer(); materializers.set(role, materializer); }
    const bytes = await materializer.materialize(1, descriptor, (offset, length) => port.call('resource', { handle: descriptor.handle, offset, length }), { current: () => !disposed && descriptors.get(handle) === descriptor, digest });
    if (disposed) throw new Error('Native review disconnected.');
    const url = createURL(new Blob([bytes], { type: descriptor.mediaType }));
    let released = false;
    return { url, ...(role === 'pdfiumWasm' || role === 'document' ? { bytes } : {}), dispose() { if (!released) { released = true; revokeURL(url); } } };
  };
  const runtime = createRpcHostRuntime({
    runtimeId: port.runtimeId,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    postMessage(raw) {
      const message = raw as { kind: string; requestId: string; method: ReviewRuntimeMethod; payload: unknown; sessionId?: string; generation?: number; revision?: number };
      if (message.kind !== 'request') return;
      if (message.method === 'bootstrap') bootstrapRequestId = message.requestId;
      void port.call(message.method, message.payload).then(value => {
        if (message.method === 'bootstrap' && message.requestId === bootstrapRequestId && !disposed) {
          const manifest = resourceDescriptors((value as Record<string, unknown>).resourceDescriptors);
          if (manifest === undefined) throw new Error('Unverified native resources.');
          descriptors.clear();
          const resources: Record<string, string> = {};
          for (const [role, descriptor] of Object.entries(manifest)) {
            // Content equivalence retains verified bytes within this admitted presentation only.
            const key = `${role}:${descriptor.sha256}:${descriptor.byteLength}`;
            descriptors.set(key, descriptor); resources[role] = key;
          }
          value = { ...value as object, resources };
        }
        const identity = message.method === 'bootstrap' ? value as object : { sessionId: message.sessionId, generation: message.generation, revision: message.revision };
        publish({ protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'response', runtimeId: port.runtimeId, requestId: message.requestId, method: message.method, ...identity, ok: true, payload: value });
      }).catch(() => publish({ protocol: REVIEW_RUNTIME_PROTOCOL, version: REVIEW_RUNTIME_VERSION, kind: 'response', runtimeId: port.runtimeId, requestId: message.requestId, method: message.method, sessionId: message.sessionId, generation: message.generation, revision: message.revision, ok: false, error: { kind: 'native-resource-or-command-failed' } }));
    },
  }, { host: 'codex', materializeDocument: materialize('document'), materializePdfiumWasm: materialize('pdfiumWasm'), materializePdfiumWorker: materialize('worker') });
  return { ...runtime, get capabilities() { return runtime.capabilities!; }, dispose() { if (disposed) return; disposed = true; unsubscribe(); runtime.dispose(); descriptors.clear(); listeners.clear(); for (const materializer of materializers.values()) materializer.clear(); materializers.clear(); } };
}
