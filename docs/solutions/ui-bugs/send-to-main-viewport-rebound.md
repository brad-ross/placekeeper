---
title: Prevent Send-to-Main viewport rebound during Reference workspace reflow
date: 2026-08-12
category: ui-bugs
module: PDF reference navigation and viewer framing
problem_type: ui_bug
component: frontend_stimulus
severity: medium
symptoms:
  - "After a PDF Search Result was opened in a Reference Tab and sent to Main, the Main Reading Thread reached the destination, rebounded toward its prior viewport, and then settled again."
  - "The final destination was correct, but closing the last Reference Tab caused conspicuous motion on either scroll axis."
root_cause: async_timing
resolution_type: code_fix
related_components:
  - "NavigationCoordinator"
  - "ReviewShell"
  - "Framing Session"
  - "testing_framework"
tags:
  - "pdf-search"
  - "reference-tabs"
  - "send-to-main"
  - "viewer-framing"
  - "workspace-reflow"
  - "viewport-rebound"
  - "async-timing"
---

# Prevent Send-to-Main viewport rebound during Reference workspace reflow

## Problem

Sending the final Reference Tab to Main visibly jolted the Main PDF even though the semantic navigation succeeded.

The correction merged in [PR #12](https://github.com/brad-ross/pdf-markup/pull/12) on 2026-08-12.

## Symptoms

- Main arrived at the captured Reference location, moved back toward its pre-send viewport during final Reference teardown, and then settled again.
- The final page and anchor were correct, but the transition could visibly reverse on either scroll axis.

## What Didn't Work

The previous workaround applied the Main destination again after teardown. That corrected the final resting point but preserved the visible fight: semantic navigation moved to the destination, framing moved toward the old position, and the second navigation moved back.

Closing the physical Reference controller before Main navigation was also unsafe. A failed or superseded Main operation could then leave the logical Reference Tab without its rollback resource. The final failure path deliberately reveals References again without closing the controller or committing a failed destination (`apps/web/src/review/navigation-coordinator.ts:641-661`; `apps/web/test/navigation-coordinator.test.ts:658-671`).

## Solution

Treat semantic navigation and framing ownership as one transaction:

1. Hide and settle the final Reference layout.
2. Apply the live Reference location to Main once, then use its resulting capture—or the verified applied Reference location when recapture is transiently unavailable.
3. Commit the current Main position to the active Framing Session.
4. Only then consume the Reference Tab and begin final workspace teardown.

The coordinator now performs that order directly (`apps/web/src/review/navigation-coordinator.ts:635-675`). Its unit test requires one `applyLocation` call, requires the framing commit to precede the post-send hide/recomposition, and requires physical close to occur after the Main apply (`apps/web/test/navigation-coordinator.test.ts:597-620`).

`ReviewShell` exposes the commit through the framing owner's existing user-intent operation:

```ts
const commitMainFramingPosition = useCallback(() => {
  markFramingUserIntent(undefined, { captureSettledPosition: false });
}, [markFramingUserIntent]);
```

The callback is registered during layout and invoked imperatively by `NavigationCoordinator`, preserving the synchronous apply → commit → reflow order (`apps/web/src/app/ReviewShell.tsx:883-895`; `apps/web/src/app/ProductionReviewApp.tsx:315-316`; `apps/web/src/app/ProductionReviewApp.tsx:732-754`).

`markUserIntent` synchronously snapshots the current scroll position, marks both axes as user-owned, cancels any queued settled-position capture, and stops in-flight automatic scrolling (`apps/web/src/review/use-annotation-tray-framing.ts:223-270`). Consequently, close-time framing sees the verified destination—not the pre-send viewport—as its baseline.

After a successful commit and logical consumption, the final-reference branch settles layout and closes the controller without applying the Main destination a second time (`apps/web/src/review/navigation-coordinator.ts:668-700`).

## Why This Works

The navigation coordinator and workspace framing code had competing claims on the viewport. `sendToMain` had verified the new semantic destination, but the open Framing Session still held its pre-send baseline. Removing the final Reference viewport changed the layout and let close-time framing restore that stale baseline.

The safe handoff point is after Main verifies the destination but before the layout mutation that could restore older framing state. At that point, the semantic destination becomes authoritative for both systems. Reflow may still change geometry, but it cannot legitimately restore the prior reading position.

The ordering also preserves transaction safety. A failed apply leaves the source Reference Tab available and does not contaminate the framing baseline. A successful apply consumes and closes the source exactly once.

## Regression proof

The browser test observes motion rather than checking only the final page. It records both Main scroll axes before Send, continues through Reference viewport removal, and waits two animation frames plus 250 ms for delayed reflow work (`test/acceptance/production-flow.spec.ts:405-445`). It rejects a rightward or downward rebound greater than 8 px from the running minimum on either axis and separately rejects the two-second fallback timeout, so a hung observation cannot pass as stable motion (`test/acceptance/production-flow.spec.ts:447-455`).

## Prevention

1. **Commit verified semantic destinations before destructive reflow.** Any Main navigation followed by tray teardown must update the framing baseline before dispatching the post-navigation layout mutation.
2. **Keep one semantic navigation owner.** A second destination apply masks stale ownership and creates competing motion; retain the single-call assertion.
3. **Preserve the rollback resource until success.** Do not close the source Reference controller until Main navigation and the framing commit succeed.
4. **Make timing-critical ownership handoffs imperative.** A state token or passive effect can run after teardown has already been scheduled.
5. **Test the motion window, not just the endpoint.** Sample both axes beyond physical Reference removal and fail explicitly on observation timeout.

## Related Issues

- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) defines Framing Sessions, per-axis ownership, and restoration boundaries.
- [Reliable compact right-docked Reference Tabs](reliable-compact-right-docked-reference-tabs.md) covers the same Reference lifecycle and semantic fallback behavior.
- [PR #12](https://github.com/brad-ross/pdf-markup/pull/12) contains the implementation and regression coverage described here.
