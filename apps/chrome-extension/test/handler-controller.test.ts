import { describe, expect, it, vi } from "vitest";
import { createHandlerController, HandoffError } from "../src/handler-controller.js";

const streamInfo = {
  originalUrl: "https://papers.example.test/download?id=42",
  streamUrl: "blob:chrome-extension-stream",
  tabId: 42,
  embedded: false,
};

describe("Chrome PDF handler controller", () => {
  it("fails closed before install-time option synchronization", async () => {
    const fallback = vi.fn();
    const handoff = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => false,
      getStreamInfo: async () => streamInfo,
      handoff,
      fallback,
      replace: vi.fn(),
    });

    await controller.run();

    expect(handoff).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("replaces the handler once for a valid transfer-bound destination", async () => {
    const replace = vi.fn();
    const fallback = vi.fn();
    const destination =
      "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123";
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => ({ destination }),
      fallback,
      replace,
    });

    await controller.run();

    expect(replace).toHaveBeenCalledExactlyOnceWith(streamInfo.tabId, destination);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    { tabId: -1, embedded: false },
    { tabId: 1.5, embedded: false },
    { tabId: Number.NaN, embedded: false },
    { tabId: 42, embedded: true },
    { tabId: 42, embedded: undefined },
    { tabId: 42, embedded: null },
    { tabId: 42, embedded: 0 },
  ])("falls back instead of navigating a non-top-level MIME handler: %o", async (context) => {
    const fallback = vi.fn();
    const replace = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => ({ ...streamInfo, ...context }),
      handoff: vi.fn(),
      fallback,
      replace,
    });

    await controller.run();

    expect(replace).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("falls back when Chrome rejects the top-level tab navigation", async () => {
    const fallback = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => ({
        destination:
          "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
      }),
      fallback,
      replace: async () => { throw new Error("tab-navigation-rejected"); },
    });

    await controller.run();

    expect(fallback).toHaveBeenCalledOnce();
    expect(controller.state()).toBe("fallback");
  });

  it("ignores bypass after top-level tab navigation starts", async () => {
    let resolveReplace!: () => void;
    const replace = vi.fn(async () => new Promise<void>((resolve) => {
      resolveReplace = resolve;
    }));
    const fallback = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => ({
        destination:
          "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
      }),
      fallback,
      replace,
    });

    const run = controller.run();
    await vi.waitFor(() => expect(controller.state()).toBe("replacing"));
    controller.bypass();
    resolveReplace();
    await run;

    expect(replace).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(controller.state()).toBe("replaced");
  });

  it.each([
    "https://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
    "http://localhost:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
    "http://127.0.0.1:43179/s/not-a-uuid/bootstrap#cap=1234567890123456789012345678901234567890123",
    "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap?leak=yes#cap=1234567890123456789012345678901234567890123",
    "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=short",
  ])("rejects an evil or ambiguous destination: %s", async (destination) => {
    const replace = vi.fn();
    const fallback = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => ({ destination }),
      fallback,
      replace,
    });

    await controller.run();

    expect(replace).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("makes bypass terminal and discards a late success", async () => {
    let resolveHandoff!: (value: { destination: string }) => void;
    const handoff = new Promise<{ destination: string }>((resolve) => {
      resolveHandoff = resolve;
    });
    const fallback = vi.fn();
    const replace = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => handoff,
      fallback,
      replace,
    });

    const run = controller.run();
    await vi.waitFor(() => expect(controller.state()).toBe("pending"));
    controller.bypass();
    resolveHandoff({
      destination:
        "http://127.0.0.1:43179/s/779e1d9d-58c1-4b12-8dc2-3449dad132c1/bootstrap#cap=1234567890123456789012345678901234567890123",
    });
    await run;

    expect(fallback).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
  });

  it("falls back once for missing stream info and duplicate terminal calls", async () => {
    const fallback = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => undefined,
      handoff: vi.fn(),
      fallback,
      replace: vi.fn(),
    });

    await controller.run();
    controller.bypass();

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("delegates a stream-network failure to Chrome's native handler", async () => {
    const fallback = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => { throw new HandoffError("stream-network-error"); },
      fallback,
      replace: vi.fn(),
    });

    await controller.run();

    expect(fallback).toHaveBeenCalledOnce();
    expect(controller.state()).toBe("fallback");
  });

  it("falls back exactly once when the registered native host is disabled", async () => {
    const fallback = vi.fn();
    const controller = createHandlerController({
      isOptedIn: async () => true,
      getStreamInfo: async () => streamInfo,
      handoff: async () => { throw new HandoffError("native-disconnected"); },
      fallback,
      replace: vi.fn(),
    });

    await controller.run();
    controller.bypass();

    expect(fallback).toHaveBeenCalledOnce();
    expect(controller.state()).toBe("fallback");
  });
});
