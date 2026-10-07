---
title: Task-scoped, prompt-refreshed live PDF context
date: 2026-08-12
last_updated: 2026-10-06
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

An agent cannot safely learn a changing PDF review from an open browser tab, a file path, or a snapshot captured at launch. Those signals do not identify which task owns the review, whether its review surface completed the same authenticated launch, or whether annotations changed before the next user prompt.

Earlier approaches centered on autosave or a visible handoff action, but the need was different: the agent task had to know which review it owned and receive fresh PDF and annotation state without a button (session history). Pointing the agent at raw PDF bytes likewise provided no ambient awareness of later annotations, while scraping the browser DOM would have made presentation state compete with canonical Review Items (session history).

Live PDF Context therefore works as a task-scoped synchronization protocol. A launch establishes correlation, every prompt requests a fresh atomic observation, delivery is acknowledged separately from computation, and deeper document evidence is exposed through a bounded capability.

An authorized Document Generation transition may migrate the active task association while invalidating its prior freshness and evidence. `migrateGeneration` in `apps/service/src/context/task-binding-registry.ts` consumes pending proofs and clears `lastVerified`; old-generation evidence remains unusable. Browser polling and projection identity are owned by `apps/web/src/host/use-codex-context.ts` and `context-projection.ts`.

## Guidance

### Bind one review generation to one agent task

The following handshake describes browser admission. Native Codex preserves the same task association and prompt-time freshness rules through the separate proof sequence below.

Use a two-sided handshake instead of inferring ownership from the active application window. A launch creates a one-time proof scoped to the review session, document generation, and browser capability (`apps/service/src/context/task-binding-registry.ts`). The agent hook claims that proof for its task, producing a pending binding; the authenticated browser must then activate the same review generation with its matching capability (`apps/service/src/context/task-binding-registry.ts`).

Keep the association exclusive. Existing bindings are reusable only when task, review, and generation all match; competing claims are denied without disclosing the current owner. Each accepted repeat claim adds only that launch's browser-capability hash to the existing binding (`apps/service/src/context/task-binding-registry.ts`). Browser heartbeats and status reads must present a capability hash already owned by that binding, so another task's later projection cannot borrow the first projection's scope (`apps/service/src/context/task-binding-registry.ts`). For launch claims, the packaged hook recognizes only the documented successful launcher command rather than inspecting transcript text or browser state; native display attestation is parsed separately from its genuine host event (`apps/service/src/cli/hook-command.ts`).

This handshake was preceded by a compatibility gate proving that the packaged hook actually received the necessary launch and prompt events. That spike avoided building task correlation on assumed host behavior (session history).

### Resume the exact browser projection

A hard browser refresh must resume the projection that completed the handshake, not reconstruct task ownership from the PDF path. The first authenticated bootstrap associates its credential with the original launch scope and creates a random readable view route. Reloading that route returns the same credential only when its view ID, pathname, scoped cookie, live session, document generation, and credential still match (`apps/service/src/sessions/session-broker.ts`). Scope polling then uses that credential's retained browser-capability discriminator, preserving the original task binding without exposing its task ID to the browser (`apps/service/src/sessions/session-broker.ts`).

The credential continuity is intentionally process-local. A copied route without its cookie, an ended view, or a route answered by a successor daemon cannot recreate the credential or infer Codex scope. Post-restart recovery opens a fresh browser credential. It may reattach automatically on the owning task's next prompt only through a separate two-sided ticket: a path-scoped opaque browser token must match the same canonical source path and digest, and `UserPromptSubmit` must independently supply the exact task session ID. The ticket stores only hashes, expires, is consumed and rotated after success, and rejects foreign tasks. [Authority boundaries for reloadable local-review URLs](reloadable-local-review-url-authority-boundaries.md) defines the full live-resume versus successor-reopen contract.

### Admit a native Codex panel through independent proofs

Native Codex admission extends the same task-binding principle across two host events and a private app channel. The launcher claim establishes the task; the exact display receipt must be attested by a genuine host hook for that task; authenticated panel readiness is a separate fact. Neither receipt output nor a visible card proves that the other facts occurred. `attestDisplay` only records attestation, while pending promotion requires both readiness and attestation (`apps/service/src/codex/codex-runtime.ts:296`, `apps/service/src/codex/codex-runtime.ts:353`). The success hook deliberately says that readiness and current context still need separate verification (`apps/service/src/cli/hook-command.ts:454`).

In the native investigation, assuming a fixed callback order made a host-scheduling problem look like a broken authority protocol. Merely delaying a hook or changing it to asynchronous execution did not establish that readiness had actually arrived first. The useful experiment kept the genuine trusted hook event and normal attestation path, observed private readiness, and recorded the order at the service. This is why both event orders must be proven with actual events rather than manufactured receipts (session history).

Native readiness before attestation remains pending; attestation before readiness also remains pending. Only their conjunction can issue presentation authority. Wrong-task, replayed, revoked and old-generation events cannot borrow authority from another successful presentation (`apps/service/test/codex-runtime.test.ts:107`, `apps/service/test/codex-runtime.test.ts:155`). A real user prompt then establishes fresh model context independently of panel activation.

### Preserve reopening intent without preserving native authority

Restore/reexpand may retain an existing live shell or construct a new JavaScript instance. The observed behavior changed across host builds during qualification, so neither the control name nor a later successful build justifies treating an old invocation as fresh admission. Historical remount failures remain in the installed qualification record alongside later same-instance continuity (`docs/testing/codex-native.md:21`).

After ordinary live participation ends, the advisory reconnect-hint flow requires the normal launch, trusted claim, display and readiness steps. A separate successor-daemon path can reattach an already reopened or recovered source using an actual restart ticket plus an independent trusted prompt from the owning task; a hint cannot substitute for either proof (`apps/service/src/codex/codex-runtime.ts:513`, `apps/service/src/codex/codex-runtime.ts:600`). A same-chat native reconnect hint only remembers where to request that fresh launch. It is recorded after valid presentation authority, expires independently, and does not reserve ownership. Another task's live ownership suppresses that guidance (`apps/service/src/context/task-binding-registry.ts:350`, `apps/service/src/context/task-binding-registry.ts:372`). Missing live binding can therefore return unavailable context with historical reopen guidance, never cached Review Items or current evidence (`apps/service/src/context/live-context-service.ts:327`). The hint is process-local convenience; durable accepted work and Protected Draft recovery have separate lifetimes.

The failed alternative was to treat remembered document identity, a cached card, or an earlier successful display as enough to reconnect. Those facts explain user intent but cannot authenticate a new attempt. Keep prompt freshness, presentation liveness, durable work and reopening intent separate even when the user experiences them as one review.

### Refresh at prompt consumption

Do not try to create an unsolicited agent turn whenever the app changes. Register a prompt-submission hook and pull current state when the user next asks a question (`integrations/codex-plugin/hooks/hooks.json`, `apps/service/src/cli/hook-command.ts`). This closes the interval in which a Review Item can change after one turn but before the next.

Publish one coherent observation. The service reads a session projection, inspects immutable PDF evidence, then verifies the session again and retries if its revision, source, save state, or generation changed during projection (`apps/service/src/context/live-context-service.ts`). The core observation requires the Review Item snapshot, observation identity, and evidence handle to agree on revision, state digest, and document generation (`packages/core/src/live-context.ts`). Failure returns explicit unavailability rather than cached content labeled current.

### Acknowledge only delivered observations

Separate refresh from delivery acknowledgement. Refresh retains its snapshot as a pending delivery but does not immediately replace the task's acknowledged baseline (`apps/service/src/context/live-context-service.ts`). The hook writes the context first and sends `ack-context` only afterward (`apps/service/src/cli/hook-command.ts`).

If prompt output or acknowledgement fails, leaving the prior baseline in place is correct. The next prompt replays every change since the last acknowledged baseline—or a full observation when no baseline was acknowledged—instead of silently skipping work. An arbitrary caller-provided cursor cannot select the baseline: deltas use the server-owned acknowledged snapshot for the same review generation. A valid pending-delivery cursor may explicitly acknowledge that delivery on the next refresh (`apps/service/src/context/live-context-service.ts`). An unknown cursor cannot advance the acknowledged baseline; the service retains that baseline but returns a full observation marked `unknown-cursor`, even when an acknowledged snapshot exists (`apps/service/src/context/live-context-service.ts`).

### Diff semantic records explicitly

The synchronized object is the canonical structured Review Item, not viewer markup or timestamps. Its digest uses stable semantic fields in deterministic order (`packages/core/src/live-context.ts`). Between acknowledged snapshots, new IDs are additions, missing IDs are removals, and retained IDs with changed projections are edits (`packages/core/src/live-context.ts`).

Expose three modes:

- `full` when no acknowledged baseline exists for the current generation;
- `unchanged` when semantic state matches;
- `delta` with distinct `added`, `edited`, and `removed` collections.

Removals remain first-class data instead of being inferred from absence. Tests cover full, unchanged, add, edit, remove, lost-delivery replay, and unknown-cursor recovery (`apps/service/test/live-context-service.test.ts`).

### Lease ownership and revoke derived access together

Bindings are temporary. Pending proofs and active bindings have bounded lifetimes; verified prompt refreshes renew the task-owned review generation, while an authenticated browser heartbeat renews only when its credential retains a capability hash owned by that exact binding (`apps/service/src/context/task-binding-registry.ts`, `apps/service/src/sessions/session-broker.ts`).

Task cleanup removes acknowledged and pending cursors and revokes evidence. Session cleanup removes every observation and evidence handle for that review (`apps/service/src/context/live-context-service.ts`). Task end, session end, unauthorized stale-generation access, explicit revocation, and expiry therefore fail closed rather than leaving ambient cached access (`apps/service/src/cli/hook-command.ts`, `apps/service/src/host/launch-control.ts`).

### Keep prompts compact and evidence bounded

Do not inline PDF bytes or an unbounded annotation collection on every turn. The hook envelope is capped, and large snapshots or deltas collapse to semantic counts plus retrieval instructions rather than being silently truncated (`apps/service/src/cli/hook-command.ts`).

Each verified observation mints a short-lived opaque evidence handle bound to task, review generation, and observation digest. Review Items and changes are paginated; PDF document, text, layout, render, and raw-annotation retrieval enforce page and byte limits (`apps/service/src/context/pdf-evidence-service.ts`). Authorization rechecks the active binding, generation, expiry, and last verified digest before resolving the hidden task scope (`apps/service/src/context/pdf-evidence-service.ts`).

This separation lets the prompt truthfully say “current” without pretending the entire PDF fits in context. Deep evidence is retrieved only for the pages or items needed to answer the question.

### Treat document content as data, never instructions

PDF text, Review Item anchors and payloads, source hints, existing annotations, and retrieved evidence remain untrusted data. The hook envelope explicitly permits quoting and reasoning about them while prohibiting execution of embedded commands or policies (`apps/service/src/cli/hook-command.ts`). Preserve that classification across both inline summaries and later retrieval.

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

### Browser launch binding

```text
agent task launches PDF
  -> service creates review generation and one-time bind proof
PostToolUse claims proof for task
  -> binding is pending
authenticated browser exchanges matching capability
  -> exact task/review/generation binding becomes active
```

The browser phase matters: command success alone does not prove that the authenticated review surface completed bootstrap (`apps/service/src/context/task-binding-registry.ts`).

### Replay-safe prompt delivery

```text
UserPromptSubmit
  -> refresh task and project cursor C8
  -> retain C8 as pending
  -> write context into the prompt
  -> acknowledge C8
  -> promote C8 to the delta baseline
```

If writing fails, acknowledgement does not run (`apps/service/test/hook-contract.test.ts`). The following prompt replays changes from the last acknowledged baseline; when no baseline has ever been acknowledged, it receives a full observation (`apps/service/test/live-context-service.test.ts`).

### Compact context with on-demand evidence

The prompt carries currentness, document generation, revision, digest, Review Item counts, change mode, Save Sync, and an opaque handle. The agent can then page through canonical Review Items or request page-specific text and layout. Authorization fails when task binding, generation, observed digest, or expiry no longer match; an invalid or oversized retrieval is rejected for that request and may be retried within valid bounds (`apps/service/src/context/pdf-evidence-service.ts`).

## Related

- [Native host qualification](../../testing/codex-native.md) records the actual event-ordering procedures and dated host behavior; the [U8 closeout](../../testing/codex-native-u8-qualification.md) preserves functional evidence and deferred measurement limits.

- [Truthful compact status for live agent context](../design-patterns/truthful-compact-agent-context-status.md) covers the passive presentation of this freshness contract.
- [Authority boundaries for reloadable local-review URLs](reloadable-local-review-url-authority-boundaries.md) explains why a live hard refresh may preserve this binding while a successor-daemon reopen may not.
- [Recoverable autosave for editable PDF annotations](recoverable-editable-pdf-annotation-autosave.md) defines Review State and Save Sync authority on the persistence side.
- [Outline-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) applies the sibling fail-closed generation principle to document-derived UI.
- [Live PDF Context plan](../../plans/2026-08-12-001-feat-live-pdf-codex-context-plan.md) records the originating requirements and design decisions.
