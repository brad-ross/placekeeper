---
title: "Prevent Send-to-Main viewport rebound during Reference workspace reflow"
date: "2026-08-12"
last_updated: "2026-09-06"
category: "ui-bugs"
module: "PDF reference navigation and viewer framing"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "Main reached a promoted Reference destination then rebounded toward its previous reading position during reflow"
  - "Closing the final Reference Tab caused conspicuous motion despite a correct final page and anchor"
root_cause: "async_timing"
resolution_type: "code_fix"
related_components:
  - "NavigationCoordinator"
  - "ReviewShell"
  - "ViewerPositionAuthority"
  - "Framing Session"
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

Sending the final Reference Tab to Main could reach the correct destination, rebound toward the previous viewport during Reference teardown, and then settle again. The final semantic location was correct; the visible motion exposed competing navigation and framing authority. [PR #12](https://github.com/brad-ross/placekeeper/pull/12) records the earlier correction.

Current framing preserves reading position through passive overlay changes rather than reversing an automatic open-time reveal. The durable Send-to-Main rule is still to hand off authority before consuming the source tab, but the handoff now clears remembered positions and stale capture authority. It does not install the destination as an old-style close-restoration baseline (`apps/web/src/app/ReviewShell.tsx:1997`, `apps/web/src/review/use-annotation-tray-framing.ts:302`).

## Symptoms

The Main PDF visibly reversed motion on one or both scroll axes when the final Reference disappeared. Endpoint-only assertions passed because a later destination application repaired the final position. The interaction was particularly conspicuous when Search remained involved in workspace recomposition.

The current regression observes both Main scroll axes through Reference viewport removal, not just the final page (`test/acceptance/production-flow.spec.ts:978`).

## What Didn't Work

Applying the destination again after teardown masked stale ownership. Navigation first moved Main to the target, framing moved it toward an older position, and the second application moved it back. A correct endpoint did not make that sequence acceptable.

Closing the physical Reference controller before Main applied was unsafe for a different reason: failed navigation would lose its rollback resource. Failure must leave the source tab and controller available, reveal the final Reference layout again, and avoid the framing handoff (`apps/web/src/review/navigation-coordinator.ts:915`, `apps/web/test/navigation-coordinator.test.ts:1234`).

Requiring an immediate fresh capture after a verified apply could also reject an already-completed Send during transient layout unavailability. `applyLocation` success supplies verified destination authority; the coordinator can retain the applied Reference location if recapture is momentarily unavailable (`apps/web/src/review/navigation-coordinator.ts:910`). This fallback is not permission to treat an unsuccessful apply as navigation success.

## Solution

### Apply once and transfer authority before consumption

Capture the live Reference location and current Main location, refresh Reference state, and start the Send transaction. For the final Reference, hide its layout and await settlement before applying Main's destination. Guard the operation after that wait (`apps/web/src/review/navigation-coordinator.ts:882`).

Apply the captured Reference location to Main once. On success, use Main's new capture or the verified applied location. Invoke `commitMainFramingPosition` before dispatching successful logical consumption and post-Send recomposition (`apps/web/src/review/navigation-coordinator.ts:908`, `apps/web/src/review/navigation-coordinator.ts:931`).

After success, a surviving Reference is restored through the normal tab path. With no survivor, layout settlement and physical controller close run together, then Main receives destination focus if the operation remains current. There is no second Main destination apply (`apps/web/src/review/navigation-coordinator.ts:949`). Thus the required ordering is apply → handoff → consume → final settlement/physical close; settlement and close are not strictly serial with each other.

### Clear superseded position memory synchronously

The shell registers an imperative callback during layout:

```ts
const commitMainFramingPosition = useCallback(() => {
  markFramingUserIntent(undefined, { captureSettledPosition: false });
}, [markFramingUserIntent]);
```

The production app retains that callback and invokes it through the coordinator dependency (`apps/web/src/app/ReviewShell.tsx:1997`, `apps/web/src/app/ProductionReviewApp.tsx:1058`, `apps/web/src/app/ProductionReviewApp.tsx:1893`). This keeps the handoff in the transaction rather than hoping a later passive effect runs before teardown.

`markUserIntent` advances the user revision and, when ready, performs a same-position immediate write to cancel older automatic smooth scrolling. With `captureSettledPosition: false`, it then calls `supersedeWithExplicitNavigation`: desired positions, pending user axes, and transition memory are cleared, and the capture revision advances (`apps/web/src/review/use-annotation-tray-framing.ts:302`, `apps/web/src/review/use-annotation-tray-framing.ts:269`, `apps/web/src/pdf/viewer-framing.ts:231`). It does not schedule a new settled user-position capture in this branch. Later passive layout therefore cannot legitimately revive the pre-Send remembered pan.

## Why This Works

Semantic navigation and passive framing no longer have competing destinations. The verified apply establishes where Main is; the synchronous handoff revokes older position memory before logical consumption triggers layout changes. Current framing can preserve the new location while respecting real scroll limits, without replaying the former reading position.

Rollback remains possible until success. A failed apply neither consumes the source nor closes its controller. A successful apply consumes the source even when an immediate recapture is unavailable, because the applied destination was already verified.

## Prevention

Retain the unit assertions for exactly one Main apply, one framing handoff before post-Send recomposition, and physical close after the apply (`apps/web/test/navigation-coordinator.test.ts:1173`). Cover transient recapture failure and failed-apply rollback separately (`apps/web/test/navigation-coordinator.test.ts:1199`, `apps/web/test/navigation-coordinator.test.ts:1234`).

Test the motion window honestly. The browser scenario records scroll events, waits beyond physical Reference removal for two animation frames plus 250 ms, and fails if its two-second fallback timer ended observation (`test/acceptance/production-flow.spec.ts:978`). Non-WebKit runs reject more than 8 px rebound from the running minimum on either axis. WebKit currently checks that the final sample is approximately equal to each axis's observed minimum; it does not enforce the same maximum transient-rebound bound (`test/acceptance/production-flow.spec.ts:1022`). Do not describe these distinct assertions as identical proof of zero rebound.

For any navigation followed by teardown, keep one semantic owner, revoke obsolete framing memory before layout mutation, preserve rollback resources until success, and distinguish logical consumption from physical disposal.

Related: [adaptive overlay framing](../architecture-patterns/adaptive-annotation-tray-framing.md) describes current position authority; [reliable Reference Tabs](reliable-compact-right-docked-reference-tabs.md) covers saved-location fallback and tab restoration.
