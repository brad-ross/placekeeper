---
title: Truthful compact status for live agent context
date: 2026-08-12
last_updated: 2026-09-10
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

Use the same visible icon and wrapper for every context state. In the review interface, the shared `agent` icon maps to Lucide's `Bot`, and the status component renders that icon for current, connecting, updating, and unavailable states (`apps/web/src/review/ReviewIcon.tsx`, `apps/web/src/review/CodexContextStatus.tsx`).

Project the richer binding contract into three visual treatments at the presentation boundary:

| Binding state | Visual state | Treatment | Tooltip title |
| --- | --- | --- | --- |
| `current` | current | green, still | Agent context current |
| `pending` | connecting | amber, active | Agent context connecting |
| `refreshing` | connecting | amber, active | Agent context updating |
| `unbound` or `unavailable` | unavailable | red, still | Agent context unavailable |

`pending` and `refreshing` can share a visual treatment because both mean “not yet current,” but their copy should remain distinct. Initial connection and synchronization after a local edit are materially different explanations (`apps/web/src/review/CodexContextStatus.tsx`).

Keep the header footprint fixed. The current Soft Neutral override uses a 32px-wide control with a 32px minimum height, 10px radius, transparent background, and no border. The explanation uses a fixed dark tooltip positioned against the viewport; pointer hover waits 600ms and keyboard focus reveals it immediately (`apps/web/src/app/neutral-context-status.css`, `apps/web/src/review/CodexContextStatus.tsx`). State transitions change meaning without moving adjacent controls.

### Treat “current” as verified identity

Do not derive the icon from network reachability or the last successful response alone. A reported current identity is visible as current only while all of the following still match the mounted Review State:

- placekeeper session
- review revision
- source file identity
- source digest

`visibleCodexContext` performs that comparison. If local annotation work advances the revision—or any source identity differs—it immediately projects the old current result to `refreshing` before waiting for another service request (`apps/web/src/host/context-projection.ts`). This keeps the amber state synchronized with the user's edit rather than with polling latency.

Guard asynchronous refreshes the same way. Each request captures a key for the current session, source, revision, and items; its result is applied only if that key still describes the mounted state. Timeouts, request failures, a missing context payload, and a response for a non-agent launch scope fail closed to unavailable (`apps/web/src/host/use-codex-context.ts`).

A successful observation is leased rather than permanent. At lease expiry, the UI demotes current to refreshing while retaining the last verified identity for diagnosis; a later authoritative refresh may restore current or report unavailable (`apps/web/src/host/use-codex-context.ts`). The view applies the identity check again at its render boundary (`apps/web/src/app/ProductionReviewApp.tsx`).

This ordering matters:

```text
local Review State changes
  -> current identity no longer matches
  -> status becomes updating immediately
  -> refresh result is accepted only for the same local state
  -> exact fresh evidence may restore current
```

### Preserve status only for an exact live resume or verified restart reattach

A top-level hard refresh may keep the current Codex status only because the readable view resumes the same in-memory browser credential and its original launch scope. Resume requires the exact view ID, pathname, scoped cookie, active session, document generation, and credential; scope polling then presents the retained browser-capability hash to the task binding (`apps/service/src/sessions/session-broker.ts`). The mounted acceptance flow verifies that hard reload preserves both the readable page location and the connected-agent status (`test/acceptance/production-flow.spec.ts`).

Do not reconstruct status from a PDF path, readable view ID, or stable loopback origin. A copied route without its cookie and a successor-daemon recovery route have no authenticated launch scope. Reopening creates a fresh browser-scoped credential, so the indicator stays absent until either Codex performs a new explicit bind flow or a restart-only two-sided ticket verifies both the path-scoped browser token and the owning task's next prompt. That successful match promotes only the fresh authenticated credential; a foreign task, copied URL, or missing/expired token remains unbound.

### Put detail behind both hover and focus

Color is an accent, not the status contract. The focusable status wrapper has a complete accessible name, including the verified review revision when current. Hover and keyboard focus reveal the same tooltip title and detail. The robot SVG itself stays decorative so assistive technology receives one coherent status description (`apps/web/src/review/CodexContextStatus.tsx`, `apps/web/src/review/ReviewIcon.tsx`).

Keep the stable current state quiet. Re-announcing it on every poll would create noise, so only non-current states mount the polite atomic live region (`apps/web/src/review/CodexContextStatus.tsx`). Current remains inspectable through its accessible name and tooltip.

If the connecting treatment uses motion, include the status icon in the interface's reduced-motion rules. The current pulse is defined on the connecting robot (`apps/web/src/app/review-layout-foundation.css`); reduced-motion coverage should be verified explicitly rather than inferred from a rule for another saving indicator.

### Keep product language neutral without overstating transport support

Visible and accessible copy says “agent,” “connected agent,” and “your agent” (`apps/web/src/review/CodexContextStatus.tsx`). This keeps the product vocabulary compatible with additional coding-agent services.

Provider-neutral copy does not authorize a provider-neutral protocol claim. The current integration is still shown only for a trusted Codex launch surface (`apps/web/src/app/ProductionReviewApp.tsx`). Internal `codexContext` names can remain until the transport genuinely supports multiple providers. Product-language cleanup and protocol generalization are separate migrations.

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

Do not apply this pattern to an actionable control. The context indicator is passive. Its unavailable state explains how to recover but does not impersonate a reconnect button (`apps/web/test/codex-context-status.test.tsx`).

## Examples

### Manual annotation invalidates green immediately

Suppose the service verified review revision 3. When the user adds an annotation, local Review State advances before the next scope poll. The prior identity is projected to refreshing immediately because its revision no longer matches. The robot turns amber and the tooltip says the latest annotation changes are syncing. Only a response verified against the new state may turn it green again (`apps/web/test/production-review-app.test.tsx`).

### Lease expiry while a refresh hangs

The mounted acceptance flow starts with current context, advances the browser clock beyond the context lease, and deliberately hangs a later scope request until its abort signal fires. It proves current to updating to unavailable while the same robot remains visible, the tooltip changes coherently, and the status footprint remains stable. The original verification used a maximum 26px indicator; the current neutral control is 32px wide (`test/acceptance/production-flow.spec.ts`).

### Layered verification

Use three test layers:

1. Render representative binding variants and assert the visual-state attribute, the robot, provider-neutral accessible copy, recovery guidance, and live-region policy (`apps/web/test/codex-context-status.test.tsx`).
2. Verify launch-scope gating and the immediate current-to-refreshing projection when local Review State advances (`apps/web/test/production-review-app.test.tsx`).
3. Use a clock-controlled mounted browser test for actual geometry, tooltip interaction, lease expiry, refresh timeout, and recovery copy (`test/acceptance/production-flow.spec.ts`).

Static component tests prove semantics; the mounted test proves the timing and presentation consequences that markup alone cannot.

## Related

- [Live PDF Context plan](../../plans/2026-08-12-001-feat-live-pdf-codex-context-plan.md) defines the broader task binding, freshness, and passive-status contract behind this presentation.
- [Outline-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) applies the same fail-closed projection principle to asynchronous document capabilities.
- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) explains the related revision-and-digest authority used for save currentness.
- [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) defines when a browser refresh preserves this status and when restart recovery must discard it.
