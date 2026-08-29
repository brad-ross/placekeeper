import { describe, expect, it, vi } from "vitest";
import {
  RebuildNavigationCoordinator,
  preferredSavedEditor,
  rebuildNavigationAction,
  type SourceCursorLocation,
} from "../src/rebuild-navigation.js";

function editor(key: string): { readonly key: string; readonly document: { readonly uri: { toString(): string } } } {
  return { key, document: { uri: { toString: () => key } } };
}

const firstLocation: SourceCursorLocation = {
  sourcePath: "/work/paper.tex",
  line: 12,
  column: 4,
};

const latestLocation: SourceCursorLocation = {
  sourcePath: "/work/paper.tex",
  line: 37,
  column: 9,
};

describe("rebuild navigation coordinator", () => {
  it("captures the saved document editor, preferring its active editor", () => {
    const active = editor("file:///work/paper.tex");
    const duplicate = editor("file:///work/paper.tex");
    const other = editor("file:///work/notes.tex");

    expect(preferredSavedEditor(active, [other, duplicate], active.key)).toBe(active);
    expect(preferredSavedEditor(other, [other, duplicate], duplicate.key)).toBe(duplicate);
    expect(preferredSavedEditor(other, [other], duplicate.key)).toBeUndefined();
  });

  it("uses the source cursor captured at save time after a rebuild becomes current", async () => {
    const coordinator = new RebuildNavigationCoordinator();
    const locations: Array<SourceCursorLocation | undefined> = [];
    const reveal = vi.fn(async () => {
      locations.push(coordinator.forwardSourceLocation());
      return "revealed" as const;
    });

    coordinator.noteSourceSaved(firstLocation);

    expect(coordinator.forwardSourceLocation()).toBeUndefined();
    await expect(coordinator.revealAfterRebuild(reveal)).resolves.toBe("revealed");
    expect(reveal).toHaveBeenCalledOnce();
    expect(locations).toEqual([firstLocation]);
    expect(coordinator.forwardSourceLocation()).toBeUndefined();
  });

  it("does not navigate for an external rebuild without a preceding source save", async () => {
    const coordinator = new RebuildNavigationCoordinator();
    const reveal = vi.fn(async () => "revealed" as const);

    await expect(coordinator.revealAfterRebuild(reveal)).resolves.toBe("idle");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("keeps the newest saved cursor and does not consume it with an older in-flight rebuild", async () => {
    const coordinator = new RebuildNavigationCoordinator();
    const firstReveal = Promise.withResolvers<"revealed">();
    const reveal = vi.fn(() => firstReveal.promise);

    coordinator.noteSourceSaved(firstLocation);
    const pendingReveal = coordinator.revealAfterRebuild(reveal);
    expect(coordinator.forwardSourceLocation()).toEqual(firstLocation);

    coordinator.noteSourceSaved(latestLocation);
    expect(coordinator.forwardSourceLocation()).toEqual(firstLocation);
    firstReveal.resolve("revealed");

    await expect(pendingReveal).resolves.toBe("revealed");
    expect(coordinator.forwardSourceLocation()).toBeUndefined();
    await expect(coordinator.revealAfterRebuild(async () => "revealed")).resolves.toBe("revealed");
    expect(coordinator.forwardSourceLocation()).toBeUndefined();
  });

  it("retains the saved cursor when forward SyncTeX is not ready yet", async () => {
    const coordinator = new RebuildNavigationCoordinator();
    coordinator.noteSourceSaved(firstLocation);

    await expect(coordinator.revealAfterRebuild(async () => "retry")).resolves.toBe("retry");
    expect(coordinator.hasPending).toBe(true);
    expect(coordinator.canRetryCurrent).toBe(true);
  });

  it("does not let an idle automatic intent override an explicit forward location", () => {
    const coordinator = new RebuildNavigationCoordinator();
    coordinator.noteSourceSaved(firstLocation);

    expect(coordinator.forwardSourceLocation(() => latestLocation)).toEqual(latestLocation);
  });

  it("drains a newer ready rebuild after the active navigation settles", async () => {
    const coordinator = new RebuildNavigationCoordinator();
    const firstReveal = Promise.withResolvers<"revealed">();
    const seen: SourceCursorLocation[] = [];
    const reveal = vi.fn(async () => {
      seen.push(coordinator.forwardSourceLocation()!);
      return seen.length === 1 ? firstReveal.promise : "revealed" as const;
    });

    coordinator.noteSourceSaved(firstLocation);
    const first = coordinator.revealAfterRebuild(reveal);
    coordinator.noteSourceSaved(latestLocation);
    const second = coordinator.revealAfterRebuild(reveal);
    firstReveal.resolve("revealed");

    await expect(first).resolves.toBe("revealed");
    await expect(second).resolves.toBe("revealed");
    expect(seen).toEqual([firstLocation, latestLocation]);
    expect(reveal).toHaveBeenCalledTimes(2);
    expect(coordinator.hasPending).toBe(false);
  });

  it("retires a terminal SyncTeX result instead of retrying forever", async () => {
    const coordinator = new RebuildNavigationCoordinator();
    coordinator.noteSourceSaved(firstLocation);

    await expect(coordinator.revealAfterRebuild(async () => "terminal")).resolves.toBe("terminal");
    expect(coordinator.hasPending).toBe(false);
    expect(coordinator.canRetryCurrent).toBe(false);
  });

  it("gates validation results by rebuild evidence and sidecar retry state", () => {
    expect(rebuildNavigationAction("same-digest", "activation", false)).toBe("ignore");
    expect(rebuildNavigationAction("same-digest", "reveal", false)).toBe("ignore");
    expect(rebuildNavigationAction("same-digest", "interval", false)).toBe("ignore");
    expect(rebuildNavigationAction("same-digest", "watcher", false)).toBe("navigate");
    expect(rebuildNavigationAction("same-digest", "activation", true)).toBe("navigate");
    expect(rebuildNavigationAction("committed", "watcher", false)).toBe("navigate");
    expect(rebuildNavigationAction("invalid", "watcher", false)).toBe("ignore");
  });
});
