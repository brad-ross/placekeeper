import { describe, expect, it, vi } from "vitest";
import { ReviewPanelController } from "../src/review-panel-controller.js";

function fakePanel(column = 2) {
  let dispose: (() => void) | undefined;
  return {
    viewColumn: column,
    reveal: vi.fn(),
    onDidDispose(listener: () => void) {
      dispose = listener;
      return { dispose() {} };
    },
    close() { dispose?.(); },
  };
}

describe("review panel controller", () => {
  it("opens beside source once and then reveals the same panel in its current group", async () => {
    const created: ReturnType<typeof fakePanel>[] = [];
    const controller = new ReviewPanelController({
      canonicalize: async (path) => path.toLowerCase(),
      create: vi.fn(async (_binding, column) => {
        expect(column).toBe("beside");
        const panel = fakePanel(2);
        created.push(panel);
        return panel;
      }),
    });

    const first = await controller.open({ outputPath: "/Work/Paper.pdf", sourceRoot: "/Work" });
    created[0]!.viewColumn = 5;
    const repeated = await controller.open({ outputPath: "/work/paper.pdf", sourceRoot: "/Work" });

    expect(repeated).toBe(first);
    expect(created).toHaveLength(1);
    expect(created[0]!.reveal).toHaveBeenCalledWith(5, false);
  });

  it("keeps different canonical outputs independent and detaches on close", async () => {
    const detach = vi.fn();
    const create = vi.fn(async () => fakePanel());
    const controller = new ReviewPanelController({ canonicalize: async (path) => path, create, detach });
    const left = await controller.open({ outputPath: "/a/paper.pdf" });
    await controller.open({ outputPath: "/b/paper.pdf" });
    left.close();
    await controller.open({ outputPath: "/a/paper.pdf" });
    expect(create).toHaveBeenCalledTimes(3);
    expect(detach).toHaveBeenCalledWith("/a/paper.pdf");
  });

  it("shares one in-flight panel creation across concurrent opens", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof fakePanel>>();
    const create = vi.fn(() => pending.promise);
    const controller = new ReviewPanelController({
      canonicalize: async (path) => path.toLowerCase(),
      create,
    });

    const first = controller.open({ outputPath: "/Work/Paper.pdf" });
    const second = controller.open({ outputPath: "/work/paper.pdf" });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    const panel = fakePanel();
    pending.resolve(panel);

    await expect(Promise.all([first, second])).resolves.toEqual([panel, panel]);
    expect(create).toHaveBeenCalledOnce();
  });

  it("restores from an opaque panel key through a fresh attachment", async () => {
    const attachRestored = vi.fn(async () => undefined);
    const controller = new ReviewPanelController({
      canonicalize: async (path) => path,
      create: async () => fakePanel(),
      resolvePanelKey: async (key) => key === "opaque-panel-key" ? { outputPath: "/work/paper.pdf" } : undefined,
      attachRestored,
    });
    const panel = fakePanel(4);
    await expect(controller.restore(panel, { panelKey: "opaque-panel-key", pageIndex: 8, zoom: 1.25 }))
      .resolves.toEqual({ status: "restored", outputPath: "/work/paper.pdf" });
    expect(attachRestored).toHaveBeenCalledWith(panel, { outputPath: "/work/paper.pdf" }, { pageIndex: 8, zoom: 1.25 });
  });

  it("fails closed for malformed, unavailable, and rejected restoration state", async () => {
    const attachRestored = vi.fn(async () => { throw new Error("attachment failed"); });
    const controller = new ReviewPanelController({
      canonicalize: async (path) => path,
      create: async () => fakePanel(),
      resolvePanelKey: async (key) => key === "available-panel-key"
        ? { outputPath: "/work/paper.pdf" }
        : undefined,
      attachRestored,
    });
    const panel = fakePanel();

    await expect(controller.restore(panel, { panelKey: "bad", pageIndex: -1 }))
      .resolves.toEqual({ status: "retry", reason: "panel-state-is-unavailable" });
    await expect(controller.restore(panel, { panelKey: "missing-panel-key" }))
      .resolves.toEqual({ status: "retry", reason: "panel-output-is-unavailable" });
    await expect(controller.restore(panel, { panelKey: "available-panel-key" }))
      .resolves.toEqual({ status: "retry", reason: "panel-reattachment-failed" });
    await expect(controller.panelFor("/work/paper.pdf")).resolves.toBeUndefined();
  });
});
