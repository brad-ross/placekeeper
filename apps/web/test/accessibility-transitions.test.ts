import { describe, expect, it } from "vitest";

import { AccessibilityTransitionCoordinator } from "../src/app/accessibility-transitions.js";

describe("accessibility transition coordinator", () => {
  it("announces a current visible transition exactly once", () => {
    const coordinator = new AccessibilityTransitionCoordinator();
    coordinator.activateAttempt("attempt_current");
    const effect = coordinator.transition({
      attemptId: "attempt_current",
      visible: true,
      kind: "document-ready",
      generation: 2,
    });
    expect(effect).toMatchObject({
      announcement: "The document is ready.",
      focus: "document-workspace-if-loading",
    });
    expect(coordinator.transition({
      attemptId: "attempt_current",
      visible: true,
      kind: "document-ready",
      generation: 2,
    })).toBeUndefined();
  });

  it("keeps hidden and stale attempts silent without consuming the visible event", () => {
    const coordinator = new AccessibilityTransitionCoordinator();
    coordinator.activateAttempt("attempt_current");
    expect(coordinator.transition({
      attemptId: "attempt_current",
      visible: false,
      kind: "recoverable-failure",
    })).toBeUndefined();
    expect(coordinator.transition({
      attemptId: "attempt_stale",
      visible: true,
      kind: "recoverable-failure",
    })).toBeUndefined();
    expect(coordinator.transition({
      attemptId: "attempt_current",
      visible: true,
      kind: "recoverable-failure",
    })).toMatchObject({ focus: "first-recovery-action-if-needed" });
  });

  it("invalidates the previous attempt when a replacement becomes current", () => {
    const coordinator = new AccessibilityTransitionCoordinator();
    coordinator.activateAttempt("attempt_old");
    coordinator.activateAttempt("attempt_new");
    expect(coordinator.transition({
      attemptId: "attempt_old",
      visible: true,
      kind: "replacement-ready",
    })).toBeUndefined();
    expect(coordinator.transition({
      attemptId: "attempt_new",
      visible: true,
      kind: "replacement-ready",
    })).toMatchObject({ announcement: "The review was restored." });
  });
});
