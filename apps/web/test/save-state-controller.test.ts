import { describe, expect, it } from "vitest";

import { createReviewState, type ReviewCommand } from "../../../packages/core/src/review-model.js";
import type { SaveStatus } from "../../../packages/core/src/save-status.js";
import {
  gateReviewCommand,
  pollSaveStatusUntilSettled,
} from "../src/save/save-state-controller.js";

const state = createReviewState({
  sessionId: "session",
  source: { fileId: "file", digest: "a".repeat(64), byteLength: 1 },
});
const unselected = {
  destination: { phase: "none" as const, generation: 0 as const },
  sync: { phase: "clean" as const, desiredRevision: 0, savedRevision: 0 },
};

describe("first annotation save gate", () => {
  it.each(["replace", "delete", "insert", "highlight", "pageNote"] as const)(
    "holds the first %s annotation until a destination is established",
    (kind) => {
      const command: ReviewCommand = {
        type: "add",
        expectedRevision: 0,
        item: {
          id: `${kind}-id`,
          kind,
          pageIndex: 0,
          createdAt: "2026-08-11T12:00:00.000Z",
          updatedAt: "2026-08-11T12:00:00.000Z",
          payload: {},
        },
      };
      expect(gateReviewCommand(state, unselected, command, "local")).toEqual({
        kind: "choose-destination",
        pending: command,
      });
    },
  );

  it("submits immediately after proactive destination choice", () => {
    const command: ReviewCommand = { type: "undo", expectedRevision: 0 };
    const active = {
      destination: {
        phase: "active" as const,
        generation: 1,
        kind: "copy" as const,
        targetPath: "/tmp/paper-annotated.pdf",
      },
      sync: { phase: "clean" as const, desiredRevision: 0, savedRevision: 0 },
    };
    expect(gateReviewCommand(state, active, command, "local").kind).toBe("submit");
  });

  it("keeps protected imported edits behind the destination gate", () => {
    const imported = { ...state, items: [{
      id: "11111111-1111-4111-8111-111111111111",
      kind: "pageNote" as const,
      pageIndex: 0,
      createdAt: "2026-08-11T12:00:00.000Z",
      updatedAt: "2026-08-11T12:00:00.000Z",
      payload: { position: { x: 1, y: 1, width: 10, height: 10 }, comment: "Existing" },
    }] };
    const edit: ReviewCommand = {
      type: "edit",
      expectedRevision: 0,
      id: imported.items[0]!.id,
      updatedAt: "2026-08-11T12:01:00.000Z",
      payload: { comment: "Changed" },
    };
    expect(gateReviewCommand(imported, unselected, edit, "local").kind).toBe("choose-destination");
  });

  it("accepts a remote annotation into Protected Recovery before choosing a destination", () => {
    const command: ReviewCommand = { type: "undo", expectedRevision: 0 };
    expect(gateReviewCommand(state, unselected, command, "remote-temporary")).toEqual({
      kind: "submit-and-choose-destination",
      command,
    });
  });
});

describe("save status polling", () => {
  it("continues through repeated Saving responses until the save settles", async () => {
    const statuses: SaveStatus[] = [
      { ...unselected, sync: { ...unselected.sync, phase: "saving" as const } },
      { ...unselected, sync: { ...unselected.sync, phase: "saving" as const } },
      unselected,
    ];
    const published: SaveStatus[] = [];
    await pollSaveStatusUntilSettled(
      async () => statuses.shift()!,
      (status) => published.push(status),
      new AbortController().signal,
      async () => {},
    );
    expect(published.map(({ sync }) => sync.phase)).toEqual(["saving", "saving", "clean"]);
  });
});
