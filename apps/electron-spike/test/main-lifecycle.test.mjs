import assert from "node:assert/strict";
import test from "node:test";

import { requestedPdfPath } from "../src/launch-policy.mjs";
import {
  createMainLifecycle,
  openLinkWithConfirmation,
} from "../src/main-lifecycle.mjs";

const PDF = "/private/tmp/paper.pdf";
const SECOND_PDF = "/private/tmp/second.pdf";

function createLifecycle(overrides = {}) {
  const dispatched = [];
  const failures = [];
  let focused = 0;
  const lifecycle = createMainLifecycle({
    dispatchAction: async (action) => {
      dispatched.push(action);
    },
    focusWindow: () => {
      focused += 1;
    },
    now: () => 0,
    parseRequestedPdfPath: requestedPdfPath,
    presentFailure: async (error) => {
      failures.push(error);
    },
    ...overrides,
  });
  return {
    dispatched,
    failures,
    focused: () => focused,
    lifecycle,
  };
}

test("timestamps file and URL events when received, then flushes them in order after ready", async () => {
  const timestamps = [12, 34];
  const harness = createLifecycle({ now: () => timestamps.shift() });

  harness.lifecycle.receivePdf(PDF);
  harness.lifecycle.receiveLink("placekeeper:///private/tmp/paper.pdf#v=1&page=2");

  assert.equal(harness.lifecycle.pendingCount(), 2);
  assert.deepEqual(harness.dispatched, []);
  assert.equal(harness.lifecycle.markReady(), 2);
  await harness.lifecycle.waitForIdle();

  assert.deepEqual(harness.dispatched, [
    { kind: "pdf", receivedAt: 12, value: PDF },
    {
      kind: "link",
      receivedAt: 34,
      value: "placekeeper:///private/tmp/paper.pdf#v=1&page=2",
    },
  ]);
});

test("continues dispatching later actions after reporting an action failure", async () => {
  const dispatched = [];
  const failures = [];
  const lifecycle = createMainLifecycle({
    dispatchAction: async (action) => {
      dispatched.push(action.value);
      if (action.value === PDF) throw new Error("first launch failed");
    },
    focusWindow: () => {},
    now: () => 50,
    parseRequestedPdfPath: requestedPdfPath,
    presentFailure: async (error) => {
      failures.push(error.message);
    },
  });

  lifecycle.markReady();
  lifecycle.receivePdf(PDF);
  lifecycle.receivePdf(SECOND_PDF);
  await lifecycle.waitForIdle();

  assert.deepEqual(dispatched, [PDF, SECOND_PDF]);
  assert.deepEqual(failures, ["first launch failed"]);
});

test("second-instance PDF reuse records receipt time, dispatches, and focuses the existing window", async () => {
  const harness = createLifecycle({ now: () => 78 });
  harness.lifecycle.markReady();

  await harness.lifecycle.handleSecondInstance({
    additionalData: { pdfPath: PDF },
    argv: ["Electron", "."],
  });
  await harness.lifecycle.waitForIdle();

  assert.deepEqual(harness.dispatched, [{ kind: "pdf", receivedAt: 78, value: PDF }]);
  assert.equal(harness.focused(), 1);
  assert.deepEqual(harness.failures, []);
});

test("malformed second-instance argv reports failure and still focuses without dispatching", async () => {
  const harness = createLifecycle();
  harness.lifecycle.markReady();

  await harness.lifecycle.handleSecondInstance({
    additionalData: {},
    argv: ["Electron", ".", PDF, SECOND_PDF],
  });
  await harness.lifecycle.waitForIdle();

  assert.deepEqual(harness.dispatched, []);
  assert.equal(harness.focused(), 1);
  assert.equal(harness.failures.length, 1);
  assert.match(harness.failures[0].message, /one PDF/i);
});

test("canceled link confirmation does not dispatch an open", async () => {
  const calls = [];
  const opened = await openLinkWithConfirmation({
    action: { kind: "link", receivedAt: 91, value: "spike-link" },
    canonicalize: (link) => `canonical:${link}`,
    confirm: async (path) => {
      calls.push(["confirm", path]);
      return false;
    },
    open: async (...args) => {
      calls.push(["open", ...args]);
      return "review-url";
    },
    preflight: async (link) => {
      calls.push(["preflight", link]);
      return { confirmationRequired: true, path: PDF };
    },
    showReview: async (...args) => calls.push(["show", ...args]),
  });

  assert.equal(opened, false);
  assert.deepEqual(calls, [
    ["preflight", "canonical:spike-link"],
    ["confirm", PDF],
  ]);
});

test("confirmed link dispatch preserves its original receipt timestamp", async () => {
  const calls = [];
  const opened = await openLinkWithConfirmation({
    action: { kind: "link", receivedAt: 123, value: "spike-link" },
    canonicalize: (link) => `canonical:${link}`,
    confirm: async () => true,
    open: async (...args) => {
      calls.push(["open", ...args]);
      return "review-url";
    },
    preflight: async () => ({ confirmationRequired: true, path: PDF }),
    showReview: async (...args) => calls.push(["show", ...args]),
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, [
    ["open", "canonical:spike-link", true],
    ["show", "review-url", PDF, 123],
  ]);
});

test("a confirmation recheck can prompt once and retry the open as confirmed", async () => {
  const calls = [];
  let attempts = 0;
  const opened = await openLinkWithConfirmation({
    action: { kind: "link", receivedAt: 145, value: "spike-link" },
    canonicalize: (link) => `canonical:${link}`,
    confirm: async (path) => {
      calls.push(["confirm", path]);
      return true;
    },
    open: async (...args) => {
      calls.push(["open", ...args]);
      attempts += 1;
      return attempts === 1
        ? { kind: "confirmation-required", path: SECOND_PDF }
        : "review-url";
    },
    preflight: async () => ({ confirmationRequired: false, path: PDF }),
    showReview: async (...args) => calls.push(["show", ...args]),
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, [
    ["open", "canonical:spike-link", false],
    ["confirm", SECOND_PDF],
    ["open", "canonical:spike-link", true],
    ["show", "review-url", SECOND_PDF, 145],
  ]);
});
