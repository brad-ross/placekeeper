import { describe, expect, it } from "vitest";
import { parseOpenArguments } from "../src/cli/open-command.js";
import { inspectHookEvent } from "../src/cli/hook-command.js";
import { isControlRequest } from "../src/host/control-protocol.js";

describe("explicit candidate desktop launch", () => {
  it("keeps existing browser defaults and requires an explicit desktop selection", () => {
    expect(parseOpenArguments(["open", "--json", "--pdf", "/tmp/review.pdf"])).not.toHaveProperty("desktop");
    expect(parseOpenArguments(["open", "--json", "--desktop", "electron", "--pdf", "/tmp/review.pdf"])).toMatchObject({ desktop: "electron" });
    expect(() => parseOpenArguments(["open", "--json", "--desktop", "other", "--pdf", "/tmp/review.pdf"])).toThrow();
  });
  it("requires one opaque launch id for trusted resolution and cancellation", () => {
    expect(isControlRequest({ kind: "electron-resolve-launch", launchId: "a".repeat(43) })).toBe(true);
    expect(isControlRequest({ kind: "electron-resolve-launch", launchId: "/tmp/review.pdf" })).toBe(false);
  });
  it("claims only a correlated native receipt from the exact candidate command", () => {
    const response = { ok: true, kind: "opened", surface: "electron", native: true, sessionId: "session123", documentGeneration: 1, bindProof: "b".repeat(43), launchId: "c".repeat(43), expiresAt: "2099-01-01T00:00:00Z" };
    const event = { session_id: "task123", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "placekeeper open --json --desktop electron --pdf /tmp/review.pdf" }, tool_response: JSON.stringify(response) };
    expect(inspectHookEvent(event)).toMatchObject({ kind: "claim", native: true, bindProof: response.bindProof });
    expect(inspectHookEvent({ ...event, tool_response: JSON.stringify({ ...response, launchId: undefined }) })).toEqual({ kind: "ignored" });
  });
});
