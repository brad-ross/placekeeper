---
title: Prove temporal UI stability across stateful lifecycle seams
date: 2026-09-18
category: workflow-issues
module: Production browser lifecycle verification
problem_type: workflow_issue
component: testing_framework
severity: medium
applies_when:
  - A UI reaches the correct final state after exposing incorrect intermediate layout or status
  - A defect depends on a chain of state transitions whose stages pass separately
  - Shared review state appears in multiple views with different focus and pointer state
  - Several invalidation reasons share a refresh path but imply different user-facing claims
tags: [playwright, temporal-invariants, multi-view, animation-frames, lifecycle-testing, visual-regression]
---

# Prove temporal UI stability across stateful lifecycle seams

## Context

A correct saved comment and a correct final screenshot do not prove that Apply was visually stable. An annotation can keep its semantic identity and DOM node while a temporary notice above it shifts the row. Tests of replacement, reattachment, and editing in isolation can all pass without covering their composition.

PR #117's regression exercises the complete chain: create a highlight, replace the actual PDF, manually reattach that item, then pointer-apply an edit while another attachment observes the same Review Session (`test/acceptance/production-flow.spec.ts:4486`). The durable lesson is how to choose the setup and observations, rather than merely adding another eventual text assertion.

## Guidance

### Preserve the history that creates the failing state

Drive the same semantic item through the relevant transitions. A newly inserted annotation is not a substitute for an annotation carrying successor-generation reconciliation history. Keep the attachment alive through replacement; reloading constructs a different lifecycle and can hide a delivery failure.

The production regression creates and selects real PDF text, replaces the underlying bytes, reaches an unresolved annotation, and reattaches through the UI before editing the same item (`test/acceptance/production-flow.spec.ts:4486`). Shorten setup only after proving the removed steps do not affect the state that triggers the defect.

### Use the initiating view and a peer as complementary evidence

When state is shared, observe the initiating view and one connected peer. The initiating view has pointer, focus, and popup teardown effects; a peer receiving the same canonical update helps distinguish those local effects from shared lifecycle state. First prove both views joined the same Review Session, as the regression does before exercising either (`test/acceptance/production-flow.spec.ts:4494`).

A peer is not needed for every local layout bug. It is valuable when a change propagates across attachments or the reported symptom appears in several hosts.

### Separate temporal invariants from terminal correctness

Start an animation-frame sampler **before** the reported pointer action. Retain references to the original list and row, and record enough evidence to distinguish competing explanations:

| Observation | What it distinguishes |
| --- | --- |
| List and row identity | Remount or replacement versus movement of the same node |
| Target-ID-matched row counts | Duplicate or missing matching owned/reconciliation-item rows |
| Full row rectangle | Position or size changes hidden by a stable final layout |
| Reconciliation/loading notice presence | Layout or status tied to the wrong lifecycle event |
| Text and elapsed time | When the intended content reached each view |

The checked-in sampler records these values on each animation-frame callback, then attaches the raw trace to the test result (`test/acceptance/production-flow.spec.ts:4630`). It starts before pointer Apply, waits independently for both views' comment text, canonical broker content, and clean Save Sync, then continues through a bounded post-settlement tail (`test/acceptance/production-flow.spec.ts:4716`). This catches a late correction that an assertion immediately after popup closure could miss.

Assert continuity on **every captured sample**, not only the first and last. The current regression requires stable node identity, one target-ID-matched owned or reconciliation-item row visible by the sampler’s DOM criteria, an unchanged rectangle, no false rebuilt-PDF reconciliation/loading notice, and the new comment in the final sample (`test/acceptance/production-flow.spec.ts:4733`). Those checks answer different questions; stable node identity alone does not prevent a layout shift.

### Treat status text as a claim about known state

A canonical refresh can carry a Review Revision or authoring-presence change without replacing document bytes. Preserve those refreshes while classifying generation presentation separately. The document source uses `event.generation > loaded.generation` to decide whether to announce reconciliation; accepted bootstraps still publish atomically for same-generation events (`apps/web/src/host/runtime-document-source.ts:31`).

Test the meaning of the status, not just whether a request occurred:

| Situation | Required distinction |
| --- | --- |
| Same-generation revision, presence, or freshness | Fetch canonical state without claiming a rebuilt PDF is loading |
| Explicit successor while the predecessor remains loaded | Retain reconciliation status through racing successor events |
| Initial bootstrap fails before any PDF loads | Report preparation failure without referring to a last successful PDF |
| Reconnect discovers a successor only on completion | Install the accepted state without manufacturing a loading interval |

These cases are exercised by the runtime tests and the initial-loading boundary (`apps/web/test/host-runtime.test.ts:506`, `apps/web/src/production-entry.tsx:500`). Equal-revision presence still matters: suppressing its bootstrap would leave peers with stale authoring state (`apps/web/test/host-runtime.test.ts:675`).

### Pair negative checks with positive behavior

A test requiring no generation notice during ordinary Apply could pass if all notices were removed. Also require a genuine PDF replacement to show its generation status. The production regression checks both; the shell places real generation status in its top-left toast stack, outside the annotation list's layout (`test/acceptance/production-flow.spec.ts:4524`, `apps/web/src/app/ReviewShell.tsx:1614`).

## Why This Matters

Endpoint checks prove convergence; temporal checks prove that the observed transition preserves its presentation contract. The full lifecycle establishes the relevant state, the peer helps locate shared causes, and independent terminal assertions prevent a visually quiet but unsaved result from passing.

An animation-frame DOM trace is bounded evidence. It samples browser layout and computed visibility; it does not prove every compositor pixel or every packaged native-window frame. Swift lifecycle tests separately verify that equal-generation changes avoid successor document installation (`apps/macos/Tests/PlacekeeperMacTests/ReviewBridgeLifecycleTests.swift:17`). Native smoke and shared-client browser coverage must not be reported as native frame capture.

## When to Apply

Use this method for reports of flashing, jumping, blinking, duplicate rows, or brief disappearance, especially after a multi-step state history. Define the smallest meaningful sampling window and select invariants that distinguish the actual hypotheses. Do not replace causal evidence with arbitrary sleeps or a large collection of unrelated style assertions.

## Examples

For post-reattachment Apply, preserve one item through replacement and UI reattachment, start owner and peer samplers, pointer-click Apply, prove canonical content and Save Sync, then inspect every recorded target-ID sample. A row that keeps its node but changes its rectangle points toward surrounding layout; a second visible representation points toward duplicate projection; a false generation notice points toward lifecycle classification.

For a genuine replacement, require the notice while the successor is pending and stable tray geometry during that notice. These positive and negative cases protect both truthful feedback and visual continuity.

## Related

- [Atomic generation transitions for local PDF replacement](../architecture-patterns/atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md)
- [Calibrate virtualized PDF navigation before first paint](../ui-bugs/calibrate-virtualized-pdf-navigation-before-first-paint.md)
- [Contextual annotation composer](../design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md)
- [PR #117: Automatic local PDF refresh](https://github.com/brad-ross/placekeeper/pull/117)
