---
title: Wait for committed wheel zoom before pointer-selection assertions
date: 2026-08-11
last_updated: 2026-09-10
category: test-failures
module: PDF viewer acceptance harness
problem_type: test_failure
component: testing_framework
symptoms:
  - During PR #5 CI, the shared-viewer Playwright test intermittently lost its second text selection after Control-wheel zoom.
  - The investigation found that the PDF page bounding box could grow before the viewer committed its new zoom level.
  - The recorded CI failure observed zero selection rectangles after the post-zoom drag even though the flow often passed locally or on retry.
root_cause: async_timing
resolution_type: test_fix
severity: medium
related_components:
  - EmbedPDF ZoomPlugin
  - pointer selection
tags:
  - playwright
  - embedpdf
  - wheel-zoom
  - pointer-selection
  - async-timing
  - ci-flake
---

# Wait for committed wheel zoom before pointer-selection assertions

## Problem

During the PR #5 CI investigation, the Playwright acceptance test for pointer selection after Control-wheel zoom sometimes began its second drag while EmbedPDF was still showing a gesture preview. The page already looked wider, but the viewer had not committed the new scale, so the later commit could change geometry and clear the selection before the assertion.

The repository pins `@embedpdf/plugin-zoom` 2.14.4 (`package.json`). The installed implementation inspected during the investigation appeared to use two observable wheel-zoom phases: an immediate CSS transform preview followed by a debounced provider commit.

## Symptoms

- In the recorded PR #5 CI failure, `uses a real pointer selection without creating edits` failed in its second, zoomed-selection sequence with zero selection rectangles.
- The page-width assertion passed first, making the failure look like a pointer-selection regression rather than a zoom synchronization race.
- Repeated local runs alternated between passes and failures, while CI could fail both the original attempt and its retry.

## What Didn't Work

Waiting only for `boundingBox().width` to exceed the original page width was not a valid completion signal. The investigation showed that temporary gesture presentation could satisfy that poll before the provider-owned zoom state changed.

Adding a fixed sleep would couple the test to an implementation-specific delay and remain sensitive to scheduling variance. During diagnosis, orphaned local Vite processes also caused `ERR_CONNECTION_REFUSED` and port-collision failures; those were test-environment noise and did not explain the selection race (session history).

## Solution

Expose the active document's committed zoom level through the acceptance harness. The probe reads the public `ZoomPlugin` scope for the active document and returns `currentZoomLevel` (`test/acceptance/viewer-harness/main.tsx`):

```ts
zoomLevel() {
  if (!registry) return 0;
  const documentId = registry.getStore().getState().core.activeDocumentId;
  if (!documentId) return 0;
  return registry.getPlugin<ZoomPlugin>(ZoomPlugin.id)
    ?.provides()
    .forDocument(documentId)
    .getState()
    .currentZoomLevel ?? 0;
}
```

After dispatching the real Control-wheel gesture, wait first for that provider-owned state and then for the DOM to render the wider page (`test/acceptance/viewer.spec.ts`):

```ts
await page.keyboard.down('Control');
await page.mouse.wheel(0, -10);
await page.keyboard.up('Control');

await expect.poll(() =>
  page.evaluate(() => window.viewerAcceptance.zoomLevel()),
).toBeGreaterThan(1);

await expect.poll(async () =>
  (await pdfPage.boundingBox())?.width ?? 0,
).toBeGreaterThan(box.width);
```

Only after both conditions hold does the test compute the zoomed pointer coordinates and start the second drag (`test/acceptance/viewer.spec.ts`). The fix was delivered and verified in [PR #5](https://github.com/brad-ross/placekeeper/pull/5), which is merged.

## Why This Works

The two waits represent different contracts:

1. `currentZoomLevel > 1` confirms that provider-owned zoom state has advanced above the initial scale.
2. `boundingBox().width > box.width` confirms that the wider page has rendered after the provider-state wait.

The next coordinate-based action therefore no longer begins before those observed provider and DOM conditions are satisfied. The test observes a narrow public capability through its own harness instead of coupling itself to temporary transforms or dependency timers.

## Prevention

- Synchronize browser tests on semantic provider state whenever an interaction has preview and commit phases.
- When the next action depends on coordinates, wait for both the state commit and its rendered layout consequence.
- Prefer narrow, read-only harness probes such as `zoomLevel()` over DOM-style inspection or fixed sleeps.
- Stress timing fixes with repeated isolated runs, then run the neighboring acceptance file and the authoritative CI workflow.
- Separate infrastructure noise such as orphaned dev servers from reproducible product or test failures before changing behavior.

## Related Issues

- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md) — adjacent guidance on viewer-owned state, asynchronous framing, and real-browser geometry checks.
- [PR #5](https://github.com/brad-ross/placekeeper/pull/5) — merged implementation and CI verification.
