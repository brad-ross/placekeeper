import { CODEX_RESOURCE_CHUNK_BYTES, parseCodexResourceChunk, parseCodexResourceDescriptor, type CodexResourceDescriptor } from "../../../packages/core/src/codex-mcp-protocol.js";

export interface ResourceMaterializationOptions {
  readonly current: () => boolean;
  readonly digest: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
  /** Optional caller policy for tests/specialized consumers; native review imposes no size cap. */
  readonly maxBytes?: number;
}
export class ResourceAllocationError extends Error {
  constructor() { super("resource-allocation-failed"); this.name = "ResourceAllocationError"; }
}

/** One bounded transfer with exact offsets, terminal length, digest and incarnation fences. */
export async function materializeResource(raw: unknown, read: (offset: number, length: number) => Promise<unknown>, options: ResourceMaterializationOptions): Promise<Uint8Array<ArrayBuffer>> {
  const descriptor = parseCodexResourceDescriptor(raw);
  if (descriptor === undefined || (options.maxBytes !== undefined && descriptor.byteLength > options.maxBytes) || !options.current()) throw new Error("invalid-resource");
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = new Uint8Array(descriptor.byteLength); } catch { throw new ResourceAllocationError(); }
  for (let offset = 0; offset < bytes.length;) {
    const length = Math.min(CODEX_RESOURCE_CHUNK_BYTES, bytes.length - offset);
    const chunk = parseCodexResourceChunk(await read(offset, length));
    if (!options.current() || chunk === undefined || chunk.offset !== offset) throw new Error("stale-or-invalid-resource");
    const decoded = Uint8Array.from(atob(chunk.dataBase64), (character) => character.charCodeAt(0));
    if (decoded.length !== length || chunk.done !== (offset + length === bytes.length)) throw new Error("truncated-resource");
    bytes.set(decoded, offset); offset += length;
  }
  if (await options.digest(bytes) !== descriptor.sha256 || !options.current()) throw new Error("resource-digest-mismatch");
  return bytes;
}
/** Retains at most one verified materialization; revision/save updates cannot repoll bytes.
 * Scope is a caller-owned incarnation, never authority inferred from a document digest. */
export class VerifiedResourceMaterializer {
  #epoch = 0;
  #cached: { scope: number; descriptor: CodexResourceDescriptor; bytes: Uint8Array<ArrayBuffer> } | undefined;

  clear(): void { this.#epoch++; this.#cached = undefined; }

  async materialize(scope: number, raw: unknown, read: (offset: number, length: number) => Promise<unknown>, options: ResourceMaterializationOptions): Promise<Uint8Array<ArrayBuffer>> {
    const descriptor = parseCodexResourceDescriptor(raw);
    if (descriptor === undefined || !options.current() || (options.maxBytes !== undefined && descriptor.byteLength > options.maxBytes)) throw new Error("invalid-resource");
    const previous = this.#cached;
    if (previous?.scope === scope && previous.descriptor.handle === descriptor.handle && previous.descriptor.byteLength === descriptor.byteLength && previous.descriptor.sha256 === descriptor.sha256 && previous.descriptor.mediaType === descriptor.mediaType) return previous.bytes;
    const epoch = this.#epoch;
    const current = () => this.#epoch === epoch && options.current();
    const bytes = await materializeResource(descriptor, read, { ...options, current });
    if (!current()) throw new Error("stale-or-invalid-resource");
    this.#cached = { scope, descriptor, bytes };
    return bytes;
  }
}

export function resourceDescriptors(value: unknown): Record<"document" | "pdfiumWasm" | "worker", CodexResourceDescriptor> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  const document = parseCodexResourceDescriptor(input.document), pdfiumWasm = parseCodexResourceDescriptor(input.pdfiumWasm), worker = parseCodexResourceDescriptor(input.worker);
  return document?.mediaType === "application/pdf" && pdfiumWasm?.mediaType === "application/wasm" && worker?.mediaType === "text/javascript" ? { document, pdfiumWasm, worker } : undefined;
}
