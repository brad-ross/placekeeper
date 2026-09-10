---
title: "Compact Editorial language for review task and recovery surfaces"
date: "2026-08-21"
last_updated: 2026-09-10
category: "design-patterns"
module: "PDF review task and recovery surface presentation"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Related task surfaces need consistent hierarchy, terms, and action styling"
  - "A direct title can replace redundant supporting copy without weakening accessible labels"
  - "Dialogs, nonmodal composers, recovery pages, and settings share presentation while retaining lifecycle owners"
  - "Create, edit, recovery, and preference flows need concise distinct action semantics"
  - "A blocked document action should route to the workspace that owns recovery"
related_components:
  - "CommentComposer"
  - "SaveDestinationDialog"
  - "ReviewShell"
  - "ReconciliationWorkspace"
  - "DocumentActionsMenu"
  - "terminal recovery"
  - "Chrome extension popup"
tags:
  - "compact-editorial"
  - "annotation-composer"
  - "save-destination"
  - "chrome-extension-popup"
  - "action-semantics"
  - "accessible-labels"
  - "visual-consistency"
  - "content-fitting-layout"
---

# Compact Editorial language for review task and recovery surfaces

## Context

Placekeeper's annotation editor, Save Destination dialog, interrupted-session page, extension popup, and reconciliation tasks should look related while retaining distinct behavior. The durable abstraction is shared presentation and action language, not a stateful universal modal. Historical presentation work appears in [PR #46](https://github.com/brad-ross/placekeeper/pull/46) and [PR #48](https://github.com/brad-ross/placekeeper/pull/48). [PR #87](https://github.com/brad-ross/placekeeper/pull/87), open as of September 7, 2026, extends this presentation sharing to recovery; it is not yet a merged-release guarantee.

Current presentation follows the [accepted neutral interface contract](../../plans/2026-09-05-neutral-soft-design-contract.md). References to the earlier Warm Neutral palette, left selection marker, or a universal bottom-on-narrow composer are historical. The current editor is passage-attached with a geometry-driven fallback; late neutral CSS also overrides earlier dialog and control styling. Those changes preserve the shared grammar without making appearance responsible for lifecycle.

`SaveDestinationDialog` owns filename synchronization, rewrite eligibility, modal focus, and confirmation (`apps/web/src/save/SaveDestinationDialog.tsx`). `CommentComposer` owns mutable text and local actions, while `useAuthoringSession` owns frozen authoring authority, protected drafts, command sequencing, and settlement. `ReviewShell` composes workspace and reader callbacks. A recovery page owns neither workflow: its renderer coordinates service-issued recovery responses outside the live review mount (`apps/web/src/production-entry.tsx`). Sharing hooks must not collapse these owners.

## Guidance

### Share hierarchy and tokens, not transitions

Use direct titles, bounded bodies, and restrained actions. A true dialog may use a footer; a single-field composer keeps actions directly under its input. Historically named `compact-editorial-modal` classes remain presentation hooks, not proof that the component is modal. Save Destination explicitly declares dialog semantics and traps focus; the composer uses its own form and local keyboard handling (`apps/web/src/save/SaveDestinationDialog.tsx`, `apps/web/src/review/CommentComposer.tsx`).

Read the effective production cascade rather than copying older declarations. An earlier copied recovery stylesheet missed later production overrides, so sharing familiar class names still produced different controls. The current app imports shared design tokens and modal styling through `apps/web/src/app/review-layout-foundation.css` and `apps/web/src/app/review-layout-dialogs.css`; the extension imports those same files at `apps/chrome-extension/src/extension.css`. Mac recovery imports the extension presentation before its host-specific wrapper (`apps/web/src/macos-recovery-entry.ts`). The shared rules live in `apps/web/src/app/review-design-tokens.css` and `apps/web/src/app/review-modal-surface.css`.

Compare computed styles against the actual current Save Destination scene, including focused actions and narrow widths. The parity test compares recovery with the styled Save Destination surface at 1280, 620, and 360 pixels (`test/acceptance/macos-interface.spec.ts`). The 360-pixel check exposed a 12-versus-16-pixel padding mismatch that wider scenes missed. That was a reason to remove copied declarations and share the effective styles, not add another isolated override. The test compares surface, heading, description, and primary/secondary control properties (`test/acceptance/macos-interface.spec.ts`); it does not claim that distinct content must have identical overall dimensions.

Lifecycle remains specific. Save Destination resets proposed choices on open but preserves a filename the user has edited when a new proposal arrives (`apps/web/src/save/SaveDestinationDialog.tsx`). The authoring hook instead freezes the source, protects generated-output drafts, and restores the originating workspace or reader (`apps/web/src/review/use-authoring-session.ts`). Share typography, surfaces, spacing, and copy rules while keeping those transitions separate.

### Let titles reduce repetition without removing names

A single-field task titled Replacement need not visibly repeat Replacement above its textarea. Keep the field's accessible label in a screen-reader-only span and retain an explicit native title policy (`apps/web/src/review/CommentComposer.tsx`). Several-control forms still need visible field labels; removing them would trade a cleaner screenshot for ambiguity.

Supporting copy should answer a question the title does not. Save Destination explains either later changeability or why a private browser source is not modified (`apps/web/src/save/SaveDestinationDialog.tsx`). Avoid repeating a task name as title, subtitle, label, and status.

Tooltip presentation is separate from naming. Compact actions can use the shared delayed-hover and eligible-keyboard-focus tooltip; literal controls still declare their native policy. Follow the [shared tooltip contract](../conventions/native-control-tooltip-contract.md), rather than assuming every compact action must expose a native title or that visible text replaces an accessible name.

### Name the actual outcome

Use Save for a new comment or Page Note, Apply for proposed replacement/insertion text and existing-item edits, Confirm for save settings, and Cancel for abandonment. The composer exposes Cancel and its context-specific submit label (`apps/web/src/review/CommentComposer.tsx`). Keep the Confirm label stable while a spinner communicates establishment progress (`apps/web/src/save/SaveDestinationDialog.tsx`).

Optional highlight comments no longer require a separate Keep action. Save with an empty comment preserves the highlight, while Cancel abandons the pending annotation. Optional content is eligible for submission, and submission passes the current value to the save callback (`apps/web/src/review/CommentComposer.tsx`). Preserve that distinction in behavior and tests without preserving the obsolete three-button presentation.

Specific recovery verbs remain specific. Retry, Return to annotations, and locating a PDF express different transitions; a shared grammar should not rename all recovery actions Confirm (`apps/web/src/save/SaveDestinationDialog.tsx`).

### Keep the editor local to its passage

The current composer chooses side, below, above, or bottom-sheet placement according to usable geometry, retaining a viable previous placement to avoid oscillation. It does not become a bottom surface solely because a width breakpoint was crossed (`apps/web/src/review/use-passage-editor-placement.ts`). After the passage leaves view, the editor remains at its last usable clamped position rather than chasing it offscreen (`apps/web/src/review/use-passage-editor-placement.ts`).

Frozen source authority, provisional marks, conditional Back to passage, and nested Save Destination handling belong to the [Contextual Annotation Composer learning](contextual-annotation-composer-preserves-document-context-during-authoring.md). Presentation should preserve those behaviors rather than import the former distant-edge takeover as a layout requirement.

### Reuse the grammar for service-owned recovery

An interrupted-session route is a page, not a dialog over interactive PDF content. Its filename-led heading and Copy Link/Reopen actions share the visual hierarchy, while service responses own recovery choices (`apps/web/src/production-entry.tsx`).

One explicit Reopen gesture sends a confirmed request. An opened/focused response navigates directly to the returned session URL; a service-issued recovery offer expands the page into protected-work choices. The client does not invent those choices before discovering protected work (`apps/web/src/production-entry.tsx`). The renderer retains one operation ID per decision for retries and clears those IDs when an offer changes (`apps/web/src/production-entry.tsx`). Resume draft, Discard draft, and Open separate copy remain distinct service decisions.

Task reattachment remains an independent authorization flow. Sharing a visual card never grants a stale route live task identity or permission to reconnect it. The [reloadable URL authority contract](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) owns source validation, confirmation, offers, idempotency, and two-sided task reattachment; this presentation convention must not widen them.

Let content drive height. The recovery card is a bounded grid with an overflow-capable body, and empty action/status regions do not reserve space (`apps/web/src/app/review-layout.css`). Protected-work choices grow the same card instead of requiring separate magic heights. This keeps an ordinary reopen small while allowing actual decisions room.

The Chrome handler and Mac recovery share the actual recovery-button construction, including distinct Discard, Fork, and Resume decisions (`apps/chrome-extension/src/handler-ui.ts`, `apps/web/src/macos-recovery-entry.ts`). Sharing these controls does not merge host lifecycle: the Mac bridge settles one decision locally and reports failure through its own status region (`apps/web/src/macos-recovery-entry.ts`). Native validation independently requires the expected main-frame URL and an allowed, one-time decision (`apps/macos/Sources/PlacekeeperMac/RecoveryViewController.swift`).

On Mac, the native window is a transparent content host rather than a second visible card or titlebar around the web card. Its borderless shell disables the native shadow and leaves the web surface responsible for the visible card (`apps/macos/Sources/PlacekeeperMac/RecoveryViewController.swift`). Retain standard close and minimize controls, with zoom disabled (`apps/macos/Sources/PlacekeeperMac/RecoveryViewController.swift`). A native drag region sits above the WKWebView, and the standard controls are installed above that region so dragging does not consume their clicks (`apps/macos/Sources/PlacekeeperMac/RecoveryViewController.swift`). These are host behaviors; reproducing traffic lights in HTML would not provide them.

Let the web content report its measured height as it changes (`apps/web/src/macos-recovery-entry.ts`). The native receiver validates the source frame/URL, exact message shape, finite height, and bounded range before resizing (`apps/macos/Sources/PlacekeeperMac/RecoveryViewController.swift`). This lets status and recovery choices fit the same card without assigning each state an unrelated fixed window height. Verify actual native close, minimize, drag, and content fitting separately from browser CSS parity.

### Keep short-lived popup hydration quiet

A browser popup document is recreated on every opening. Static Reading… text would therefore replay even when the preference is already persisted. Current markup supplies a Placekeeper heading, one Open PDFs automatically switch, and an empty live status region (`apps/chrome-extension/popup.html:10`). Runtime disables the control until authoritative state resolves and updates an ordinary successful read silently (`apps/chrome-extension/src/popup-entry.ts`).

Status appears for meaningful repair, an explicit mutation, or failure. A synchronization mismatch pauses automatic opening; click-time changes communicate progress and outcome (`apps/chrome-extension/src/popup-entry.ts`). Reads and writes are bounded; if enabling the MIME handler fails after the sentinel write, the setting code attempts sentinel rollback (`apps/chrome-extension/src/opt-in.ts`). Quiet hydration must not mean an indefinitely inert control or silent failure.

The semantic switch and its visual state come from the same authoritative value. Popup focus behavior also preserves input intent: keyboard activation restores switch focus, while ordinary initial hydration can leave focus on the heading (`apps/chrome-extension/src/popup-entry.ts`). These belong to the popup runtime, not the web app's modal state machine.

### Route blockers to the task that owns recovery

Generated-PDF reconciliation presents unresolved work as tasks ahead of ordinary annotations (`apps/web/src/app/ReviewShell.tsx`). Selecting a record opens its apply or reattach detail directly; discard remains a distinct destructive choice (`apps/web/src/review/ReconciliationWorkspace.tsx`). The live PDF selection/caret supplies reattachment candidates and Confirm checks document generation before submission (`apps/web/src/review/ReconciliationWorkspace.tsx`). Do not add a second PDF preview or mode-selection step merely to make this resemble a generic wizard.

Completion closes the detail and repairs focus to another task or a stable fallback. When no work remains, the section disappears instead of leaving a permanent success or empty-state block (`apps/web/src/review/ReconciliationWorkspace.tsx`).

Reviewed export stays a document action. Its presentation derives eligibility and annotation blockers from the canonical summary, and the title menu shows the blocker alongside Open Annotations (`apps/web/src/review/DocumentActionsMenu.tsx`). That action closes the menu and opens the owning workspace, focusing its first available task. If authoring is already active, it preserves and refocuses the editor instead (`apps/web/src/app/ReviewShell.tsx`, `apps/web/src/review/ReconciliationWorkspace.tsx`). Eligibility, pending/results, and recovery routing must move together if the command changes presentation.

## Why This Matters

Appearance communicates whether the user is creating text, preserving a mark, changing save settings, reopening a session, or resolving blocked work. Compactness is useful only when it keeps those outcomes legible.

The presentation boundary allows one coherent interface without mixing authority. A modal traps focus, an anchored editor preserves a frozen draft source, a stale page asks the service to reopen, and a browser popup reads persisted preference state. None gains another's permissions or lifecycle because they share spacing and colors.

## When to Apply

Use this pattern for related tasks with different state machines, especially when titles already carry single-field context or conditional work should expand a bounded surface. Do not remove useful labels from multi-field forms, merge distinct outcomes, or treat a recovery page as an already-live application dialog.

Validate semantic, workflow, and visual evidence independently. Component tests prove labels and transitions; installed flows prove real save/recovery behavior; styled visual scenes prove geometry, and computed-style parity proves that shared controls track the current production cascade (`test/acceptance/macos-interface.spec.ts`). A raw unstyled harness route is not product CSS evidence. Rebuild installed assets and confirm the intended scene and stylesheet before diagnosing layout.

Recovery coverage measures empty status/footer geometry and touch controls (`test/acceptance/reloadable-links.spec.ts`). Popup contracts verify concise structure and inert startup (`apps/chrome-extension/test/extension-contract.test.ts`). Export coverage follows Open Annotations into recovery (`test/acceptance/production-flow.spec.ts`). Keep these lifecycle assertions alongside screenshots; a correct static card cannot prove recovery authority or draft preservation.

## Examples

A replacement task shows one title, an accessibly named textarea, and Cancel/Apply. A highlight comment shows Cancel/Save: saving an empty comment preserves the highlight, while cancelling abandons it (`apps/web/src/review/CommentComposer.tsx`).

An ordinary interrupted session shows Reopen and fits its brief explanation. Only a returned recovery offer expands it into protected-draft decisions, each retaining its own retry identity.

A disabled Export action explains unresolved annotation work and offers Open Annotations beside it. The menu owns command presentation; the focused task owns resolution.
