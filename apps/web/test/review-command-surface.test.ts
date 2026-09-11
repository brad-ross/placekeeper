import { describe, expect, it, vi } from "vitest";

import { createReviewCommandSurface } from "../src/review/review-command-surface.js";

describe("shared semantic review command surface", () => {
  it("publishes only primitive presentation state and invokes one authorized handler", () => {
    const undo = vi.fn();
    const surface = createReviewCommandSurface({
      focusContext: "review",
      canUndo: true,
      canRedo: false,
      canNavigateBack: true,
      canNavigateForward: false,
      canFind: true,
      canOpenAnnotations: true,
      canOpenSaveOptions: false,
      canFitWidth: true,
      canZoom: true,
      handlers: { undo },
    });
    expect({ ...surface.snapshot, commands: surface.snapshot.commands.slice(0, 2) }).toMatchObject({
      focusContext: "review",
      commands: [
        { id: "undo", enabled: true },
        { id: "redo", enabled: false },
      ],
    });
    expect(surface.invoke("undo")).toBe(true);
    expect(surface.invoke("redo")).toBe(false);
    expect(undo).toHaveBeenCalledOnce();
    expect(surface.snapshot.commands.find(({ id }) => id === "save-options")?.shortcut).toBeUndefined();
    expect(JSON.parse(JSON.stringify(surface.snapshot))).toEqual(surface.snapshot);
  });

  it("preserves Cocoa text ownership for undo and redo in editable focus", () => {
    const undo = vi.fn();
    const surface = createReviewCommandSurface({
      focusContext: "editable",
      canUndo: true,
      canRedo: true,
      canNavigateBack: false,
      canNavigateForward: false,
      canFind: true,
      canOpenAnnotations: true,
      canOpenSaveOptions: true,
      canFitWidth: true,
      canZoom: true,
      handlers: { undo },
    });
    expect(surface.snapshot.commands.find(({ id }) => id === "undo")?.enabled).toBe(false);
    expect(surface.invoke("undo")).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});

it.each(["review", "editable", "dialog"] as const)("gates PDF zoom with readiness and dialog policy in %s focus", (focusContext) => {
  for (const ready of [false, true]) {
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const surface = createReviewCommandSurface({
      focusContext, canUndo: false, canRedo: false, canNavigateBack: false,
      canNavigateForward: false, canFind: false, canOpenAnnotations: false,
      canOpenSaveOptions: false, canFitWidth: ready, canZoom: ready,
      handlers: { "zoom-in": zoomIn, "zoom-out": zoomOut },
    });
    const enabled = ready && focusContext !== "dialog";
    expect(surface.snapshot.commands.filter(({ id }) => id.startsWith("zoom-"))).toEqual([
      { id: "zoom-in", label: "Zoom In PDF", enabled, shortcut: "Meta+=" },
      { id: "zoom-out", label: "Zoom Out PDF", enabled, shortcut: "Meta+-" },
    ]);
    expect(surface.invoke("zoom-in")).toBe(enabled);
    expect(surface.invoke("zoom-out")).toBe(enabled);
    expect(zoomIn).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(zoomOut).toHaveBeenCalledTimes(enabled ? 1 : 0);
  }
});
