---
title: Preserve semantic PDF copy when embedded hosts suppress context menus
date: 2026-09-03
last_updated: 2026-09-10
category: integration-issues
module: PDF selection and copy
problem_type: integration_issue
component: frontend_stimulus
severity: medium
symptoms:
  - "A valid cross-page PDF selection did not expose the browser's standard Copy menu in the Codex embedded browser."
  - "Command-C or Control-C copied the semantic selection, but pointer users had no equivalent native-menu action."
  - "Moving focus to a product-owned Copy button could accidentally revoke the PDF that owned subsequent keyboard copy."
root_cause: logic_error
resolution_type: code_fix
related_components:
  - NativePdfSelectionBridge
  - ContextActionPalette
  - Codex embedded browser
tags: [pdf-selection, semantic-copy, context-menu, embedded-browser, codex, clipboard, accessibility]
---

# Preserve semantic PDF copy when embedded hosts suppress context menus

## Problem

A browser-owned DOM selection is necessary for standard selection services, but it does not guarantee that an embedded host will render its native context menu. During manual validation of PR #74 in the Codex embedded browser, cross-page PDF text remained visibly selected and copied correctly with the keyboard while right-click still exposed no standard Copy action.

## Symptoms

- A real multi-page Main PDF selection produced the expected DOM selection text, and the application did not prevent the `contextmenu` event (`test/acceptance/production-flow.spec.ts`).
- Command-C or Control-C copied the exact semantic text through the global copy handler (`apps/web/src/app/ProductionReviewApp.tsx`).
- During PR #74 validation, right-click still produced no native menu in the embedded host, leaving pointer users without a familiar copy affordance (session history).

## What Didn't Work

- Mirroring the resolved PDF text into a browser-owned range did not make the menu appear. The bridge can create the range and refresh it before `contextmenu`, but it cannot override host-level menu policy (`apps/web/src/pdf/NativePdfSelectionBridge.tsx`).
- Removing application-side event cancellation was not sufficient. The native menu was also absent for ordinary selected browser text inside the same host, which separated host behavior from PDF selection validity (session history).
- Treating native-menu availability as a test of selection correctness sent the investigation toward the wrong layer. A valid selection, an unprevented event, keyboard copy, and host menu rendering are separate contracts.
- A second implementation based only on the asynchronous Clipboard API would have bypassed the existing resolver and copy event, creating separate ownership, limit, and error behavior.

## Solution

Preserve the standard Command-C and Control-C route, then add a product-owned Copy action to the Main PDF selection popup for hosts that suppress their native menu. The popup keeps Copy as its rightmost action and derives its title, accessible name, and shortcut metadata from one action definition (`apps/web/src/review/ContextActionPalette.tsx`).

Route popup activation through the same semantic copy event used by the keyboard shortcut:

```ts
paletteCopyOwnerRef.current = 'main';
copied = document.execCommand('copy');
```

The temporary owner identifies the selected PDF during the synthetic event. The global handler then calls the existing resolver and applies the result as `text/plain`; pending, unavailable, and over-limit states keep their existing behavior (`apps/web/src/app/ProductionReviewApp.tsx`, `apps/web/src/pdf/selection-state.ts`). After activation, restore Main PDF as the persistent [PDF Copy Authority](../../concepts.md#pdf-copy-authority) so a subsequent keyboard shortcut still targets the same retained selection (`apps/web/src/app/ProductionReviewApp.tsx`).

If the synchronous browser command returns false or throws, clear any prior success announcement and use the existing top-left error popup. Do not report success or mutate review state (`apps/web/src/app/ProductionReviewApp.tsx`).

## Why This Works

The fallback owns only the missing affordance. It does not replace native selection or keyboard behavior, and it does not introduce a second clipboard contract. Both entry points converge on `resolvePdfCopyCommand` and `applyPdfCopyCommand`, so exact semantic text, native editable-selection precedence, focused-PDF ownership, pending reads, unavailable text, and the shared page limit stay consistent (`apps/web/src/pdf/selection-state.ts`).

The acceptance test proves the composition rather than assuming it: popup Copy writes the exact two-page passage, keyboard copy still works after the button takes focus, and a forced command failure shows the error while leaving review state unchanged (`test/acceptance/production-flow.spec.ts`). The separate 13-page case proves that rejection leaves the clipboard, visible selection, and review state intact (`test/acceptance/production-flow.spec.ts`).

## Prevention

- Test selection validity, keyboard copy, application event cancellation, and native-menu availability as separate concerns in embedded hosts.
- Keep browser-owned selection and standard shortcuts even when a product-owned pointer fallback is required.
- Route every semantic PDF Copy affordance through the same command resolver and copy event. Do not call a separate clipboard writer from the popup.
- Preserve PDF Copy Authority when a contextual control takes focus, and test a keyboard copy immediately after popup activation.
- Exercise the failure path by forcing the synchronous copy command to return false. Require the prior success message to clear and the normal top-left error popup to appear.
- Retain exact cross-page and over-limit browser tests so the fallback cannot silently diverge from the keyboard path.

## Related Issues

- [Native control tooltip contract for the PDF review interface](../conventions/native-control-tooltip-contract.md) defines the accessible label and tooltip policy for the icon-only Copy action.
- [Reject stale viewer selection snapshots before creating annotation anchors](../ui-bugs/reject-stale-viewer-selection-snapshots.md) explains when asynchronous PDF selection evidence remains trustworthy.
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) explains why shared product semantics must tolerate host-specific capabilities.
- [PR #74: enable cross-page PDF selection, copy, and review](https://github.com/brad-ross/placekeeper/pull/74) contains the implementation described here.
