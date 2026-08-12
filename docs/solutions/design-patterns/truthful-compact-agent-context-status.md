---
title: Truthful compact status for live agent context
date: 2026-08-12
category: design-patterns
module: PDF review interface
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - A dense document header must show whether an agent has the current document state
  - Local edits can invalidate a previously verified remote context before the next poll
  - A compact icon replaces persistent status text without losing accessibility
  - User-facing integration copy should remain neutral across agent providers
related_components:
  - Live PDF Context
  - Review State
  - task binding
tags:
  - agent-context
  - status-indicator
  - accessibility
  - provider-neutral
  - fail-closed
  - review-header
---

# Truthful compact status for live agent context

## Context

Live PDF Context needs a small, ambient signal in an already dense review header. A persistent colored dot plus text such as “Context current” or “Context connecting” consumed space, changed width across states, and exposed the name of the first supported agent provider in product copy.

Replacing that treatment with an icon creates a second problem: the icon must still explain whether the agent is connected, catching up with an annotation edit, or unavailable. More importantly, green “current” is an integrity claim. It must not survive a local Review State change, an expired context lease, a failed refresh, or a stale asynchronous response.

The durable pattern is therefore not merely “use a robot icon.” It is to render one compact visual anchor as a projection of a fail-closed freshness model, with precise status available through keyboard-accessible progressive disclosure.

## Guidance

### Keep one invariant visual anchor

Use the same visible icon and wrapper for every context state. In the review interface, the shared `agent` icon maps to Lucide's `Bot`, and the status component renders that icon for current, connecting, updating, and unavailable states (`apps/web/src/review/ReviewIcon.tsx:37-42`, `apps/web/src/review/CodexContextStatus.tsx:31-45`).

Project the richer binding contract into three visual treatments at the presentation boundary:

| Binding state | Visual state | Treatment | Tooltip title |
| --- | --- | --- | --- |
| `current` | current | green, still | Agent context current |
| `pending` | connecting | amber, active | Agent context connecting |
| `refreshing` | connecting | amber, active | Agent context updating |
| `unbound` or `unavailable` | unavailable | red, still | Agent context unavailable |

`pending` and `refreshing` can share a visual treatment because both mean “not yet current,” but their copy should remain distinct. Initial connection and synchronization after a local edit are materially different explanations (`apps/web/src/review/CodexContextStatus.tsx:9-26`).

Keep the header footprint fixed. The implementation uses a 24-by-24-pixel circular surface and derives its icon, border, background, and tooltip-dot color from one state accent (`apps/web/src/app/review-layout-foundation.css:320-353`, `apps/web/src/app/review-layout-foundation.css:413-419`). The explanation lives in a panel tooltip built from the review interface's existing surface, border, radius, focus, and shadow tokens (`apps/web/src/app/review-layout-foundation.css:355-425`). State transitions therefore change meaning without moving adjacent controls.

### Treat “current” as verified identity

Do not derive the icon from network reachability or the last successful response alone. A reported current identity is visible as current only while all of the following still match the mounted Review State:

- proofreader session
- review revision
- source file identity
- source digest

`visibleCodexContext` performs that comparison. If local annotation work advances the revision—or any source identity differs—it immediately projects the old current result to `refreshing` before waiting for another service request (`apps/web/src/app/ProductionReviewApp.tsx:126-147`). This keeps the amber state synchronized with the user's edit rather than with polling latency.

Guard asynchronous refreshes the same way. Each request captures a key for the current session, source, revision, and items; its result is applied only if that key still describes the mounted state. Timeouts, request failures, a missing context payload, and a response for a non-agent launch scope fail closed to unavailable (`apps/web/src/app/ProductionReviewApp.tsx:149-157`, `apps/web/src/app/ProductionReviewApp.tsx:281-327`).

A successful observation is leased rather than permanent. At lease expiry, the UI demotes current to refreshing while retaining the last verified identity for diagnosis; a later authoritative refresh may restore current or report unavailable (`apps/web/src/app/ProductionReviewApp.tsx:328-344`). The view applies the identity check again at its render boundary (`apps/web/src/app/ProductionReviewApp.tsx:845-847`).

This ordering matters:

```text
local Review State changes
  -> current identity no longer matches
  -> status becomes updating immediately
  -> refresh result is accepted only for the same local state
  -> exact fresh evidence may restore current
```

### Put detail behind both hover and focus

Color is an accent, not the status contract. The focusable status wrapper has a complete accessible name, including the verified review revision when current. Hover and keyboard focus reveal the same tooltip title and detail. The robot SVG itself stays decorative so assistive technology receives one coherent status description (`apps/web/src/review/CodexContextStatus.tsx:27-50`, `apps/web/src/review/ReviewIcon.tsx:81-95`).

Keep the stable current state quiet. Re-announcing it on every poll would create noise, so only non-current states mount the polite atomic live region (`apps/web/src/review/CodexContextStatus.tsx:46-50`). Current remains inspectable through its accessible name and tooltip.

If the connecting treatment uses motion, include the status icon in the interface's reduced-motion rules. The current pulse is defined on the connecting robot (`apps/web/src/app/review-layout-foundation.css:343-349`); reduced-motion coverage should be verified explicitly rather than inferred from a rule for another saving indicator.

### Keep product language neutral without overstating transport support

Visible and accessible copy says “agent,” “connected agent,” and “your agent” (`apps/web/src/review/CodexContextStatus.tsx:13-29`). This keeps the product vocabulary compatible with additional coding-agent services.

Provider-neutral copy does not authorize a provider-neutral protocol claim. The current integration is still shown only for a trusted Codex launch surface (`apps/web/src/app/ProductionReviewApp.tsx:281-283`, `apps/web/src/app/ProductionReviewApp.tsx:845-847`). Internal `codexContext` names can remain until the transport genuinely supports multiple providers. Product-language cleanup and protocol generalization are separate migrations.

## Why This Matters

A compact icon creates useful space only if it preserves trust. The user should be able to read green as “the connected agent has this exact document and annotation state,” amber as “that knowledge is being established or refreshed,” and red as “live context cannot currently be relied on.”

Fail-closed projection prevents the most damaging UI error: reassuring the user that the agent knows an annotation that was added after the last verified snapshot. The same rule also blocks an older request from repainting the indicator green after newer local work.

The pattern remains accessible without restoring persistent text to the header. A consistent robot, non-color accessible name, hover/focus tooltip, and selective live announcement carry complementary parts of the same state model.

## When to Apply

- A remote or background agent consumes a changing local document model.
- “Current” depends on semantic identity, revision, generation, or a bounded lease.
- The relevant status belongs in compact application chrome.
- Initial connection and refresh-after-edit can share visual emphasis but need different explanations.
- Product terminology should survive adding another provider even while transport code remains provider-specific.

Do not apply this pattern to an actionable control. The context indicator is passive. Its unavailable state explains how to recover but does not impersonate a reconnect button (`apps/web/test/codex-context-status.test.tsx:46-58`).

## Examples

### Manual annotation invalidates green immediately

Suppose the service verified review revision 3. When the user adds an annotation, local Review State advances before the next scope poll. The prior identity is projected to refreshing immediately because its revision no longer matches. The robot turns amber and the tooltip says the latest annotation changes are syncing. Only a response verified against the new state may turn it green again (`apps/web/test/production-review-app.test.tsx:316-351`).

### Lease expiry while a refresh hangs

The mounted acceptance flow starts with current context, advances the browser clock beyond the context lease, and deliberately hangs a later scope request until its abort signal fires. It proves current to updating to unavailable while the same robot remains visible, the tooltip changes coherently, and the indicator remains at most 26 pixels wide (`test/acceptance/production-flow.spec.ts:265-343`).

### Layered verification

Use three test layers:

1. Render representative binding variants and assert the visual-state attribute, the robot, provider-neutral accessible copy, recovery guidance, and live-region policy (`apps/web/test/codex-context-status.test.tsx:6-58`).
2. Verify launch-scope gating and the immediate current-to-refreshing projection when local Review State advances (`apps/web/test/production-review-app.test.tsx:279-351`).
3. Use a clock-controlled mounted browser test for actual geometry, tooltip interaction, lease expiry, refresh timeout, and recovery copy (`test/acceptance/production-flow.spec.ts:265-343`).

Static component tests prove semantics; the mounted test proves the timing and presentation consequences that markup alone cannot.

## Related

- [Live PDF Context plan](../../plans/2026-08-12-001-feat-live-pdf-codex-context-plan.md) defines the broader task binding, freshness, and passive-status contract behind this presentation.
- [Outline-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) applies the same fail-closed projection principle to asynchronous document capabilities.
- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) explains the related revision-and-digest authority used for save currentness.
