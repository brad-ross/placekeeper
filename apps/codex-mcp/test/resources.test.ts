import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { materializeResource, ResourceAllocationError, VerifiedResourceMaterializer } from "../src/resources.js";
const hash = async (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = Buffer.alloc(300_000, 7);
const descriptor = { handle: "document-handle", byteLength: bytes.length, sha256: await hash(bytes), mediaType: "application/pdf" };
const read = async (offset: number, length: number) => ({ offset, dataBase64: bytes.subarray(offset, offset + length).toString("base64"), done: offset + length === bytes.length });
const options = { current: () => true, digest: hash, maxBytes: 1_000_000 };
describe("native chunk materialization", () => {
  it("assembles bounded chunks and checks the digest", async () => { expect(await materializeResource(descriptor, read, options)).toEqual(new Uint8Array(bytes)); });
  it("rejects oversized allocation before reading", async () => { await expect(materializeResource(descriptor, () => { throw new Error("read-called"); }, { ...options, maxBytes: 1 })).rejects.toThrow("invalid-resource"); });
  it.each(["offset", "truncated", "terminal", "digest", "stale"])("rejects %s without publishing", async (failure) => {
    let current = true;
    await expect(materializeResource(failure === "digest" ? { ...descriptor, sha256: "0".repeat(64) } : descriptor, async (offset, length) => {
      const result = await read(offset, length);
      if (failure === "offset") result.offset++;
      if (failure === "truncated") result.dataBase64 = "YQ==";
      if (failure === "terminal") result.done = true;
      if (failure === "stale") current = false;
      return result;
    }, { ...options, current: () => current })).rejects.toThrow();
  });
});

describe("verified native document cache", () => {
  it("reuses immutable same-incarnation bytes through arbitrary review/save updates", async () => {
    const cache = new VerifiedResourceMaterializer();
    const reads = vi.fn(read), digest = vi.fn(hash);
    const first = await cache.materialize(1, descriptor, reads, { current: () => true, digest });
    for (let revision = 1; revision <= 5; revision++) expect(await cache.materialize(1, { ...descriptor }, reads, { current: () => true, digest })).toBe(first);
    expect(reads).toHaveBeenCalledTimes(2); expect(digest).toHaveBeenCalledOnce();
    await cache.materialize(1, { ...descriptor, handle: "new-document-handle" }, reads, { current: () => true, digest });
    expect(reads).toHaveBeenCalledTimes(4);
    await cache.materialize(2, descriptor, reads, { current: () => true, digest });
    expect(reads).toHaveBeenCalledTimes(6);
  });
  it("a changed digest cannot reuse previously verified bytes", async () => {
    const cache = new VerifiedResourceMaterializer(), reads = vi.fn(read);
    await cache.materialize(1, descriptor, reads, options);
    await expect(cache.materialize(1, { ...descriptor, sha256: "0".repeat(64) }, reads, options)).rejects.toThrow("resource-digest-mismatch");
    expect(reads).toHaveBeenCalledTimes(4);
  });
  it("never reuses old authority and cannot repopulate a cleared cache from an in-flight reply", async () => {
    const cache = new VerifiedResourceMaterializer(), reads = vi.fn(read);
    await cache.materialize(1, descriptor, reads, options);
    await expect(cache.materialize(1, descriptor, reads, { ...options, current: () => false })).rejects.toThrow("invalid-resource");
    expect(reads).toHaveBeenCalledTimes(2);
    cache.clear();
    await expect(cache.materialize(1, descriptor, reads, { current: () => true, digest: async (data) => { cache.clear(); return hash(data); } })).rejects.toThrow();
    await cache.materialize(1, descriptor, reads, options);
    expect(reads).toHaveBeenCalledTimes(6);
  });
  it("does not introduce a document size policy and reports host allocation failure before reading", async () => {
    const cache = new VerifiedResourceMaterializer(), reads = vi.fn(read);
    expect(await cache.materialize(1, descriptor, reads, { current: () => true, digest: hash })).toEqual(new Uint8Array(bytes));
    const unread = vi.fn(read);
    await expect(cache.materialize(1, { ...descriptor, byteLength: Number.MAX_SAFE_INTEGER }, unread, { current: () => true, digest: hash })).rejects.toBeInstanceOf(ResourceAllocationError);
    expect(unread).not.toHaveBeenCalled();
  });
});
