import { describe, expect, it, vi } from "vitest";
import {
  createHandlerController,
  type EmbeddedReviewSession,
} from "../src/handler-controller.js";

const streamInfo = {
  originalUrl: "https://papers.example.test/download?id=42",
  streamUrl: "blob:chrome-extension-stream",
  tabId: 42,
  embedded: false,
};

function reviewSession(overrides: Partial<EmbeddedReviewSession> = {}): EmbeddedReviewSession {
  return {
    displayName: "Paper.pdf",
    mountAndValidate: vi.fn(async () => undefined),
    activate: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribeLifecycle: vi.fn(() => () => undefined),
    ...overrides,
  };
}

function controllerPorts(overrides: Partial<Parameters<typeof createHandlerController>[0]> = {}) {
  return {
    isOptedIn: async () => true,
    getStreamInfo: async () => streamInfo,
    openEmbedded: vi.fn(async () => reviewSession()),
    fallback: vi.fn(),
    ...overrides,
  };
}

describe("Chrome PDF handler controller", () => {
  it("mounts and validates before activation without replacing the PDF URL", async () => {
    const order: string[] = [];
    const review = reviewSession({
      mountAndValidate: vi.fn(async () => { order.push("document-ready"); }),
      activate: vi.fn(async () => { order.push("active"); }),
    });
    const ports = controllerPorts({ openEmbedded: vi.fn(async () => review) });
    const controller = createHandlerController(ports);

    await controller.run();

    expect(order).toEqual(["document-ready", "active"]);
    expect(controller.state()).toBe("active");
    expect(ports.fallback).not.toHaveBeenCalled();
    expect(review.release).not.toHaveBeenCalled();
    expect(review.dispose).not.toHaveBeenCalled();
  });

  it.each(["acquire", "mount", "activate"] as const)(
    "releases provisional state and falls back once when embedded %s fails",
    async (failure) => {
      const review = reviewSession({
        mountAndValidate: vi.fn(async () => {
          if (failure === "mount") throw new Error("document-invalid");
        }),
        activate: vi.fn(async () => {
          if (failure === "activate") throw new Error("activation-rejected");
        }),
      });
      const ports = controllerPorts({
        openEmbedded: vi.fn(async () => {
          if (failure === "acquire") throw new Error("native-unavailable");
          return review;
        }),
      });
      const controller = createHandlerController(ports);

      await controller.run();
      controller.bypass();

      expect(ports.fallback).toHaveBeenCalledOnce();
      if (failure === "acquire") expect(review.release).not.toHaveBeenCalled();
      else expect(review.release).toHaveBeenCalledOnce();
      if (failure === "mount") expect(review.activate).not.toHaveBeenCalled();
    },
  );

  it("never falls back after activation and exposes a protected disconnect state", async () => {
    let lifecycle!: (event: { readonly type: "disconnected"; readonly protected: boolean }) => void;
    const review = reviewSession({
      subscribeLifecycle: vi.fn((listener) => {
        lifecycle = listener;
        return () => undefined;
      }),
    });
    const ports = controllerPorts({ openEmbedded: vi.fn(async () => review) });
    const controller = createHandlerController(ports);

    await controller.run();
    lifecycle({ type: "disconnected", protected: true });
    controller.bypass();

    expect(controller.state()).toBe("disconnected-protected");
    expect(ports.fallback).not.toHaveBeenCalled();
  });

  it("keeps update-required state protected and never invokes Chrome fallback", async () => {
    let lifecycle!: (event: { readonly type: "update-required"; readonly protected: boolean }) => void;
    const status = vi.fn();
    const review = reviewSession({
      subscribeLifecycle: vi.fn((listener) => {
        lifecycle = listener;
        return () => undefined;
      }),
    });
    const ports = controllerPorts({ openEmbedded: vi.fn(async () => review), status });
    const controller = createHandlerController(ports);

    await controller.run();
    lifecycle({ type: "update-required", protected: true });
    controller.bypass();

    expect(controller.state()).toBe("update-required");
    expect(status).toHaveBeenLastCalledWith(
      "Placekeeper needs to be updated before this protected review can reopen.",
    );
    expect(ports.fallback).not.toHaveBeenCalled();
  });

  it("releases and disposes before falling back when bypass interrupts mounting", async () => {
    let rejectMount!: (error: Error) => void;
    const mounted = new Promise<void>((_resolve, reject) => { rejectMount = reject; });
    const order: string[] = [];
    const review = reviewSession({
      mountAndValidate: vi.fn(async () => mounted),
      release: vi.fn(async () => { order.push("release"); }),
      dispose: vi.fn(() => { order.push("dispose"); }),
    });
    const ports = controllerPorts({
      openEmbedded: vi.fn(async () => review),
      fallback: vi.fn(() => { order.push("fallback"); }),
    });
    const controller = createHandlerController(ports);

    const run = controller.run();
    await vi.waitFor(() => expect(controller.state()).toBe("mounting"));
    controller.bypass();
    rejectMount(new Error("bypassed"));
    await run;

    expect(order).toEqual(["release", "dispose", "fallback"]);
    expect(review.activate).not.toHaveBeenCalled();
  });

  it("fails closed before install-time option synchronization", async () => {
    const ports = controllerPorts({ isOptedIn: async () => false });
    const controller = createHandlerController(ports);

    await controller.run();

    expect(ports.openEmbedded).not.toHaveBeenCalled();
    expect(ports.fallback).toHaveBeenCalledOnce();
  });

  it.each([
    { tabId: -1, embedded: false },
    { tabId: 1.5, embedded: false },
    { tabId: Number.NaN, embedded: false },
    { tabId: 42, embedded: true },
    { tabId: 42, embedded: undefined },
    { tabId: 42, embedded: null },
    { tabId: 42, embedded: 0 },
  ])("falls back instead of claiming a non-top-level MIME handler: %o", async (context) => {
    const ports = controllerPorts({ getStreamInfo: async () => ({ ...streamInfo, ...context }) });
    const controller = createHandlerController(ports);

    await controller.run();

    expect(ports.openEmbedded).not.toHaveBeenCalled();
    expect(ports.fallback).toHaveBeenCalledOnce();
  });

  it("falls back once for missing stream info and duplicate terminal calls", async () => {
    const ports = controllerPorts({ getStreamInfo: async () => undefined });
    const controller = createHandlerController(ports);

    await controller.run();
    controller.bypass();

    expect(ports.fallback).toHaveBeenCalledOnce();
  });

  it("falls back exactly once when the registered native host is unavailable", async () => {
    const ports = controllerPorts({
      openEmbedded: vi.fn(async () => { throw new Error("native-disconnected"); }),
    });
    const controller = createHandlerController(ports);

    await controller.run();
    controller.bypass();

    expect(ports.fallback).toHaveBeenCalledOnce();
    expect(controller.state()).toBe("fallback");
  });
});
