---
title: Diagnose an open PDF with unbound agent context
date: "2026-09-12"
last_updated: "2026-09-12"
category: integration-issues
module: Live PDF Context
problem_type: integration_issue
component: assistant
severity: high
symptoms:
  - "The PDF opened in the task browser but agent context remained unavailable"
  - "A focused review launch silently failed to bind to a new task"
root_cause: logic_error
resolution_type: code_fix
tags: [live-pdf-context, task-binding, hooks, diagnostics, screenshot-staging]
---

# Diagnose an open PDF with unbound agent context

## Problem

A clean screenshot task opened the paper successfully but could not access agent context. Two independent problems were encountered: the skill encouraged a wrapper command the hook did not recognize, and a later recognized launch reused a review still owned by an earlier staging task. The second rejection was silently ignored by the hook.

## Symptoms

The reader could be open while the prompt envelope said `unavailable` / `unbound`. Reopening the same PDF returned `focused` without restoring ownership. Fixing command recognition alone did not repair the existing review collision.

| Checkpoint | What it establishes | Observed in this diagnostic run |
| --- | --- | --- |
| Opened/focused launch | Local launch succeeded, not task ownership | Yes |
| Hook recognized launch and response | Claim can be attempted | Yes |
| Association message | Claim returned pending or active, not necessarily current | Yes, for independent review |
| Browser showed updating | Browser reported intermediate context state | Yes |
| Fresh current prompt envelope | This prompt has a scoped observation | Not received on delegated verification prompt |
| Successful bounded evidence retrieval | Requested evidence was retrieved under that scope | Not verified |

The claim statuses and browser currentness checks are distinct in `apps/service/src/context/task-binding-registry.ts`; do not collapse them into a single “connected” Boolean.

## What Didn't Work

- The former instruction to use an argument array induced a Python subprocess wrapper. It opened the PDF but did not match the hook's direct-launch contract. Retrying inside another wrapper would preserve the failure.
- Guessing that Codex's shell tool name was incompatible was not supported by the actual payload. Temporary diagnostics showed `PostToolUse`, tool `Bash`, recognized command and recognized JSON response, followed by a service binding result of `denied`.
- Treating browser success as binding success obscured the failure. Repeatedly focusing a review owned by an older staging task cannot grant ownership to a fresh task.
- Sending another prompt from the coordinating task did not provide a fresh live-context envelope in the target task during this session. That delivery behavior is an observed host limitation here, not a universal API guarantee.

## Solution

The current skill requires the installed launcher to be the first executable in one direct shell command, with literal quoted arguments and an undecorated JSON response. It explicitly prohibits Python/Node/shell wrappers, pipes, chaining, and output decoration. See `integrations/codex-plugin/skills/placekeeper/SKILL.md:14`.

The claim branch now emits an explicit recovery message on denial rather than ignoring it (`apps/service/src/cli/hook-command.ts:403`). The message keeps both possible causes visible: another task may own the review, or the proof may have expired. A generic denial does not justify identifying another owner to the caller. The registry also denies invalid identifiers, missing or consumed proofs, mismatched scope, and competing pending claims. The warning names useful possibilities, not an exhaustive diagnosis. A proof is consumed before later ownership checks, so replay cannot repair denial. `apps/service/test/hook-contract.test.ts` checks the warning and absence of task IDs, proofs, file paths, and capability URLs.

For the actual staging collision, an independent review was opened with `--fork` in the intended task. The hook confirmed association and the browser showed context updating. Earlier reviews remained intact. Use that option only when the user requests an independent review, following the installed skill's current recovery rules; do not steal another task's binding.

The source changes are present on the working branch as of this date, with 30 targeted hook/registry tests passing. The installed hook was updated and temporary probes removed. Association was verified, but the later coordinated verification prompt received no fresh envelope, so **scoped page-text retrieval was not verified in that diagnostic run**. A user-originated follow-up was requested. Do not turn the later screenshot or its green icon into retrospective proof of an evidence retrieval that was not observed.

## Why This Works

The registry deliberately denies competing task/review associations (`apps/service/src/context/task-binding-registry.ts`, `claim`). Preserving that exclusion is correct. The fix is truthful launch recognition and failure reporting, with an independent review when appropriate; it is not weakening task isolation. Authenticated browser bootstrap, task association, prompt observation, and evidence retrieval are separate checkpoints.

## Prevention

Investigate in this order:

1. Inspect the exact installed skill and actual launch command shape. The source skill and cached installed skill can differ; do not overwrite an old installed skill wholesale with newer recovery flags unsupported by its runtime.
2. Confirm the hook event arrived. If instrumentation is needed, log only event name, tool name, payload key names/types, parser booleans, and result status. Do not log proof values, capability URLs, document content, or task secrets.
3. Separate parsing failure from control-service rejection. A recognized launch plus `denied` is a different fault from a command the parser ignored.
4. Preserve exclusivity. Explain a review conflict and offer an independent review when the user wants both tasks; don't replay proofs, guess task IDs, or borrow cached context.
5. Verify association, browser bootstrap, a **new prompt's current envelope**, and one bounded evidence retrieval through that envelope's handle. If a delegated prompt supplies no envelope, have the user send a normal message in that task.
6. Never simulate hook events or substitute a different task identity to make verification pass. Remove diagnostics, test both denied and accepted paths, and record precisely which verification checkpoints passed. Do not call the entire workflow verified after only the launcher succeeds.

## Related

- [Task-scoped, prompt-refreshed live PDF context](../architecture-patterns/task-scoped-prompt-refreshed-live-pdf-context.md)
- [Real app surface screenshot workflow](../workflow-issues/refresh-real-app-surface-screenshots.md)

- [Truthful compact agent-context status](../design-patterns/truthful-compact-agent-context-status.md)
