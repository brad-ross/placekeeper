import { describe, expect, it, vi } from "vitest";

import { ReviewInteractions } from "../src/sessions/review-interactions.js";

describe("broker-owned review interactions", () => {
  it("defers for every attachment until the last explicit release without an inactivity timeout", async () => {
    let generation = 1;
    const wake = vi.fn();
    const interactions = new ReviewInteractions({
      currentGeneration: () => generation,
      onLastRelease: wake,
    });
    const first = interactions.register("review-a", "browser-view-a");
    const second = interactions.register("review-a", "vscode-panel-b");

    await expect(interactions.begin({ ...first, generation: 1, interactionToken: "interaction_first_1", order: 1 }))
      .resolves.toMatchObject({ status: "accepted", generation: 1 });
    await expect(interactions.begin({ ...second, generation: 1, interactionToken: "interaction_second_1", order: 1 }))
      .resolves.toMatchObject({ status: "accepted", generation: 1 });
    expect(interactions.held("review-a")).toBe(true);

    // Passage of time is intentionally irrelevant: only lifecycle operations release a hold.
    await interactions.release({ ...first, interactionToken: "interaction_first_1", order: 2 });
    expect(interactions.held("review-a")).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    await interactions.release({ ...second, interactionToken: "interaction_second_1", order: 2 });
    expect(interactions.held("review-a")).toBe(false);
    expect(wake).toHaveBeenCalledWith("review-a");

    generation = 2;
    const stale = await interactions.begin({ ...first, generation: 1, interactionToken: "interaction_stale_1", order: 3 });
    expect(stale).toMatchObject({ status: "stale", generation: 2 });
  });

  it("rejects forged, cross-attachment, revoked, and delayed lifecycle operations", async () => {
    const interactions = new ReviewInteractions({ currentGeneration: () => 1 });
    const current = interactions.register("review-a", "browser-view-a");
    const other = interactions.register("review-a", "browser-view-b");
    await interactions.begin({ ...current, generation: 1, interactionToken: "interaction_current_1", order: 1 });

    await expect(interactions.release({ ...current, capability: "forged_capability", interactionToken: "interaction_current_1", order: 2 }))
      .resolves.toMatchObject({ status: "unauthorized" });
    await expect(interactions.release({ ...other, interactionToken: "interaction_current_1", order: 1 }))
      .resolves.toMatchObject({ status: "missing" });

    const replacement = interactions.register("review-a", "browser-view-a");
    await interactions.begin({ ...replacement, generation: 1, interactionToken: "interaction_new_1", order: 1 });
    interactions.disconnect(current.attachmentId, current.incarnationId);
    expect(interactions.held("review-a")).toBe(true);
    await expect(interactions.release({ ...current, interactionToken: "interaction_current_1", order: 2 }))
      .resolves.toMatchObject({ status: "unauthorized" });
  });

  it("fences a delayed begin after authenticated cleanup reports the hold missing", async () => {
    const interactions = new ReviewInteractions({
      currentGeneration: () => 1,
      maxTerminalFences: 1,
    });
    const attachment = interactions.register("review-a", "browser-view-a");

    await expect(interactions.release({
      ...attachment,
      interactionToken: "interaction_missing_first_1",
      order: 2,
    })).resolves.toMatchObject({ status: "missing" });
    await expect(interactions.release({
      ...attachment,
      interactionToken: "interaction_missing_second_1",
      order: 3,
    })).resolves.toMatchObject({ status: "missing" });

    await expect(interactions.begin({
      ...attachment,
      generation: 1,
      interactionToken: "interaction_missing_first_1",
      order: 1,
    })).resolves.toMatchObject({ status: "out-of-order" });
    expect(interactions.held("review-a")).toBe(false);

    await expect(interactions.begin({
      ...attachment,
      generation: 1,
      interactionToken: "interaction_missing_first_1",
      order: 4,
    })).resolves.toMatchObject({ status: "accepted" });
  });

  it("does not let an unauthenticated cleanup fence a live incarnation", async () => {
    const interactions = new ReviewInteractions({ currentGeneration: () => 1 });
    const attachment = interactions.register("review-a", "browser-view-a");

    await expect(interactions.release({
      ...attachment,
      capability: "forged_capability",
      interactionToken: "interaction_untrusted_cleanup_1",
      order: 2,
    })).resolves.toMatchObject({ status: "unauthorized" });
    await expect(interactions.begin({
      ...attachment,
      generation: 1,
      interactionToken: "interaction_untrusted_cleanup_1",
      order: 1,
    })).resolves.toMatchObject({ status: "accepted" });
  });

  it("persists a finalize receipt before releasing and replays it after reconnect", async () => {
    const persisted: unknown[] = [];
    const interactions = new ReviewInteractions({
      currentGeneration: () => 1,
      persistReceipt: async (receipt) => { persisted.push(receipt); },
      maxPendingReceipts: 1,
    });
    const first = interactions.register("review-a", "browser-view-a");
    await interactions.begin({ ...first, generation: 1, interactionToken: "interaction_first_1", order: 1 });
    const finalized = await interactions.finalize({
      ...first,
      interactionToken: "interaction_first_1",
      order: 2,
      outcome: "applied",
      reviewRevision: 4,
    });
    expect(finalized).toMatchObject({ status: "finalized", outcome: "applied", reviewRevision: 4 });
    expect(persisted).toHaveLength(1);
    expect(interactions.held("review-a")).toBe(false);

    const reconnect = interactions.register("review-a", "browser-view-a");
    await expect(interactions.finalize({
      ...reconnect,
      interactionToken: "interaction_first_1",
      order: 1,
      outcome: "applied",
      reviewRevision: 999,
    })).resolves.toEqual(finalized);

    const restarted = new ReviewInteractions({ currentGeneration: () => 2 });
    restarted.hydrate(persisted as Parameters<typeof restarted.hydrate>[0]);
    const restoredAttachment = restarted.register("review-a", "browser-view-a");
    await expect(restarted.finalize({
      ...restoredAttachment,
      interactionToken: "interaction_first_1",
      order: 1,
      outcome: "applied",
      reviewRevision: 999,
    })).resolves.toEqual(finalized);

    await interactions.begin({ ...reconnect, generation: 1, interactionToken: "interaction_second_1", order: 2 });
    await expect(interactions.finalize({
      ...reconnect,
      interactionToken: "interaction_second_1",
      order: 3,
      outcome: "discarded",
      reviewRevision: 4,
    })).resolves.toMatchObject({ status: "backpressure" });
    expect(interactions.held("review-a")).toBe(true);
    await expect(interactions.acknowledge({
      ...reconnect,
      interactionToken: "interaction_first_1",
      order: 4,
    })).resolves.toMatchObject({ status: "released" });
    await expect(interactions.finalize({
      ...reconnect,
      interactionToken: "interaction_second_1",
      order: 3,
      outcome: "discarded",
      reviewRevision: 4,
    })).resolves.toMatchObject({ status: "finalized", outcome: "discarded" });
  });

  it("retains the hold when atomic state-and-receipt persistence fails", async () => {
    const interactions = new ReviewInteractions({ currentGeneration: () => 1 });
    const attachment = interactions.register("review-a", "browser-view-a");
    await interactions.begin({ ...attachment, generation: 1, interactionToken: "interaction_failure_1", order: 1 });
    await expect(interactions.finalize({
      ...attachment,
      interactionToken: "interaction_failure_1",
      order: 2,
      outcome: "applied",
      commit: async () => ({
        reviewRevision: 1,
        persist: async () => { throw new Error("disk-failure"); },
      }),
    })).rejects.toThrow("disk-failure");
    expect(interactions.held("review-a")).toBe(true);
    await expect(interactions.release({ ...attachment, interactionToken: "interaction_failure_1", order: 2 }))
      .resolves.toMatchObject({ status: "released" });
  });

  it("orders active-token terminals independently after attachment admission", async () => {
    const interactions = new ReviewInteractions({ currentGeneration: () => 1 });
    const attachment = interactions.register("review-a", "browser-view-a");
    await expect(interactions.begin({
      ...attachment, generation: 1, interactionToken: "interaction_first_1", order: 1,
    })).resolves.toMatchObject({ status: "accepted" });
    await expect(interactions.begin({
      ...attachment, generation: 1, interactionToken: "interaction_second_1", order: 2,
    })).resolves.toMatchObject({ status: "accepted" });
    await expect(interactions.release({
      ...attachment, interactionToken: "interaction_second_1", order: 4,
    })).resolves.toMatchObject({ status: "released" });
    await expect(interactions.finalize({
      ...attachment,
      interactionToken: "interaction_first_1",
      order: 3,
      outcome: "applied",
      commit: async () => 1,
    })).resolves.toMatchObject({ status: "finalized", reviewRevision: 1 });
    expect(interactions.held("review-a")).toBe(false);
  });
});
