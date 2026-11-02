import { describe, expect, it, vi } from "vitest";
import { nativeSyncTexResponse } from "../../../packages/core/src/native-synctex-protocol.js";
import { reverseSyncTexError } from "../../web/src/host/synctex-navigation.js";
import { NativeSyncTex } from "../src/synctex/native-synctex.js";
import type { SessionBroker } from "../src/sessions/session-broker.js";
import type { EditorNavigation, NativeEditorIntent } from "../src/synctex/editor-navigation.js";

function fixture() {
  const intent = { sequence: 1, association: "association", registration: { sourceRoot: "/project" },
    request: { operation: "forward", sourcePath: "/project/main.tex", line: 5 } } as NativeEditorIntent;
  let current: NativeEditorIntent | undefined = intent;
  let generation = 1;
  const registry = { intentForHelper: () => current, isCurrent: (value: NativeEditorIntent) => current === value,
    complete: vi.fn(), interruptFollowing: vi.fn() } as unknown as EditorNavigation;
  const forward = vi.fn(async () => ({ status: "ok", documentGeneration: generation, target: { pageIndex: 0, x: 10, y: 20 } }));
  const reverse = vi.fn(async () => ({ status: "ok", documentGeneration: generation, target: { path: "main.tex", line: 5 } }));
  const broker = { createNavigationAttachment: async () => "attachment", revokeNavigationAttachment: vi.fn(),
    state: () => ({ workflow: { documentGeneration: generation } }), forwardSyncTex: forward, reverseSyncTex: reverse } as unknown as SessionBroker;
  const dispatch = vi.fn(async (_registration, _target, options) => options.isCurrent()
    ? { status: "opened" as const } : { status: "stale" as const, reason: "stale" });
  const controller = new NativeSyncTex(broker, registry, { dispatch });
  return { controller, registry, forward, reverse, dispatch, intent,
    replace: () => { current = { ...intent, sequence: 2 }; }, detach: () => { current = undefined; },
    rebuild: () => { generation++; } };
}
describe("native presentation SyncTeX", () => {
  it.each([
    ["editor-executable-unavailable", "editor-unavailable", "Reopen it"],
    ["neovim-session-unavailable", "editor-unavailable", "Neovim socket"],
    ["neovim-refused-navigation", "editor-refused", "modified buffers"],
    ["editor-timeout", "editor-timeout", "did not respond"],
    ["unsupported-editor-location-path", "editor-location-unsupported", "separate argument"],
    ["editor-exited-1", "editor-failed", "profile and source file"],
  ])("preserves actionable dispatch failure %s through the native boundary", async (reason, category, message) => {
    const f = fixture();
    f.dispatch.mockResolvedValueOnce({ status: "failed", reason } as never);
    const result = nativeSyncTexResponse("reverseSyncTex", await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } }));
    expect(result).toEqual({ status: "failed", reason: category });
    expect(reverseSyncTexError(result)).toContain(message);
  });
  it("rejects a reverse point from an older displayed generation before querying", async () => {
    const f = fixture();
    f.rebuild();
    expect(await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } })).toEqual({ status: "stale" });
    expect(f.reverse).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("rejects a reverse result that does not match the displayed generation", async () => {
    const f = fixture();
    f.reverse.mockResolvedValueOnce({ status: "ok", documentGeneration: 2, target: { path: "main.tex", line: 5 } });
    expect(await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } })).toEqual({ status: "stale" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("retires an in-flight forward when reverse navigation is requested", async () => {
    const f = fixture();
    const result = Promise.withResolvers<Awaited<ReturnType<typeof f.forward>>>();
    f.forward.mockReturnValueOnce(result.promise);
    const pending = f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "poll" });
    await vi.waitFor(() => expect(f.forward).toHaveBeenCalled());
    await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } });
    result.resolve({ status: "ok", documentGeneration: 1, target: { pageIndex: 1, x: 10, y: 20 } });
    expect(await pending).toEqual({ status: "idle" });
    expect(await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "poll" })).toEqual({ status: "idle" });
  });
  it("rejects an older reverse action that finishes after a newer one", async () => {
    const f = fixture();
    const result = Promise.withResolvers<Awaited<ReturnType<typeof f.reverse>>>();
    f.reverse.mockReturnValueOnce(result.promise);
    const first = f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } });
    await vi.waitFor(() => expect(f.reverse).toHaveBeenCalled());
    expect(await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 1, point: { x: 0, y: 0 } })).toEqual({ status: "opened" });
    result.resolve({ status: "ok", documentGeneration: 1, target: { path: "main.tex", line: 1 } });
    expect(await first).toEqual({ status: "stale" });
    expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 0, 4])("normalizes SyncTeX column %s for the one-based editor boundary", async column => {
    const f = fixture();
    f.reverse.mockResolvedValueOnce({ status: "ok", documentGeneration: 1, target: { path: "main.tex", line: 5, ...(column === undefined ? {} : { column }) } });
    await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } });
    expect(f.dispatch).toHaveBeenCalledWith(expect.anything(), { path: "main.tex", line: 5, column: column === undefined ? 1 : column + 1 }, expect.anything());
  });
  it("waits for a matching generation, then completes only on the matching viewer acknowledgement", async () => {
    const f = fixture();
    f.forward.mockResolvedValueOnce({ status: "pending" } as never);
    expect(await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "poll" })).toMatchObject({ status: "pending" });
    expect(await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "poll" })).toMatchObject({ status: "ready", sequence: 1, generation: 1, pageIndex: 0 });
    await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "ack", sequence: 2, generation: 1, outcome: "applied" });
    expect(f.registry.complete).not.toHaveBeenCalled();
    await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "ack", sequence: 1, generation: 1, outcome: "applied" });
    expect(f.registry.complete).toHaveBeenCalledWith(f.intent);
    expect(await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "poll" })).toMatchObject({ status: "applied" });
  });
  it("rejects late forward results after takeover and reverse dispatch after a rebuild", async () => {
    const f = fixture();
    f.forward.mockImplementationOnce(async () => { f.replace(); return { status: "ok", documentGeneration: 1, target: { pageIndex: 0, x: 0, y: 0 } }; });
    expect(await f.controller.invoke("helper", "session", 1, "forwardSyncTex", { action: "poll" })).toEqual({ status: "idle" });
    f.reverse.mockImplementationOnce(async () => { f.rebuild(); return { status: "ok", documentGeneration: 1, target: { path: "main.tex", line: 1 } }; });
    expect(await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } })).toMatchObject({ status: "stale" });
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not expose source paths and requires setup without a bound editor", async () => {
    const f = fixture();
    expect(await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } })).toEqual({ status: "opened" });
    f.detach();
    expect(await f.controller.invoke("helper", "session", 1, "reverseSyncTex", { pageIndex: 0, point: { x: 0, y: 0 } })).toEqual({ status: "setup-required" });
  });
});
