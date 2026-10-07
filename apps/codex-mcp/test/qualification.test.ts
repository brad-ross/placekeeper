import { describe, expect, it } from "vitest";
import { nativeGateChecks, validateQualification, type NativeQualification } from "../../../scripts/qualify-codex-native.js";
describe("actual-host qualification evidence", () => {
  it("does not accept synthetic coverage or omitted lifecycle evidence", () => {
    const report: NativeQualification = { schemaVersion: 1, status: "passed", host: { codexBuild: "build", os: "macOS", pluginVersion: "version", artifactDigest: "a".repeat(64) }, disconnectTimeoutMs: 30_000, checks: nativeGateChecks.map((id) => ({ id, result: "passed", evidence: "synthetic unit test", observedAt: new Date().toISOString(), actualHost: false })) };
    expect(validateQualification(report)).toHaveLength(nativeGateChecks.length);
    for (const check of report.checks) check.actualHost = true;
    expect(validateQualification(report)).toEqual([]);
    report.checks = report.checks.filter((check) => check.id !== "hidden-renewal");
    expect(validateQualification(report)).toEqual(["Missing actual-host pass evidence: hidden-renewal"]);
  });
});

describe("safe explicit lifecycle recovery evidence", () => {
  it("retains failed continuity evidence and requires a separate actual-host reconnect observation", () => {
    const report: NativeQualification = { schemaVersion: 1, status: "passed", host: { codexBuild: "build", os: "macOS", pluginVersion: "version", artifactDigest: "a".repeat(64) }, disconnectTimeoutMs: 30_000, checks: nativeGateChecks.map((id) => ({ id, result: "passed", evidence: "observed", observedAt: "2026-10-02T16:00:00Z", actualHost: true })) };
    const original = report.checks.find((check) => check.id === "expand-restore-renewal")!;
    original.result = "failed";
    original.evidence = "original invocation remounted and denied";
    expect(validateQualification(report)).toEqual(["Missing actual-host pass evidence: expand-restore-renewal"]);
    const recovery = { id: "expand-restore-explicit-reconnect", result: "passed" as const, evidence: "unavailable then explicit same-chat request, fresh trusted launch/display and current recovered evidence", observedAt: "2026-10-02T17:00:00Z", actualHost: false };
    report.checks.push(recovery);
    expect(validateQualification(report)).toHaveLength(1);
    recovery.actualHost = true;
    expect(validateQualification(report)).toEqual([]);
    expect(original.result).toBe("failed");
    report.checks.push({ ...recovery });
    expect(validateQualification(report)).toHaveLength(1);
  });
});

import { ShellQualificationControls } from "../src/shell-qualification-controls.js";
import { parseQualificationControlGrant } from "../src/qualification-controls-contract.js";
import { vi } from "vitest";
const controlTarget = { runId: "a".repeat(32), processNonce: "b".repeat(32), invocationNonce: "c".repeat(32), runtimeId: "runtime-1", attemptId: "attempt-1" };
const own = { runId: controlTarget.runId, invocationNonce: controlTarget.invocationNonce, runtimeId: controlTarget.runtimeId, attemptId: controlTarget.attemptId };
function controlGrant(action: "request-teardown" | "bridge-close", now: number) { return { version: 1, actionId: "d".repeat(32), budget: 1, action, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 1000).toISOString(), target: controlTarget }; }
it("requires separate closed metadata, an exact own invocation and an explicit click with unexpired one-shot budget", async () => {
  let time = Date.parse("2026-10-02T12:00:00.000Z"); const controls = new ShellQualificationControls(() => time), sdk = { requestTeardown: vi.fn(async () => {}), close: vi.fn(async () => {}) }, stop = vi.fn();
  expect(controls.arm(undefined, own)).toBe(false); expect(controls.arm({ observe: true }, own)).toBe(false);
  expect(parseQualificationControlGrant({ ...controlGrant("bridge-close", time), capability: "secret" }, time)).toBeUndefined();
  for (const key of Object.keys(own)) expect(controls.arm(controlGrant("bridge-close", time), { ...own, [key]: "e".repeat(32) })).toBe(false);
  expect(controls.arm(controlGrant("bridge-close", time), own)).toBe(true); expect(sdk.close).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  time += 1001; expect(await controls.execute(own, sdk, stop)).toBe(false); expect(sdk.close).not.toHaveBeenCalled(); expect(controls.snapshot()?.outcome).toBe("expired");
});
it("closes only its own bridge, clears local state before SDK close and cannot execute twice or detach", async () => {
  const time = Date.parse("2026-10-02T12:00:00.000Z"), controls = new ShellQualificationControls(() => time), order: string[] = [];
  const sdk = { requestTeardown: vi.fn(async () => {}), close: vi.fn(async () => { order.push("close"); }), detach: vi.fn() }, stop = () => order.push("stop");
  controls.arm(controlGrant("bridge-close", time), own);
  expect(await controls.execute({ ...own, attemptId: "attempt-peer" }, sdk, stop)).toBe(false);
  expect(await controls.execute(own, sdk, stop)).toBe(true); expect(order).toEqual(["stop", "close"]); expect(sdk.detach).not.toHaveBeenCalled(); expect(sdk.requestTeardown).not.toHaveBeenCalled();
  expect(await controls.execute(own, sdk, stop)).toBe(false); expect(controls.arm(controlGrant("bridge-close", time), own)).toBe(false); expect(sdk.close).toHaveBeenCalledOnce();
  expect(controls.snapshot()?.outcome).toBe("bridge-closed");
});
it("records a teardown notification as requested only and never logs raw SDK errors", async () => {
  const time = Date.parse("2026-10-02T12:00:00.000Z"), controls = new ShellQualificationControls(() => time), stop = vi.fn(), sdk = { requestTeardown: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  controls.arm(controlGrant("request-teardown", time), own); await controls.execute(own, sdk, stop);
  expect(controls.snapshot()?.outcome).toBe("requested"); expect(stop).not.toHaveBeenCalled(); expect(sdk.close).not.toHaveBeenCalled();
  const failed = new ShellQualificationControls(() => time); failed.arm(controlGrant("request-teardown", time), own); sdk.requestTeardown.mockRejectedValue(new Error("secret-capability /private/path")); await failed.execute(own, sdk, stop);
  expect(failed.snapshot()?.outcome).toBe("failed"); expect(JSON.stringify(failed.snapshot())).not.toMatch(/secret|capability|private|path|passed/);
});

import { afterEach } from "vitest";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.doUnmock("@modelcontextprotocol/ext-apps"); vi.doUnmock("../../web/src/codex-entry.js"); vi.doUnmock("../../web/src/host/codex-runtime.js"); });
async function qualificationShellFixture(withControl: boolean, action: "bridge-close" | "request-teardown" = "bridge-close", oldControl = false, realRuntime = false) {
  vi.resetModules(); vi.useFakeTimers({ now: new Date("2026-10-02T12:00:00.000Z") });
  class Element {
    textContent = ""; removed = false; disabled = true; onclick: (() => void | Promise<void>) | undefined;
    before() {} setAttribute() {} remove() { this.removed = true; }
  }
  const status = new Element(), detail = new Element(), renewal = new Element(), expand = new Element(), restore = new Element(), closeReview = new Element(), root = new Element();
  const created: { tag: string; element: Element }[] = [];
  vi.stubGlobal("document", { hidden: false, querySelector: (selector: string) => ({ "#status": status, "#detail": detail, "#renewal": renewal, "#expand": expand, "#restore": restore, "#close": closeReview, "#root": root } as Record<string, Element>)[selector], createElement: (tag: string) => { const element = new Element(); created.push({ tag, element }); return element; } });
  vi.stubGlobal("window", {});
  const clear = vi.fn();
  const runtimeDispose = vi.fn();
  const runtime = { dispose: runtimeDispose };
  let port!: import("../../web/src/host/codex-runtime.js").CodexRuntimePort;
  if (realRuntime) {
    const actual = await vi.importActual<typeof import("../../web/src/host/codex-runtime.js")>("../../web/src/host/codex-runtime.js");
    vi.doMock("../../web/src/host/codex-runtime.js", () => ({ createCodexHostRuntime: (value: typeof port) => {
      port = value; const genuine = actual.createCodexHostRuntime(value);
      const dispose = genuine.dispose.bind(genuine); genuine.dispose = () => { runtimeDispose(); dispose(); }; return genuine;
    } }));
  } else vi.doMock("../../web/src/host/codex-runtime.js", () => ({ createCodexHostRuntime: vi.fn((value) => { port = value; return runtime; }) }));
  const mount = vi.fn((element: Element, mountedRuntime: typeof runtime, _onError: unknown, onReady: () => void) => {
    element.textContent = "Shared production review mounted";
    let detachPresence: (() => void) | undefined;
    if (realRuntime) void (mountedRuntime as unknown as import("../../web/src/host/runtime.js").HostRuntime).bootstrap().then(() => {
      detachPresence = (mountedRuntime as unknown as import("../../web/src/host/runtime.js").HostRuntime).presence!(); onReady();
    });
    else queueMicrotask(onReady);
    return () => { clear(); element.textContent = ""; detachPresence?.(); mountedRuntime.dispose(); };
  });
  vi.doMock("../../web/src/codex-entry.js", () => ({ mountCodexProductionReview: mount }));
  const fixtureRuntimeId = realRuntime ? "runtime_1234567890" : "runtime-1";
  let grantSent = false;
  const calls: string[] = [];
  class MockApp {
    ontoolresult: ((result: unknown) => void) | undefined;
    onteardown: (() => Promise<unknown>) | undefined;
    onhostcontextchanged: unknown;
    requestTeardown = vi.fn(async () => {}); close = vi.fn(async () => {}); connect = async () => {};
    requestDisplayMode = async () => ({ mode: "inline" });
    callServerTool = vi.fn(async (input: { arguments: { request: { method: string } } }, _options?: { timeout: number; maxTotalTimeout: number }): Promise<{ content: never[]; _meta: Record<string, unknown> }> => {
      const method = input.arguments.request.method; calls.push(method);
      const realBootstrap = realRuntime && method === "bootstrap" ? {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1, revision: 0,
        state: createReviewState({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", source: { fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", digest: "a".repeat(64), byteLength: 3 } }),
        scope: { documentTitle: "Closed.pdf", launchSurface: "codex" },
        saveStatus: { destination: { phase: "none", generation: 0 }, sync: { phase: "clean", desiredRevision: 0, savedRevision: 0 } },
        resources: { document: "document_handle_1234", pdfiumWasm: "wasm_handle_1234", worker: "worker_handle_1234" },
        resourceDescriptors: Object.fromEntries([["document", "application/pdf"], ["pdfiumWasm", "application/wasm"], ["worker", "text/javascript"]].map(([role, mediaType]) => [role, { handle: `${role === "pdfiumWasm" ? "wasm" : role}_handle_1234`, mediaType, byteLength: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }])),
      } : undefined;
      const response = method === "ready" ? { status: "active", runtimeId: fixtureRuntimeId, attemptId: "attempt-1", generation: 1, presentationCapability: "p".repeat(43), reconnectTicket: "r".repeat(43) } : { status: "ok", payload: realBootstrap ?? (method === "resource" ? { offset: 0, dataBase64: "YWJj", done: true } : method === "bootstrap" ? { resourceDescriptors: {} } : { watermark: 1 }) };
      const grant = withControl && method === "renew" && !grantSent ? controlGrant(action, Date.now()) : undefined;
      if (grant !== undefined) grantSent = true;
      return { content: [], _meta: { "placekeeper/response": response, ...(grant === undefined ? {} : oldControl ? { "placekeeper/qualification-old-attempt": oldGrant(Date.now()) } : { "placekeeper/qualification-controls": grant }) } };
    });
    onclose: (() => void) | undefined; onerror: (() => void) | undefined;
  }
  const app = new MockApp(); vi.doMock("@modelcontextprotocol/ext-apps", () => ({ App: class { constructor() { return app; } } }));
  await import("../src/shell.js");
  app.ontoolresult!({ structuredContent: { protocolVersion: 1, status: "pending", receiptId: "receipt-1", attemptId: "attempt-1", generation: 1 }, _meta: { "placekeeper/pending": { protocolVersion: 1, runtimeId: fixtureRuntimeId, attemptId: "attempt-1", generation: 1, receiptId: "receipt-1", pendingCapability: "p".repeat(43) }, "placekeeper/qualification": { runId: own.runId, invocationNonce: own.invocationNonce, expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
  await vi.advanceTimersByTimeAsync(0);
  return { app, calls, created, status, detail, renewal, root, clear, mount, runtimeDispose, port, closeReview };
}
it("normal shell has no qualification button and continues ordinary renewal without a descriptor grant", async () => {
  const f = await qualificationShellFixture(false);
  expect(f.created.filter(item => item.tag === "button")).toHaveLength(0);
  expect(f.mount).toHaveBeenCalledOnce(); expect(f.root.textContent).toBe("Shared production review mounted"); expect(f.runtimeDispose).not.toHaveBeenCalled();
  expect(f.calls).toContain("ready"); expect(f.calls).toContain("renew");
  await vi.advanceTimersByTimeAsync(5000); expect(f.calls.filter(method => method === "renew")).toHaveLength(2);
  expect(f.app.close).not.toHaveBeenCalled(); expect(f.app.requestTeardown).not.toHaveBeenCalled();
});
it("the actual shell bridge button clears current UI and stops renew/poll before closing its own SDK App", async () => {
  const f = await qualificationShellFixture(true), button = f.created.find(item => item.tag === "button")!.element;
  expect(f.app.close).not.toHaveBeenCalled(); expect(f.root.textContent).not.toBe("");
  await button.onclick!(); expect(f.app.close).toHaveBeenCalledOnce(); expect(f.detail.textContent).toBe(""); expect(f.root.textContent).toBe(""); expect(f.clear).toHaveBeenCalled(); expect(f.runtimeDispose).toHaveBeenCalledOnce(); expect(f.calls).not.toContain("detach");
  const count = f.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(f.calls).toHaveLength(count); expect(f.status.textContent).toContain("this panel bridge was closed"); expect(f.renewal.textContent).toBe("Authenticated panel renewal stopped.");
  expect(f.created.filter(item => item.tag === "pre").map(item => item.element.textContent).join(" ")).not.toMatch(/presentationCapability|pendingCapability|reconnectTicket|pppppppp/);
});
it("an expired actual shell grant removes its button and cannot close the bridge", async () => {
  const f = await qualificationShellFixture(true), button = f.created.find(item => item.tag === "button")!.element;
  await vi.advanceTimersByTimeAsync(1001); expect(button.removed).toBe(true); await button.onclick!(); expect(f.app.close).not.toHaveBeenCalled(); expect(f.status.textContent).toContain("review ready");
});

it("the actual shell teardown button only requests the host; normal host teardown detaches its own presentation", async () => {
  const f = await qualificationShellFixture(true, "request-teardown"), button = f.created.find(item => item.tag === "button")!.element;
  await button.onclick!(); expect(f.app.requestTeardown).toHaveBeenCalledOnce(); expect(f.app.close).not.toHaveBeenCalled(); expect(f.calls).not.toContain("detach"); expect(f.root.textContent).not.toBe("");
  expect(f.created.filter(item => item.tag === "pre").map(item => item.element.textContent).join(" ")).toContain('"outcome": "requested"');
  await f.app.onteardown!(); expect(f.calls.filter(method => method === "detach")).toHaveLength(1); expect(f.detail.textContent).toBe(""); expect(f.root.textContent).toBe("");
  const count = f.calls.length; await vi.advanceTimersByTimeAsync(10_000); expect(f.calls).toHaveLength(count);
});

import { ShellOldAttempt, type OldAttemptSdk } from "../src/shell-old-attempt.js";
import { parseOldAttemptGrant } from "../src/old-attempt-contract.js";
const predecessor = { status: "active" as const, runtimeId: own.runtimeId, attemptId: own.attemptId, generation: 1, presentationCapability: "q".repeat(43), reconnectTicket: "r".repeat(43) };
function oldGrant(now: number, expiry = now + 300_000) { return { ...controlGrant("bridge-close", now), action: "retire-own-attempt-then-probe-once", expiresAt: new Date(expiry).toISOString() }; }
function oldSdk() {
  const calls: import("../../../packages/core/src/codex-mcp-protocol.js").CodexAppRequest[] = [];
  const call = vi.fn<OldAttemptSdk["call"]>(async request => { calls.push(request); return { _meta: { "placekeeper/response": calls.length === 1 ? { status: "ok", payload: {} } : { status: "denied", reason: "revoked" } } }; });
  return { calls, sdk: { call } };
}
it("old-attempt control rejects foreign/expired/extra metadata and arm alone has no action", () => {
  const now = Date.now(), c = new ShellOldAttempt(), f = oldSdk();
  expect(parseOldAttemptGrant(controlGrant("bridge-close", now), now)).toBeUndefined();
  expect(parseOldAttemptGrant({ ...oldGrant(now), capability: "secret" }, now)).toBeUndefined();
  expect(parseOldAttemptGrant(oldGrant(now, now), now)).toBeUndefined();
  for (const key of Object.keys(own)) expect(c.arm(oldGrant(now), { ...own, [key]: "foreign" }, predecessor)).toBe(false);
  expect(c.arm(oldGrant(now), own, { ...predecessor, attemptId: "attempt-peer" })).toBe(false);
  expect(c.arm(oldGrant(now), own, predecessor)).toBe(true); expect(f.sdk.call).not.toHaveBeenCalled(); c.clear();
});
it("retire invalidates ordinary state before own detach, then explicit one-shot probe denies both old methods without touching a successor", async () => {
  const c = new ShellOldAttempt(), f = oldSdk(), successor = vi.fn(), order: string[] = [];
  c.arm(oldGrant(Date.now()), own, predecessor);
  const originalCall = f.sdk.call; f.sdk.call = vi.fn(async (request, options) => { order.push(request.method); return originalCall(request, options); });
  expect(await c.probe(f.sdk)).toBe(false);
  expect(await c.retire(own, predecessor, f.sdk, () => order.push("stop"))).toBe(true);
  expect(order).toEqual(["stop", "detach"]); expect(c.snapshot()?.phase).toBe("retired");
  expect(await c.retire(own, predecessor, f.sdk, () => order.push("stop"))).toBe(false);
  expect(await c.probe(f.sdk)).toBe(true); expect(await c.probe(f.sdk)).toBe(false);
  expect(f.calls.map(call => call.method)).toEqual(["detach", "renew", "detach"]);
  expect(new Set(f.calls.map(call => call.requestId)).size).toBe(3);
  expect(f.calls.every(call => call.runtimeId === predecessor.runtimeId && call.attemptId === predecessor.attemptId && call.capability === predecessor.presentationCapability)).toBe(true);
  expect(successor).not.toHaveBeenCalled(); expect(c.snapshot()).toMatchObject({ phase: "completed", outcomes: [{ method: "renew", result: "denied", denial: "revoked" }, { method: "detach", result: "denied", denial: "revoked" }] });
  expect(JSON.stringify(c)).toBe("{}"); expect(JSON.stringify(c.snapshot())).not.toMatch(/Capability|capability|qqqqqq|reconnect|payload|requestId/);
});
it("requires successful ordinary detach and reports unexpected probe success honestly", async () => {
  for (const response of [{ status: "denied", reason: "revoked" }, { ...predecessor }, undefined]) {
    const c = new ShellOldAttempt(), call = vi.fn(async () => ({ _meta: { "placekeeper/response": response } })); c.arm(oldGrant(Date.now()), own, predecessor);
    await c.retire(own, predecessor, { call }, () => {}); expect(c.snapshot()?.phase).toBe("failed"); expect(await c.probe({ call })).toBe(false); expect(call).toHaveBeenCalledOnce();
  }
  const c = new ShellOldAttempt(), f = oldSdk(); c.arm(oldGrant(Date.now()), own, predecessor); await c.retire(own, predecessor, f.sdk, () => {});
  f.sdk.call.mockResolvedValue({ _meta: { "placekeeper/response": { status: "ok", payload: { secret: "must-not-render" } } } }); await c.probe(f.sdk);
  expect(c.snapshot()?.outcomes.map(item => item.result)).toEqual(["unexpected-success", "unexpected-success"]); expect(JSON.stringify(c.snapshot())).not.toContain("must-not-render");
});
it("wipes retirement on deadline, cancellation, teardown/disconnect and ignores late probe replies", async () => {
  vi.useFakeTimers();
  for (const phase of ["canceled", "unsupported", "expired"] as const) {
    const c = new ShellOldAttempt(), f = oldSdk(); c.arm(oldGrant(Date.now()), own, predecessor); await c.retire(own, predecessor, f.sdk, () => {});
    if (phase === "expired") await vi.advanceTimersByTimeAsync(120_000); else c.clear(phase);
    expect(c.snapshot()?.phase).toBe(phase); expect(await c.probe(f.sdk)).toBe(false); expect(f.calls).toHaveLength(1);
  }
  const c = new ShellOldAttempt(), f = oldSdk(); c.arm(oldGrant(Date.now()), own, predecessor); await c.retire(own, predecessor, f.sdk, () => {});
  let reply!: (value: unknown) => void; let signal: AbortSignal | undefined;
  f.sdk.call.mockImplementation((_request, options) => { signal = options.signal; return new Promise(resolve => { reply = resolve; }); });
  const pendingProbe = c.probe(f.sdk); await vi.advanceTimersByTimeAsync(5000); expect(signal?.aborted).toBe(true); expect(c.snapshot()?.phase).toBe("failed");
  reply({ _meta: { "placekeeper/response": { status: "ok", payload: { authority: "secret" } } } }); await pendingProbe;
  expect(c.snapshot()?.phase).toBe("failed"); expect(c.snapshot()?.outcomes).toEqual([]); expect(await c.probe(f.sdk)).toBe(false);
});
it("checks grant expiry before each old request and missing retirement replies cannot retain a probe", async () => {
  vi.useFakeTimers();
  const c = new ShellOldAttempt(), f = oldSdk(); c.arm(oldGrant(Date.now(), Date.now() + 500), own, predecessor); await c.retire(own, predecessor, f.sdk, () => {});
  f.sdk.call.mockImplementation(async () => { await vi.advanceTimersByTimeAsync(501); return { _meta: { "placekeeper/response": { status: "denied", reason: "revoked" } } }; });
  await c.probe(f.sdk); expect(f.sdk.call).toHaveBeenCalledTimes(2); expect(c.snapshot()?.phase).toBe("expired");
  const d = new ShellOldAttempt(); d.arm(oldGrant(Date.now()), own, predecessor); let reply!: (value: unknown) => void;
  const retirement = d.retire(own, predecessor, { call: () => new Promise(resolve => { reply = resolve; }) }, () => {});
  await vi.advanceTimersByTimeAsync(5000); expect(d.snapshot()?.phase).toBe("failed"); reply({ _meta: { "placekeeper/response": { status: "ok", payload: {} } } }); await retirement; expect(d.canProbe()).toBe(false);
});
it("actual shell retire keeps bridge open, clears ordinary UI/timers and teardown cannot detach a successor", async () => {
  const f = await qualificationShellFixture(true, "bridge-close", true), retire = f.created.find(item => item.tag === "button")!.element;
  await retire.onclick!(); expect(f.calls.filter(method => method === "detach")).toHaveLength(1); expect(f.detail.textContent).toBe(""); expect(f.root.textContent).toBe("");
  expect(f.app.close).not.toHaveBeenCalled(); expect(f.app.requestTeardown).not.toHaveBeenCalled();
  const probe = f.created.filter(item => item.tag === "button").at(-1)!.element;
  expect(probe.textContent).toContain("probe old attempt"); const count = f.calls.length;
  await vi.advanceTimersByTimeAsync(10_000); expect(f.calls).toHaveLength(count);
  await f.app.onteardown!(); expect(f.calls).toHaveLength(count); expect(probe.removed).toBe(true); await probe.onclick!(); expect(f.calls).toHaveLength(count);
});
it("actual SDK disconnect wipes the old controller and late ordinary/probe replies cannot repopulate UI", async () => {
  const f = await qualificationShellFixture(true, "bridge-close", true);
  let late!: (value: Awaited<ReturnType<typeof f.app.callServerTool>>) => void;
  f.app.callServerTool.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  await vi.advanceTimersByTimeAsync(5000); // One normal renewal is now outstanding.
  const retire = f.created.find(item => item.tag === "button")!.element; await retire.onclick!();
  late({ content: [], _meta: { "placekeeper/response": { status: "ok", payload: { watermark: 1 } } } }); await vi.advanceTimersByTimeAsync(0);
  expect(f.detail.textContent).toBe(""); expect(f.root.textContent).toBe(""); expect(f.renewal.textContent).toBe("Authenticated panel renewal stopped.");
  const probe = f.created.filter(item => item.tag === "button").at(-1)!.element;
  f.app.callServerTool.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
  const operation = probe.onclick!(); f.app.onclose!();
  late({ content: [], _meta: { "placekeeper/response": { status: "ok", payload: { watermark: 1 } } } }); await operation;
  expect(f.detail.textContent).toBe(""); expect(f.root.textContent).toBe(""); expect(f.status.textContent).toContain("unsupported");
  expect(f.created.filter(item => item.tag === "pre").map(item => item.element.textContent).join(" ")).not.toMatch(/Capability|qqqqqq|pppppp|reconnectTicket/);
});
it("mock successor participation remains active when exact predecessor credentials are rejected", async () => {
  const c = new ShellOldAttempt(); c.arm(oldGrant(Date.now()), own, predecessor);
  let current: { attemptId: string; capability: string; active: boolean } = { attemptId: predecessor.attemptId, capability: predecessor.presentationCapability, active: true };
  const sdk: OldAttemptSdk = { call: async request => {
    const matches = request.attemptId === current.attemptId && request.capability === current.capability;
    if (!matches || !current.active) return { _meta: { "placekeeper/response": { status: "denied", reason: "revoked" } } };
    if (request.method === "detach") current.active = false;
    return { _meta: { "placekeeper/response": { status: "ok", payload: {} } } };
  } };
  await c.retire(own, predecessor, sdk, () => {}); expect(current.active).toBe(false);
  current = { attemptId: "attempt-successor", capability: "s".repeat(43), active: true };
  await c.probe(sdk); expect(current).toEqual({ attemptId: "attempt-successor", capability: "s".repeat(43), active: true });
  expect(c.snapshot()?.outcomes.map(item => item.result)).toEqual(["denied", "denied"]);
  expect(c.snapshot()).not.toHaveProperty("actualHost");
});
it("host reuse of a retired shell wipes old authority without accepting a successor invocation", async () => {
  const f = await qualificationShellFixture(true, "bridge-close", true); await f.created.find(item => item.tag === "button")!.element.onclick!();
  const probe = f.created.filter(item => item.tag === "button").at(-1)!.element, count = f.calls.length;
  f.app.ontoolresult!({ _meta: { "placekeeper/pending": { runtimeId: "successor" } } });
  expect(f.status.textContent).toContain("unsupported"); expect(probe.removed).toBe(true); await probe.onclick!();
  await vi.advanceTimersByTimeAsync(5000); expect(f.calls).toHaveLength(count); expect(f.detail.textContent).toBe(""); expect(f.root.textContent).toBe("");
});
it("shared closed grant fields preserve v1 and old action allowlists and timestamp boundaries", () => {
  const now = Date.parse("2026-10-03T12:00:00.000Z");
  const v1 = controlGrant("bridge-close", now), old = oldGrant(now);
  for (const action of ["bridge-close", "request-teardown", "retire-own-attempt-then-probe-once", "unsupported", undefined]) {
    expect(parseQualificationControlGrant({ ...v1, action }, now) !== undefined).toBe(action === "bridge-close" || action === "request-teardown");
    expect(parseOldAttemptGrant({ ...old, action }, now) !== undefined).toBe(action === "retire-own-attempt-then-probe-once");
  }
  for (const [parse, valid] of [[parseQualificationControlGrant, v1], [parseOldAttemptGrant, old]] as const) {
    expect(parse({ ...valid, expiresAt: new Date(now + 30 * 60_000).toISOString() }, now)).toBeDefined();
    for (const invalid of [
      { ...valid, arbitrary: true }, { ...valid, budget: 2 }, { ...valid, version: 2 }, { ...valid, actionId: "invalid" },
      { ...valid, createdAt: new Date(now + 1).toISOString() }, { ...valid, expiresAt: new Date(now).toISOString() },
      { ...valid, expiresAt: new Date(now + 30 * 60_000 + 1).toISOString() }, { ...valid, createdAt: "2026-10-03T12:00:00Z" },
      { ...valid, target: { ...controlTarget, taskSessionId: "untrusted" } },
    ]) expect(parse(invalid, now)).toBeUndefined();
    for (const key of Object.keys(valid)) { const missing = { ...valid } as Record<string, unknown>; delete missing[key]; expect(parse(missing, now)).toBeUndefined(); }
  }
});

it("shell adopts a private successor before invalidation and ignores late predecessor renew/bootstrap replies", async () => {
  const f = await qualificationShellFixture(false);
  const original = f.app.callServerTool.getMockImplementation()!;
  const successor = { status: "active" as const, runtimeId: "runtime-1", attemptId: "attempt-1", generation: 2,
    presentationCapability: "s".repeat(43), reconnectTicket: "r".repeat(43) };
  let finishRenew!: (value: any) => void, finishBootstrap!: (value: any) => void;
  let delayBootstrap = false, handedOff = false;
  const events: import("../../web/src/host/runtime.js").HostRuntimeInvalidation[] = [];
  f.port.subscribeInvalidations(event => events.push(event));
  f.app.callServerTool.mockImplementation(async (input) => {
    const request = input.arguments.request as { method: string; generation: number; capability: string };
    if (request.method === "bootstrap") {
      if (delayBootstrap) return new Promise(resolve => { finishBootstrap = resolve; });
      return { content: [], _meta: { "placekeeper/response": { status: "ok", payload: { sessionId: "canonical-session" } } } };
    }
    if (request.method === "renew" && request.generation === 1) return new Promise(resolve => { finishRenew = resolve; });
    if (request.method === "watermark") {
      const advance = finishRenew !== undefined;
      handedOff ||= advance;
      return { content: [], _meta: { "placekeeper/response": { status: "ok", payload: { watermark: handedOff ? 2 : 1, sessionId: "canonical-session",
        documentGeneration: handedOff ? 2 : 1, reviewRevision: handedOff ? 1 : 0,
        ...(advance && request.generation === 1 ? { presentation: successor } : {}) } } } };
    }
    return original(input);
  });
  delayBootstrap = true;
  const oldBootstrap = f.port.call("bootstrap", {});
  const obsolete = expect(oldBootstrap).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(6000);
  expect(events).toContainEqual({ sessionId: "canonical-session", generation: 2, revision: 1, reason: "generation" });
  const denied = { content: [], _meta: { "placekeeper/response": { status: "denied", reason: "revoked" } } };
  finishBootstrap(denied); finishRenew(denied); await obsolete; await vi.advanceTimersByTimeAsync(0);
  expect(f.root.textContent).toBe("Shared production review mounted");
  expect(f.runtimeDispose).not.toHaveBeenCalled();
  delayBootstrap = false;
  await f.port.call("bootstrap", {});
  const last = f.app.callServerTool.mock.calls.at(-1)![0].arguments.request as unknown as { generation: number; capability: string };
  expect(last).toMatchObject({ generation: 2, capability: successor.presentationCapability });
  await f.app.onteardown!();
});

import { nativeParityChecks, nativeParityCorpus, nativePerformanceMetrics, parityTemplate, validateParityQualification, qualificationMain } from '../../../scripts/qualify-codex-native.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
function completeParity() {
  const report = parityTemplate(); report.status = 'passed';
  report.host = { codexBuild: 'test-build', os: 'test-os', pluginVersion: 'test-version', artifactDigest: 'a'.repeat(64) };
  report.transportGate = { reportPath: 'u3.json', sha256: 'b'.repeat(64), provenance: 'Unit test report; no actual qualification claim' };
  report.checks = nativeParityChecks.map(id => ({ id, result: 'passed', actualHost: id !== 'cross-host-regressions', evidenceScope: id === 'cross-host-regressions' ? 'automated-regression' : 'actual-codex', evidence: 'Unit test evidence shape', observedAt: '2026-10-05T12:00:00Z' }));
  report.corpus = nativeParityCorpus.map(fixture => ({ fixture, sha256: 'c'.repeat(64), result: 'passed', actualHost: true, evidence: 'Unit test evidence shape', observedAt: '2026-10-05T12:00:00Z' }));
  report.performance = nativePerformanceMetrics.map(metric => ({ metric, fixture: 'large-text-heavy.pdf', native: [12, 10, 11], browser: [10, 10, 10], actualHost: true, sameMachine: 'Test fixture machine', evidence: 'Unit test measurements', observedAt: '2026-10-05T12:00:00Z', investigation: '' }));
  return report;
}
it('keeps the U8 parity report separate from U3 and rejects bridge evidence, missing corpus, duplicate checks and incomplete performance', () => {
  expect(validateParityQualification(parityTemplate()).length).toBeGreaterThan(nativeParityChecks.length);
  const report = completeParity(); expect(validateParityQualification(report)).toEqual([]);
  for (const collection of [report.checks, report.corpus, report.performance]) {
    const original = collection[0]!.actualHost; collection[0]!.actualHost = false;
    expect(validateParityQualification(report)).toHaveLength(1); collection[0]!.actualHost = original;
  }
  const regression = report.checks.find(check => check.id === 'cross-host-regressions')!; regression.actualHost = true; expect(validateParityQualification(report)).toHaveLength(1); regression.actualHost = false;
  report.checks.push({ ...report.checks[0]! }); expect(validateParityQualification(report)).toHaveLength(1); report.checks.pop();
  report.corpus.pop(); expect(validateParityQualification(report)).toContain('Missing U8 actual-host corpus evidence: large-text-heavy.pdf');
  const metrics = completeParity(); metrics.performance[0]!.native = [1, 2]; expect(validateParityQualification(metrics)).toHaveLength(1);
  metrics.performance[0]!.native = [1, Number.NaN, 3]; expect(validateParityQualification(metrics)).toHaveLength(1);
  metrics.performance[0]!.native = [21, 22, 23]; expect(validateParityQualification(metrics)).toContain('Native median exceeds twice browser baseline without investigation: large-text-heavy.pdf/first-readable-ms');
  metrics.performance[0]!.investigation = 'Reviewed profiling evidence and accepted bounded host overhead'; expect(validateParityQualification(metrics)).toEqual([]);
});
it('U8 CLI binds its inherited transport gate to the exact report digest and still enforces every U3 actual-host check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'u8-report-'));
  try {
    const parity = completeParity(), gate: NativeQualification = { schemaVersion: 1, status: 'passed', host: parity.host,
      disconnectTimeoutMs: 30000, checks: nativeGateChecks.map(id => ({ id, result: 'passed', actualHost: true, evidence: 'Unit test shape', observedAt: '2026-10-05T12:00:00Z' })) };
    const raw = JSON.stringify(gate); parity.transportGate.sha256 = createHash('sha256').update(raw).digest('hex');
    await writeFile(join(directory, 'u3.json'), raw); await writeFile(join(directory, 'u8.json'), JSON.stringify(parity));
    expect(await qualificationMain(['verify-parity', join(directory, 'u8.json')])).toBe(0);
    await writeFile(join(directory, 'u3.json'), raw + ' '); expect(await qualificationMain(['verify-parity', join(directory, 'u8.json')])).toBe(1);
    gate.checks[0]!.actualHost = false; const invalid = JSON.stringify(gate);
    parity.transportGate.sha256 = createHash('sha256').update(invalid).digest('hex');
    await writeFile(join(directory, 'u3.json'), invalid); await writeFile(join(directory, 'u8.json'), JSON.stringify(parity));
    expect(await qualificationMain(['verify-parity', join(directory, 'u8.json')])).toBe(1);
    expect(await qualificationMain(['init-parity', join(directory, 'template.json')])).toBe(0);
    expect(JSON.parse(await readFile(join(directory, 'template.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, unit: 'U8', status: 'not-run' });
    await expect(qualificationMain(['init-parity', join(directory, 'template.json')])).rejects.toMatchObject({ code: 'EEXIST' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("normal Close review retires local authority before its authenticated detach completes", async () => {
  const f = await qualificationShellFixture(false);
  const gate = Promise.withResolvers<{ content: never[]; _meta: Record<string, unknown> }>();
  f.app.callServerTool.mockImplementationOnce(() => gate.promise);
  expect(f.closeReview.disabled).toBe(false);
  const closing = f.closeReview.onclick!();
  expect(f.root.textContent).toBe(""); expect(f.runtimeDispose).toHaveBeenCalledOnce();
  expect(f.closeReview.disabled).toBe(true);
  const call = f.app.callServerTool.mock.calls.at(-1)![0];
  expect(call.arguments.request).toMatchObject({ method: "detach", runtimeId: "runtime-1", attemptId: "attempt-1", authority: "presentation", generation: 1, capability: "p".repeat(43) });
  const count = f.app.callServerTool.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.app.callServerTool).toHaveBeenCalledTimes(count);
  gate.resolve({ content: [], _meta: { "placekeeper/response": { status: "ok", payload: {} } } });
  await closing; expect(f.status.textContent).toContain("Review closed.");
  expect(f.app.close).not.toHaveBeenCalled(); expect(f.app.requestTeardown).not.toHaveBeenCalled();
});
it("normal Close review reports unconfirmed detach truthfully and never resumes renewal", async () => {
  const f = await qualificationShellFixture(false);
  f.app.callServerTool.mockRejectedValueOnce(new Error("transport failure"));
  await f.closeReview.onclick!();
  expect(f.status.textContent).toContain("service closure could not be confirmed");
  const count = f.app.callServerTool.mock.calls.length; await vi.advanceTimersByTimeAsync(30_000);
  expect(f.app.callServerTool).toHaveBeenCalledTimes(count); expect(f.root.textContent).toBe("");
});

it("normal Close discards an old-attempt grant and gives normal reopen wording on reused invocation", async () => {
  const f = await qualificationShellFixture(true, "bridge-close", true);
  const oldButton = f.created.find(item => item.tag === "button")!.element;
  await f.closeReview.onclick!(); expect(oldButton.removed).toBe(true);
  const count = f.app.callServerTool.mock.calls.length; f.app.ontoolresult!({});
  expect(f.status.textContent).toContain("Review closed. Reopen Placekeeper");
  expect(f.status.textContent).not.toContain("Qualification"); expect(f.app.callServerTool).toHaveBeenCalledTimes(count);
});

it.each(["renew", "watermark"])("late normal %s success after Close cannot restore UI, authority, grants or scheduling", async (method) => {
  const f = await qualificationShellFixture(false);
  const gate = Promise.withResolvers<{ content: never[]; _meta: Record<string, unknown> }>();
  const reached = vi.fn();
  const original = f.app.callServerTool.getMockImplementation()!;
  f.app.callServerTool.mockImplementation(input => {
    if (input.arguments.request.method === method) { reached(); return gate.promise; }
    return original(input);
  });
  await vi.advanceTimersByTimeAsync(method === "renew" ? 5_000 : 1_000);
  expect(reached).toHaveBeenCalledOnce();
  await f.closeReview.onclick!();
  const closed = f.status.textContent;
  const calls = f.app.callServerTool.mock.calls.length;
  gate.resolve({ content: [], _meta: {
    "placekeeper/response": { status: "ok", payload: { watermark: 9, documentGeneration: 2, reviewRevision: 1,
      presentation: { status: "active", runtimeId: "runtime-1", attemptId: "attempt-1", generation: 2, presentationCapability: "s".repeat(43), reconnectTicket: "t".repeat(43) } } },
    "placekeeper/qualification-controls": controlGrant("bridge-close", Date.now()),
    "placekeeper/qualification-old-attempt": oldGrant(Date.now()),
  } });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.status.textContent).toBe(closed);
  expect(f.created.filter(item => item.tag === "button")).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.root.textContent).toBe(""); expect(f.closeReview.disabled).toBe(true);
  expect(f.status.textContent).toBe(closed); expect(f.mount).toHaveBeenCalledOnce();
  expect(f.runtimeDispose).toHaveBeenCalledOnce();
  expect(f.created.filter(item => item.tag === "button")).toHaveLength(0);
  expect(f.app.callServerTool).toHaveBeenCalledTimes(calls);
  await expect(f.port.call("bootstrap", {})).rejects.toThrow("No native presentation");
  expect(f.app.callServerTool).toHaveBeenCalledTimes(calls);
});

import { createReviewState } from "../../../packages/core/src/review-model.js";
it("normal Close owns the sole detach when real Codex runtime presence cleans up during unmount", async () => {
  const f = await qualificationShellFixture(false, "bridge-close", false, true);
  await vi.waitFor(() => expect(f.calls).toContain("presence"));
  let detached = false;
  const original = f.app.callServerTool.getMockImplementation()!;
  f.app.callServerTool.mockImplementation(async input => {
    if (input.arguments.request.method !== "detach") return original(input);
    const response = detached ? { status: "denied", reason: "revoked" } : { status: "ok", payload: {} }; detached = true;
    return { content: [], _meta: { "placekeeper/response": response } };
  });
  await f.closeReview.onclick!();
  expect(f.app.callServerTool.mock.calls.filter(([input]) => input.arguments.request.method === "detach")).toHaveLength(1);
  expect(f.status.textContent).toContain("Review closed.");
  expect(f.root.textContent).toBe(""); expect(f.closeReview.disabled).toBe(true);
  const count = f.app.callServerTool.mock.calls.length; await vi.advanceTimersByTimeAsync(30_000);
  expect(f.app.callServerTool).toHaveBeenCalledTimes(count);
  await expect(f.port.call("bootstrap", {})).rejects.toThrow("No native presentation");
});


it("applies bounded SDK picker deadlines and propagates only closed export conflict without grants", async () => {
  const f = await qualificationShellFixture(false, undefined, false, true);
  await vi.waitFor(() => expect(f.calls).toContain("presence"));
  await f.port.call("chooseFolder", {});
  await f.port.call("locateSave", {});
  for (const method of ["chooseFolder", "locateSave"]) {
    const call = f.app.callServerTool.mock.calls.find(([input]) => input.arguments.request.method === method)!;
    expect(call[1]).toEqual({ timeout: 315_000, maxTotalTimeout: 315_000 });
  }
  const ordinary = f.app.callServerTool.mock.calls.find(([input]) => input.arguments.request.method === "bootstrap")!;
  expect(ordinary[1]).toBeUndefined();
  const grant = controlGrant("bridge-close", Date.now());
  f.app.callServerTool.mockResolvedValueOnce({ content: [], _meta: {
    "placekeeper/response": { status: "operation-error", reason: "export-conflict" },
    "placekeeper/qualification-controls": { ...grant, target: { ...grant.target, runtimeId: f.port.runtimeId } },
  } });
  await expect(f.port.call("exportReviewedCopy", { fence: { expectedRevision: 0, documentGeneration: 1 } })).rejects.toMatchObject({ name: "NativeOperationError", reason: "export-conflict" });
  expect(f.status.textContent).toContain("review ready");
  expect(f.created.filter(item => item.tag === "button")).toHaveLength(0);
});

it("a picker SDK response after normal Close cannot resurrect authority", async () => {
  const f = await qualificationShellFixture(false);
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof f.app.callServerTool>>>();
  f.app.callServerTool.mockImplementationOnce(() => reply.promise);
  const pending = f.port.call("chooseFolder", {}).catch(error => error);
  await f.closeReview.onclick!();
  const closed = f.status.textContent;
  reply.resolve({ content: [], _meta: { "placekeeper/response": { status: "ok", payload: { cancelled: false, selectionId: "late_picker_1234" } } } });
  expect(await pending).toMatchObject({ category: "stale-reply" });
  expect(f.status.textContent).toBe(closed); expect(f.closeReview.disabled).toBe(true);
  await expect(f.port.call("bootstrap", {})).rejects.toThrow("No native presentation");
});
