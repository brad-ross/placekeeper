---
title: Stabilizing recoverable reference flows in WebKit acceptance tests
date: 2026-08-11
last_updated: 2026-09-10
category: test-failures
module: production-flow acceptance tests
problem_type: test_failure
component: testing_framework
symptoms:
  - WebKit CI failed after opening a same-PDF reference while Chromium passed.
  - The References tray showed Reference unavailable and Retry reference before the expected tab appeared.
  - The dedicated retry-path test passed while the broader reference flow failed.
root_cause: async_timing
resolution_type: test_fix
severity: medium
related_components:
  - PDF reference navigation
  - ReferenceWorkspace
  - navigation coordinator
tags:
  - webkit
  - playwright
  - reference-navigation
  - async-timing
  - portal-focus
  - semantic-assertions
---

# Stabilizing recoverable reference flows in WebKit acceptance tests

## Problem

The production reference-navigation acceptance flow assumed that opening the first reference would immediately create the target tab. WebKit could instead reach the application's supported recoverable error state before the tab appeared, so the test failed even though the in-product retry path worked.

The fix landed in [PR #7](https://github.com/brad-ross/placekeeper/pull/7). It changed the acceptance flow—not the runtime recovery implementation—to accept both valid intermediate outcomes, recover when necessary, and then require the same selected and focused reference-tab postcondition.

## Symptoms

- The failing WebKit artifact showed the References tray with “Reference unavailable.” and a “Retry reference” control instead of the expected “Primary result” tab. Those are the intentional pending-reference error controls rendered by `ReferenceWorkspace` (`apps/web/src/review/ReferenceWorkspace.tsx`).
- The central flow failed at its first selected-tab assertion. The current test now observes either the tab or retry button before proceeding (`test/acceptance/production-flow.spec.ts`).
- A dedicated scenario already proved recovery: it aborts the second document request, verifies the error and focused Retry control, retries, and then requires the selected and focused target tab (`test/acceptance/production-flow.spec.ts`). This isolated the failure to the broad test's assumption rather than a missing recovery path.

## What Didn't Work

### Treating the retry state as a product failure

Requiring the tab immediately conflated “completed on the first attempt” with “the user-visible flow works.” The coordinator retains the pending target before opening the reference controller and routes controller, navigation-adapter, or target-application failure through `failReference()` (`apps/web/src/review/navigation-coordinator.ts`). That method changes the pending panel to `error` while preserving its metadata (`apps/web/src/review/navigation-coordinator.ts`).

The workspace makes this recovery path operable: an error pending state selects the Retry control as the focus target (`apps/web/src/review/ReferenceWorkspace.tsx`), and the layout effect moves focus there when the error becomes available (`apps/web/src/review/ReferenceWorkspace.tsx`). A test that rejects this state contradicts the supported UI.

### Relying on a whole-test Playwright retry

Rerunning the test from the beginning does not exercise the application's retry operation. `retryReference()` preserves the pending target, retries or reuses the controller according to its status, reapplies the target, opens the tab, clears the pending state, and focuses the result (`apps/web/src/review/navigation-coordinator.ts`). The broad flow needed to click Retry in the same browser state.

### Using actionability-sensitive operations around a portal

Calling locator-level `focus()` and `press()` for both the PDF link and its portaled menu action introduced a stability race while the controls were settling. A remount between resolving a locator and acting on it can make a semantically valid flow look broken.

### Demanding pixel-perfect centering

The narrow-layout test required a page center to land within two pixels of the viewport center. Exact centering can be impossible when scroll limits constrain the final geometry, even though the intended page is the current visible reference.

### Re-proving focus through a potentially stale node

The flow had already established keyboard order, but later re-focused controls while survivor reconciliation could replace their nodes. That coupled a behavioral assertion to a transient DOM identity.

## Solution

### Accept the supported retry state, then converge on one postcondition

Before:

```ts
const primaryTab = page.getByRole("tab", { name: /Primary result/u });
await expect(primaryTab).toHaveAttribute("aria-selected", "true");
await expect(primaryTab).toBeFocused();
```

After:

```ts
const primaryTab = page.getByRole("tab", { name: /Primary result/u });
await expectReferenceReady(page, primaryTab);
await expect(primaryTab).toBeFocused();
```

`expectReferenceReady` owns readiness polling, one conditional Retry activation, and `REFERENCE_READY_TIMEOUT_MS`; the caller separately asserts focus. This is the central-flow implementation at `test/acceptance/production-flow.spec.ts`. It permits either valid intermediate state but preserves one strong end state.

### Activate portaled actions through actual page focus

The shared helper now focuses the DOM element without scrolling and sends the activation key through the page keyboard:

```ts
await link.evaluate((element) => element.focus({ preventScroll: true }));
await expect(link).toBeFocused();
await page.keyboard.press("Enter");
await expect(action).toBeFocused({ timeout: 1_500 });
await page.keyboard.press("Enter");
```

The complete helper bounds the portal-settling retry to two attempts (`test/acceptance/production-flow.spec.ts`). Role locators still prove accessible identity and focus; native keyboard input performs the activation against the document's current focused element.

### Assert semantic visibility instead of exact centering

The narrow test normalizes the distance between viewport center and page center by half the rendered page height and requires the result to be below one (`test/acceptance/production-flow.spec.ts`). This proves that the viewport center lies within the intended page's vertical bounds without requiring an unattainable pixel-perfect position.

### Separate keyboard-order evidence from behavioral activation

The test independently proves the focus sequence from the active tab to Send, then Close, then back to Send (`test/acceptance/production-flow.spec.ts`). It then clicks the currently resolved Send control and verifies main-document navigation and survivor selection (`test/acceptance/production-flow.spec.ts`). Final close uses a fresh role locator and keyboard activation without a redundant focus assertion (`test/acceptance/production-flow.spec.ts`).

## Why This Works

The test now follows the product state machine. Opening a new reference publishes a pending state before attempting the controller, navigation adapter, and target application (`apps/web/src/review/navigation-coordinator.ts`). Failure keeps the request recoverable and exposes the Retry UI (`apps/web/src/review/navigation-coordinator.ts`, `apps/web/src/review/ReferenceWorkspace.tsx`). Retrying uses the retained target and metadata, then opens and focuses the tab on success (`apps/web/src/review/navigation-coordinator.ts`).

The acceptance flow allows nondeterminism only at that documented recovery boundary. It does not accept an arbitrary timeout, skip navigation, or weaken the outcome: after at most one explicit retry, the target tab must be selected and focused (`test/acceptance/production-flow.spec.ts`). The companion changes remove assumptions about portal node lifetime and exact engine geometry while retaining explicit checks for keyboard order, main-document navigation, survivor selection, and final closure.

Verification for PR #7 included the exact WebKit gate (43 tests), the full Chromium production acceptance set (57 tests), and 20 focused Chromium repetitions of the narrow reference flow. Lint, type checking, the web build, and diff hygiene also passed before GitHub CI completed successfully.

## Prevention

1. **Model supported transient states in broad end-to-end flows.** When a product deliberately exposes loading, recoverable error, and success states, wait for the valid intermediate outcomes and converge on one required semantic postcondition.
2. **Keep a dedicated failure-injection test.** The focused retry scenario remains the authoritative proof of error copy, focus placement, request retry, and recovery (`test/acceptance/production-flow.spec.ts`).
3. **Do not substitute framework retries for in-product recovery.** A Playwright retry restarts the scenario; clicking “Retry reference” exercises the retained request and recovery branch.
4. **Use role locators for assertions and native input for portal activation races.** Verify focus ownership, then send the key to the document's current focused element. Bound any retry to the known portal-settling boundary.
5. **Assert user-visible geometry semantics.** Containment or meaningful intersection is more durable across engines and constrained layouts than exact pixel centering.
6. **Separate accessibility-order proof from state-transition proof.** Once keyboard order is established, activate through a freshly resolved control and verify the resulting state instead of requiring one DOM node to survive reconciliation.
7. **Stress the originally failing engine and interaction.** Combine the exact cross-engine gate with focused repetitions; one green rerun is weak evidence for a timing-sensitive test fix.

## Related Issues

- [PR #7: stabilize recoverable reference flows](https://github.com/brad-ross/placekeeper/pull/7)
- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md) — adjacent guidance for installed-style Chromium and WebKit coverage of stateful PDF interactions.
