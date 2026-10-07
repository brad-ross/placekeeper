import { describe, expect, it, vi } from "vitest";
import { deniedFailure, diagnosticFailure, LifecycleDiagnostics, NativeDiagnosticError, verifiedAppReply } from "../src/lifecycle-diagnostics.js";
import { RESPONSE_META_KEY } from "../src/transport-contract.js";

const first = "12345678-1234-1234-1234-123456789abc";
const second = "87654321-4321-4321-4321-cba987654321";
const now = () => new Date("2026-10-02T15:00:00.000Z");
function memoryStorage(initial: string | null = null) {
  let value = initial;
  return { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next; }), read: () => value };
}

describe("native diagnostic failure categories", () => {
  it("separates service denial from transport, tool error, and metadata failures", () => {
    expect(verifiedAppReply({ _meta: { [RESPONSE_META_KEY]: { status: "denied", reason: "revoked" } } })).toEqual({ status: "denied", reason: "revoked" });
    expect(diagnosticFailure(deniedFailure("revoked"))).toBe("service-denied-revoked");
    expect(diagnosticFailure(new NativeDiagnosticError("transport"))).toBe("transport");
    for (const [value, category] of [
      [{ isError: true, content: [{ text: "private-secret" }] }, "tool-error"],
      [{ content: [] }, "response-metadata-missing"],
      [{ _meta: { [RESPONSE_META_KEY]: { status: "denied", reason: "private-secret" } } }, "response-metadata-invalid"],
    ] as const) {
      try { verifiedAppReply(value); throw new Error("expected guard rejection"); }
      catch (error) { expect(diagnosticFailure(error)).toBe(category); expect(String(error)).not.toContain("private-secret"); }
    }
    expect(diagnosticFailure(new Error("private-secret/path/capability"))).toBe("unclassified");
  });
});

describe("non-authoritative native lifecycle diagnostics", () => {
  it("records teardown before a new instance without storing credentials", () => {
    const storage = memoryStorage(), old = new LifecycleDiagnostics(first, now, storage);
    old.record("active"); old.record("mode-request", { mode: "inline" }); old.record("teardown");
    const remounted = new LifecycleDiagnostics(second, now, storage);
    expect(remounted.snapshot().instance).toBe(second);
    expect(remounted.snapshot().phase).toBe("started");
    expect(remounted.snapshot().trace.slice(-2)).toEqual([
      { instance: first, at: now().toISOString(), event: "teardown" },
      { instance: second, at: now().toISOString(), event: "started" },
    ]);
    expect(remounted.snapshot().lastSuccessfulRenewal).toBe("never");
  });
  it("bounds the trace and reads only closed allowlisted observations", () => {
    const storage = memoryStorage(), diagnostics = new LifecycleDiagnostics(first, now, storage);
    for (let index = 0; index < 100; index++) diagnostics.record("renewed");
    expect(diagnostics.snapshot().trace).toHaveLength(24);
    expect(storage.read()!.length).toBeLessThan(8192);
    const secret = "secret-pending-capability-private-path-PDF-bytes";
    const tainted = memoryStorage(JSON.stringify([{ instance: first, at: now().toISOString(), event: "active", capability: secret }]));
    const fresh = new LifecycleDiagnostics(first, now, tainted);
    fresh.record("failed", { mode: secret, failure: secret as never, arbitrary: secret } as never);
    fresh.record(secret as never);
    expect(JSON.stringify(fresh.snapshot())).not.toContain(secret);
    expect(tainted.read()).not.toContain(secret);
    expect(fresh.snapshot().trace).toHaveLength(2);
  });
  it.each(["malformed", "x".repeat(9000), JSON.stringify(Array(25).fill({ instance: first, at: now().toISOString(), event: "active" }))])("discards invalid or oversized stored traces", (stored) => {
    const diagnostics = new LifecycleDiagnostics(first, now, memoryStorage(stored));
    expect(diagnostics.snapshot().trace).toHaveLength(1);
  });
  it("tolerates storage errors and calculates renewal age without a timer", () => {
    let time = now();
    const storage = { getItem: () => { throw new Error("private-secret"); }, setItem: () => { throw new Error("private-secret"); } };
    const diagnostics = new LifecycleDiagnostics(first, () => time, storage);
    diagnostics.record("renewed"); time = new Date(time.getTime() + 35_000);
    expect(diagnostics.snapshot()).toMatchObject({ phase: "renewed", renewalAgeSeconds: 35, traceStorage: "unavailable" });
    diagnostics.record("teardown");
    expect(diagnostics.snapshot().phase).toBe("teardown");
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain("private-secret");
  });
});
it("shows only validated received invocation correlation and drops it on expiry without persisting it", () => {
  let time = now(); const storage = memoryStorage();
  const diagnostics = new LifecycleDiagnostics(first, () => time, storage);
  const invocation = { runId: "a".repeat(32), expiresAt: new Date(time.getTime() + 1000).toISOString(), invocationNonce: "b".repeat(32) };
  diagnostics.observeInvocation(invocation);
  expect(diagnostics.snapshot()).toHaveProperty("qualification", invocation);
  expect(storage.read()).not.toContain(invocation.invocationNonce);
  time = new Date(time.getTime() + 1001); expect(diagnostics.snapshot()).not.toHaveProperty("qualification");
  diagnostics.observeInvocation({ ...invocation, capability: "secret" }); expect(diagnostics.snapshot()).not.toHaveProperty("qualification");
});
it("ignores throwing nonauthority invocation metadata without changing diagnostics", () => {
  const diagnostics = new LifecycleDiagnostics(first, now);
  const metadata = new Proxy({}, { ownKeys() { throw new Error("private failure"); } });
  expect(() => diagnostics.observeInvocation(metadata)).not.toThrow();
  expect(diagnostics.snapshot()).not.toHaveProperty("qualification");
  expect(diagnostics.snapshot().phase).toBe("started");
});
