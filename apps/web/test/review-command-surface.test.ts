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
      handlers: { undo },
    });
    expect(surface.snapshot.commands.find(({ id }) => id === "undo")?.enabled).toBe(false);
    expect(surface.invoke("undo")).toBe(false);
    expect(undo).not.toHaveBeenCalled();
  });
});
