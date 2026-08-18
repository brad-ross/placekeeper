---
title: Task-scoped, prompt-refreshed live PDF context
date: 2026-08-12
last_updated: 2026-08-17
category: architecture-patterns
module: Live PDF Context
problem_type: architecture_pattern
component: assistant
severity: high
applies_when:
  - An agent must discuss a locally changing document without relying on stale file reads or ambient window discovery
  - Each prompt must observe accepted semantic edits even while file persistence is saving or has failed
  - Large document evidence must remain available without entering every prompt
  - Multiple agent tasks or document generations must remain isolated
  - Failed prompt delivery must replay changes instead of advancing the observation cursor
related_components:
  - task binding registry
  - live context service
  - PDF evidence service
  - plugin prompt hooks
  - Review Items
  - Save Sync
tags:
  - live-pdf-context
  - task-binding
  - prompt-refresh
  - atomic-observation
  - review-item-deltas
  - two-phase-acknowledgement
  - bounded-evidence
  - generation-gating
---

# Task-scoped, prompt-refreshed live PDF context

## Context

An agent cannot safely learn a changing PDF review from an open browser tab, a file path, or a snapshot captured at launch. Those signals do not identify which task owns the review, whether its browser completed the same authenticated launch, or whether annotations changed before the next user prompt.

Earlier approaches centered on autosave or a visible handoff action, but the need was different: the agent task had to know which review it owned and receive fresh PDF and annotation state without a button (session history). Pointing the agent at raw PDF bytes likewise provided no ambient awareness of later annotations, while scraping the browser DOM would have made presentation state compete with canonical Review Items (session history).

Live PDF Context therefore works as a task-scoped synchronization protocol. A launch establishes correlation, every prompt requests a fresh atomic observation, delivery is acknowledged separately from computation, and deeper document evidence is exposed through a bounded capability.

## Guidance

### Bind one review generation to one agent task

Use a two-sided handshake instead of inferring ownership from the active application window. A launch creates a one-time proof scoped to the review session, document generation, and browser capability (`apps/service/src/context/task-binding-registry.ts:110-139`). The agent hook claims that proof for its task, producing a pending binding; the authenticated browser must then activate the same review generation with its matching capability (`apps/service/src/context/task-binding-registry.ts:141-247`).

Keep the association exclusive. Existing bindings are reusable only when task, review, and generation all match; competing claims are denied without disclosing the current owner. Each accepted repeat claim adds only that launch's browser-capability hash to the existing binding (`apps/service/src/context/task-binding-registry.ts:166-205`). Browser heartbeats and status reads must present a capability hash already owned by that binding, so another task's later projection cannot borrow the first projection's scope (`apps/service/src/context/task-binding-registry.ts:268-288`, `apps/service/src/context/task-binding-registry.ts:323-379`). The packaged hook recognizes only the documented successful launcher command rather than inspecting transcript text or browser state (`apps/service/src/cli/hook-command.ts:130-180`).

This handshake was preceded by a compatibility gate proving that the packaged hook actually received the necessary launch and prompt events. That spike avoided building task correlation on assumed host behavior (session history).

### Resume the exact browser projection

A hard browser refresh must resume the projection that completed the handshake, not reconstruct task ownership from the PDF path. The first authenticated bootstrap associates its credential with the original launch scope and creates a random readable view route. Reloading that route returns the same credential only when its view ID, pathname, scoped cookie, live session, document generation, and credential still match (`apps/service/src/sessions/session-broker.ts:581-681`). Scope polling then uses that credential's retained browser-capability discriminator, preserving the original task binding without exposing its task ID to the browser (`apps/service/src/sessions/session-broker.ts:969-1008`).

That continuity is intentionally process-local. A copied route without its cookie, an ended view, or a route answered by a successor daemon cannot recreate the credential or Codex scope. Post-restart recovery may reopen the path and semantic location through a fresh ordinary browser launch, but Codex must perform a new explicit launch-and-bind handshake to regain task-scoped context. [Authority boundaries for reloadable local-review URLs](reloadable-local-review-url-authority-boundaries.md) defines the full live-resume versus successor-reopen contract.

### Refresh at prompt consumption

Do not try to create an unsolicited agent turn whenever the app changes. Register a prompt-submission hook and pull current state when the user next asks a question (`integrations/codex-plugin/hooks/hooks.json:18-29`, `apps/service/src/cli/hook-command.ts:407-417`). This closes the interval in which a Review Item can change after one turn but before the next.

Publish one coherent observation. The service reads a session projection, inspects immutable PDF evidence, then verifies the session again and retries if its revision, source, save state, or generation changed during projection (`apps/service/src/context/live-context-service.ts:316-375`, `apps/service/src/context/live-context-service.ts:525-538`). The core observation requires the Review Item snapshot, observation identity, and evidence handle to agree on revision, state digest, and document generation (`packages/core/src/live-context.ts:511-545`). Failure returns explicit unavailability rather than cached content labeled current.

### Acknowledge only delivered observations

Separate refresh from delivery acknowledgement. Refresh retains its snapshot as a pending delivery but does not immediately replace the task's acknowledged baseline (`apps/service/src/context/live-context-service.ts:409-422`). The hook writes the context first and sends `ack-context` only afterward (`apps/service/src/cli/hook-command.ts:407-429`).

If prompt output or acknowledgement fails, leaving the prior baseline in place is correct. The next prompt replays every change since the last acknowledged baseline—or a full observation when no baseline was acknowledged—instead of silently skipping work. A caller-provided cursor is not authority: deltas are based on the server-owned acknowledged snapshot for the same review generation (`apps/service/src/context/live-context-service.ts:275-314`). An unknown cursor degrades to a full snapshot (`packages/core/src/live-context.ts:368-385`).

### Diff semantic records explicitly

The synchronized object is the canonical structured Review Item, not viewer markup or timestamps. Its digest uses stable semantic fields in deterministic order (`packages/core/src/live-context.ts:322-365`). Between acknowledged snapshots, new IDs are additions, missing IDs are removals, and retained IDs with changed projections are edits (`packages/core/src/live-context.ts:388-410`).

Expose three modes:

- `full` for an initial or unknown baseline;
- `unchanged` when semantic state matches;
- `delta` with distinct `added`, `edited`, and `removed` collections.

Removals remain first-class data instead of being inferred from absence. Tests cover full, unchanged, add, edit, remove, lost-delivery replay, and unknown-cursor recovery (`apps/service/test/live-context-service.test.ts:110-211`).

### Lease ownership and revoke derived access together

Bindings are temporary. Pending proofs and active bindings have bounded lifetimes; verified prompt refreshes renew the task-owned review generation, while an authenticated browser heartbeat renews only when its credential retains a capability hash owned by that exact binding (`apps/service/src/context/task-binding-registry.ts:265-296`, `apps/service/src/sessions/session-broker.ts:969-1008`).

Task cleanup removes acknowledged and pending cursors and revokes evidence. Session cleanup removes every observation and evidence handle for that review (`apps/service/src/context/live-context-service.ts:232-266`). Task end, session end, stale generation, explicit revocation, and expiry therefore fail closed rather than leaving ambient cached access (`apps/service/src/cli/hook-command.ts:430-432`, `apps/service/src/host/launch-control.ts:407-412`).

### Keep prompts compact and evidence bounded

Do not inline PDF bytes or an unbounded annotation collection on every turn. The hook envelope is capped, and large snapshots or deltas collapse to semantic counts plus retrieval instructions rather than being silently truncated (`apps/service/src/cli/hook-command.ts:13-15`, `apps/service/src/cli/hook-command.ts:183-241`).

Each verified observation mints a short-lived opaque evidence handle bound to task, review generation, and observation digest. Review Items and changes are paginated; PDF document, text, layout, render, and raw-annotation retrieval enforce page and byte limits (`apps/service/src/context/pdf-evidence-service.ts:178-280`, `apps/service/src/context/pdf-evidence-service.ts:344-545`). Authorization rechecks the active binding, generation, expiry, and last verified digest before resolving the hidden task scope (`apps/service/src/context/pdf-evidence-service.ts:303-325`).

This separation lets the prompt truthfully say “current” without pretending the entire PDF fits in context. Deep evidence is retrieved only for the pages or items needed to answer the question.

### Treat document content as data, never instructions

PDF text, Review Item anchors and payloads, source hints, existing annotations, and retrieved evidence remain untrusted data. The hook envelope explicitly permits quoting and reasoning about them while prohibiting execution of embedded commands or policies (`apps/service/src/cli/hook-command.ts:251-266`). Preserve that classification across both inline summaries and later retrieval.

## Why This Matters

The protocol separates four claims that otherwise collapse into a misleading “connected” flag:

1. **Ownership:** this task proved association with this review generation.
2. **Freshness:** this prompt received an atomic semantic observation.
3. **Delivery:** the acknowledged cursor advances only after context was emitted.
4. **Evidence:** larger data remains available only inside the same short-lived scope.

Without task binding, concurrent tasks can receive the wrong document. Without prompt-time refresh, autosave may make a PDF durable while the agent still reasons from old annotations. Without post-delivery acknowledgement, a failed hook can lose a delta. Without bounded evidence, truthful completeness competes with prompt size and security.

Autosave and live context are complementary sync directions, not one mechanism (session history). Autosave reconciles Review State with the Save Destination; Live PDF Context reconciles the bound agent's observation with current Review State and reports Save Sync as part of that observation.

## When to Apply

- An agent discusses a local model that may change between prompts.
- Multiple tasks or documents can coexist.
- Changes must distinguish additions, edits, removals, and semantic no-ops.
- Complete evidence is larger than the safe prompt envelope.
- Browser presence participates in binding but must not expose task IDs or bearer credentials.
- Document-derived content may contain hostile instructions.

A one-shot file read is sufficient when input is immutable for the task, has no competing owner, and fits safely in context.

## Examples

### Launch binding

```text
agent task launches PDF
  -> service creates review generation and one-time bind proof
PostToolUse claims proof for task
  -> binding is pending
authenticated browser exchanges matching capability
  -> exact task/review/generation binding becomes active
```

The browser phase matters: command success alone does not prove that the authenticated review surface completed bootstrap (`apps/service/src/context/task-binding-registry.ts:79-83`).

### Replay-safe prompt delivery

```text
UserPromptSubmit
  -> refresh task and project cursor C8
  -> retain C8 as pending
  -> write context into the prompt
  -> acknowledge C8
  -> promote C8 to the delta baseline
```

If writing fails, acknowledgement does not run (`apps/service/test/hook-contract.test.ts:215-221`). The following prompt replays changes from the last acknowledged baseline; when no baseline has ever been acknowledged, it receives a full observation (`apps/service/test/live-context-service.test.ts:191-210`).

### Compact context with on-demand evidence

The prompt carries currentness, document generation, revision, digest, Review Item counts, change mode, Save Sync, and an opaque handle. The agent can then page through canonical Review Items or request page-specific text and layout. Authorization fails when task binding, generation, observed digest, or expiry no longer match; an invalid or oversized retrieval is rejected for that request and may be retried within valid bounds (`apps/service/src/context/pdf-evidence-service.ts:303-341`, `apps/service/src/context/pdf-evidence-service.ts:423-518`).

## Related

- [Truthful compact status for live agent context](../design-patterns/truthful-compact-agent-context-status.md) covers the passive presentation of this freshness contract.
- [Authority boundaries for reloadable local-review URLs](reloadable-local-review-url-authority-boundaries.md) explains why a live hard refresh may preserve this binding while a successor-daemon reopen may not.
- [Recoverable autosave for editable PDF annotations](recoverable-editable-pdf-annotation-autosave.md) defines Review State and Save Sync authority on the persistence side.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) applies the sibling fail-closed generation principle to document-derived UI.
- [Live PDF Context plan](../../plans/2026-08-12-001-feat-live-pdf-codex-context-plan.md) records the originating requirements and design decisions.
