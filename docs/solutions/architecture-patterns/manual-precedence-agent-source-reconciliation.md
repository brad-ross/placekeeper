---
title: Manual-precedence reconciliation for agent source work
date: 2026-08-12
category: architecture-patterns
module: Agent source reconciliation
problem_type: architecture_pattern
component: assistant
severity: high
applies_when:
  - An agent may process review feedback while a person continues editing annotations or source files
  - Equivalent human and agent work should deduplicate without losing attribution
  - Conflicting, moved, copied, removed, or ambiguous targets must preserve current manual state
  - Agent source edits must remain inside an approved root and ordinary permission boundaries
  - A run must account for every baseline item while preserving feedback added later
related_components:
  - source reconciliation service
  - live source workflow
  - approved source scope
  - Review Items
  - complete disposition
tags:
  - manual-precedence
  - source-reconciliation
  - execution-baseline
  - idempotent-proposals
  - conflict-detection
  - guarded-apply
  - source-scope
  - complete-disposition
---

# Manual-precedence reconciliation for agent source work

## Context

PDF review feedback can initiate source changes, but the agent is not the only writer. Between reading a Review Item and editing a source file, a person may edit or remove the item, change or duplicate its source target, apply an equivalent fix manually, or add new feedback. A direct annotation-to-replacement pipeline would either overwrite newer human work or guess from stale evidence.

The durable pattern is a conservative three-way workflow: capture an immutable execution baseline, register explicit proposals, reconcile each proposal against current review semantics and current source, permit ordinary editing only for a still-independent target, and finish with an exhaustive disposition. Earlier unconditional-apply thinking was insufficient once source could change after baseline capture; conflict behavior needed explicit service and browser coverage (session history).

## Guidance

### Capture a bounded execution baseline

At the beginning of source work, capture a versioned baseline containing the execution ID, live observation identity, complete structured Review Items, approved source fingerprints, and a canonical digest (`apps/service/src/context/source-reconciliation-service.ts:345-420`, `packages/core/src/live-context.ts:566-610`). Resolve a canonical approved source root and read only explicitly requested or source-hinted files.

Verify identity again after capture. Session, generation, review revision, source digest, and semantic Review Item digest must still match (`apps/service/src/context/source-reconciliation-service.ts:317-327`, `apps/service/src/context/source-reconciliation-service.ts:397-401`). The workflow refreshes around baseline capture and rejects a changed state digest (`apps/service/src/context/live-source-workflow-service.ts:175-204`).

Path authority is independent of model-provided text. Relative paths must stay within the canonical root and traverse no symlink ancestor; reads use no-follow semantics, byte limits, and before/after file identity checks before returning a fingerprint (`apps/service/src/files/source-scope.ts:17-41`, `apps/service/src/files/source-scope.ts:75-149`).

### Register explicit, idempotent proposals

A proposal names one baseline Review Item and carries a version, idempotency key, captured path, exact expected text, replacement text, and optional anchors (`apps/service/src/context/source-reconciliation-service.ts:31-40`). Accept it only if the item and path belong to that execution.

Canonically hash proposal content. Replaying the same key and content is safe; reusing a key for different content fails, and a baseline item accepts at most one proposal per execution (`apps/service/src/context/source-reconciliation-service.ts:424-458`). When expected text is unique in the baseline, retain its index and bounded surrounding context so unrelated edits can be tolerated without transferring authority to a copied string (`apps/service/src/context/source-reconciliation-service.ts:117-160`).

### Compare baseline, current state, and proposal

First classify the Review Item itself:

- missing current item → `removed`;
- changed structured item → `conflict` under manual authority;
- no proposal → `ambiguous` rather than inferred work;
- unchanged item with proposal → continue to source classification.

These checks happen before reading proposal sources, and post-baseline Review Items are reported separately rather than silently joining the execution (`apps/service/src/context/source-reconciliation-service.ts:475-545`, `apps/service/src/context/source-reconciliation-service.ts:573-600`).

Then compare captured source, proposed result, and current source:

- **equivalent:** the current source already expresses the result, including safe normalized or anchored equivalence; deduplicate under manual authority;
- **independent:** the unique expected target still maps to its captured context despite unrelated edits; only this result can authorize an apply;
- **conflict:** the target differs from both baseline and proposal or has moved outside safe context; preserve manual state;
- **ambiguous:** multiple targets or insufficient anchors prevent a unique decision; preserve source without guessing.

The classifier is intentionally asymmetric: copied or moved text is not independent merely because the expected string appears somewhere (`apps/service/src/context/source-reconciliation-service.ts:179-283`). Tests cover equivalent whitespace changes, unrelated edits, moved and copied targets, edited and removed items, and later feedback (`apps/service/test/source-reconciliation-service.test.ts:138-259`).

### Reconcile again immediately before writing

An independent result returns `applyGuardSha256`, the digest of the classified source (`apps/service/src/context/source-reconciliation-service.ts:546-571`). Immediately before the ordinary edit, reconcile again with that guard. If the digest changed, current manual state wins and the result becomes conflict or ambiguity (`apps/service/src/context/source-reconciliation-service.ts:210-225`).

This second check closes the check-to-write race. Do not obtain a new guard after an unexpected change and proceed as if nothing happened. The installed workflow requires an immediately-before-edit check and permits writing only while the result remains independent (`integrations/codex-plugin/skills/pdf-proofreader/SKILL.md:50-59`).

The service itself never writes source. The agent uses ordinary editing tools, preserving the host's sandbox, review, and approval boundaries (`apps/service/test/live-source-workflow.test.ts:142-165`).

### Refresh around every workflow transition

Begin, propose, reconcile, rebuild, and complete operations all obtain fresh task-scoped context (`apps/service/src/context/live-source-workflow-service.ts:175-314`, `apps/service/src/context/live-source-workflow-service.ts:374-407`). Task, review-session, and generation ownership remain valid throughout. Reconcile, rebuild, and completion additionally require the reconciliation report to match the fresh observation's generation and state digest (`apps/service/src/context/live-source-workflow-service.ts:458-466`), so a valid source classification cannot be paired with a different annotation set.

Discussion alone does not capture a baseline or authorize mutation. The installed protocol starts source work only when the user requests source changes or a clean rebuild (`integrations/codex-plugin/skills/pdf-proofreader/SKILL.md:36-45`).

### Keep rebuild execution outside the service

For a requested clean rebuild, the service validates the command, working directory, and distinct output path but does not execute the build. Ordinary shell tools run it with visible permissions and output (`apps/service/src/context/live-source-workflow-service.ts:249-295`). Verification then requires a newly observable, structurally valid PDF and rejects output containing baseline Review Items or other review annotations (`apps/service/src/context/live-source-workflow-service.ts:298-370`).

### Require an exhaustive disposition

Completion is a versioned audit record, not prose. Every baseline item needs exactly one terminal disposition; duplicate or missing IDs fail, explanations are required, and applied work names changed paths (`packages/core/src/disposition.ts:6-79`).

Reported status must agree with final reconciliation:

- equivalent → `already-satisfied`, unless guarded application is evidenced;
- independent → not applied until source becomes equivalent after the guarded edit;
- conflict → `skipped-conflict` or `adapted`;
- ambiguous → `skipped-ambiguous`;
- removed → `removed-before-processing`.

Later Review Items are emitted automatically as `preserved-unprocessed` and cannot be smuggled into baseline work (`apps/service/src/context/live-source-workflow-service.ts:374-406`, `packages/core/src/disposition.ts:81-101`).

## Why This Matters

“Manual wins” must be executable, not just prompt wording. Equivalent work deduplicates; conflicting, ambiguous, edited, moved, copied, and removed work preserves the current human-visible state; only a still-independent target becomes eligible for an agent write.

The baseline makes scope auditable, proposal idempotency makes retries stable, and the second digest guard closes the most dangerous race. Exhaustive disposition prevents the agent from reporting only successes or silently absorbing feedback created after work began.

Conservatism is intentional. Skipping an ambiguous change may require follow-up, but it avoids applying a correct replacement to the wrong occurrence.

## When to Apply

- Feedback has stable identity but may be edited or removed.
- Source targeting uses text plus contextual anchors.
- Humans or other tools can edit source concurrently.
- Equivalent work should collapse into one outcome.
- Unrelated manual edits should coexist with a valid proposal.
- Completion must account for feedback added during the run.

A direct edit is sufficient when the user supplies a fresh explicit location and replacement in the same turn and no captured review workflow or concurrent mutation window exists.

## Examples

### Equivalent manual edit

```text
baseline:       prefix old suffix
proposal:       old -> new
current source: prefix new suffix
classification: equivalent
action:         deduplicate
disposition:    already-satisfied
```

### Unrelated manual edit

If the expected target remains uniquely anchored while another part of the file changes, reconciliation can remain independent and return a guard. The agent rechecks the same guard immediately before replacing only the anchored target, then final reconciliation must observe equivalence (`apps/service/test/live-source-workflow.test.ts:128-170`).

### Late conflict

```text
first reconciliation: independent, guard H1
person edits file
guarded reconciliation: digest != H1
classification: conflict or ambiguous
action: preserve manual source
```

### Evolving review set

For baseline items A, B, and C, an edited A becomes conflict, a removed B becomes removed, and a new D appears only in `laterItems`. Completion supplies exactly one outcome for A/B/C and reports D as preserved and unprocessed (`apps/service/test/source-reconciliation-service.test.ts:228-259`).

## Related

- [Task-scoped, prompt-refreshed live PDF context](task-scoped-prompt-refreshed-live-pdf-context.md) supplies the fresh observation used by this workflow.
- [Recoverable autosave for editable PDF annotations](recoverable-editable-pdf-annotation-autosave.md) explains why current Review State is semantic authority.
- [Live PDF Context plan](../../plans/2026-08-12-001-feat-live-pdf-codex-context-plan.md) records the originating reconciliation requirements and decisions.
