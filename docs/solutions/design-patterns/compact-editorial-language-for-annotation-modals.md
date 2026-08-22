---
title: Compact Editorial language for modal and recovery surfaces
date: 2026-08-21
last_updated: 2026-08-21
category: design-patterns
module: PDF review modal presentation
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Several related modal workflows have drifted in hierarchy, terminology, or action styling"
  - "Create and edit flows need concise but distinct action semantics"
  - "Visible field labels repeat an already-specific modal title while accessible field names must remain intact"
  - "A dedicated recovery page should reuse modal structure without claiming dialog semantics or owning lifecycle authority"
  - "Ordinary and conditional states need content-fitting geometry plus deterministic semantic and visual validation"
related_components:
  - "CommentComposer"
  - "SaveDestinationDialog"
  - "ReviewShell"
  - "Annotation Tray"
  - "terminal recovery"
  - "review harness"
  - "testing_framework"
tags:
  - "compact-editorial"
  - "modal-language"
  - "annotation-composer"
  - "save-destination"
  - "action-semantics"
  - "accessible-labels"
  - "visual-consistency"
  - "content-fitting-layout"
---

# Compact Editorial language for modal and recovery surfaces

## Context

Placekeeper has modal workflows that should feel related but do different jobs. `CommentComposer` owns free-form annotation text, validation, keyboard submission, and focus restoration (`apps/web/src/review/CommentComposer.tsx:19-44`, `apps/web/src/review/CommentComposer.tsx:67-115`). `SaveDestinationDialog` owns destination selection, filename proposal synchronization, rewrite eligibility, and recovery actions (`apps/web/src/save/SaveDestinationDialog.tsx:24-50`, `apps/web/src/save/SaveDestinationDialog.tsx:76-123`). Treating each as a visual one-off allowed their hierarchy, wording, and controls to drift away from the surrounding Warm Neutral interface.

The durable solution is a shared presentation grammar, not a shared stateful modal component. Both surfaces opt into `compact-editorial-modal` and its header, body, and footer hooks while retaining their own state and outcomes (`apps/web/src/review/CommentComposer.tsx:46-115`, `apps/web/src/save/SaveDestinationDialog.tsx:51-75`, `apps/web/src/save/SaveDestinationDialog.tsx:184-209`). [PR #46](https://github.com/brad-ross/placekeeper/pull/46), merged on 2026-08-21, established this grammar.

The same grammar now also covers a structurally different surface: the successor-daemon page that reopens an interrupted Placekeeper session. That page is centered on an otherwise inert document canvas and explicitly remains a page rather than a dialog over an interactive review (`apps/web/src/app/review-layout.css:6-39`). It reuses the visual hierarchy without moving the gesture-gated reopen, protected-draft choices, or Codex task reattachment into presentation code. Earlier versions required two reopen confirmations, exposed internal-looking identifiers, used review-oriented copy, and reserved empty layout rows; the settled surface uses one **Reopen** action, a filename-led title, session terminology, and content-driven height (session history). This implementation is pending in [PR #48](https://github.com/brad-ross/placekeeper/pull/48).

Planning exposed one especially useful boundary: an early acceptance rule required a visible Cancel action while also prohibiting any change to the optional-highlight action set. That was inconsistent because keeping a highlight without a comment and cancelling the annotation are distinct outcomes. The final grammar exposes both instead of overloading one control (session history).

## Guidance

### Share structure and visual tokens

Use a small set of stateless hooks for the common frame:

- Put a direct task title in the header, task-specific controls in the body, and actions in a restrained footer. The shared surface defines a three-row grid, consistent dividers, spacing, type hierarchy, body scrolling, and footer treatment (`apps/web/src/app/review-layout-dialogs.css:53-100`).
- Reuse the application's `review-button` vocabulary. The common rule owns height, centering, icon-and-label spacing, inherited type, and horizontal padding; primary styling remains an explicit modifier (`apps/web/src/app/review-layout-dialogs.css:1-41`).
- Reuse the nearest established selection pattern instead of inventing modal-only radio cards. Save Destination choices use workspace card surfaces, hover treatment, selection color, and a left selection marker (`apps/web/src/app/review-layout-dialogs.css:146-183`).

Do not promote the shared frame into a configurable “god modal.” Save Destination resets and reconciles a proposed filename, while the composer validates text, traps focus, restores its trigger, and can keep an optional highlight without text (`apps/web/src/save/SaveDestinationDialog.tsx:24-47`, `apps/web/src/review/CommentComposer.tsx:31-44`, `apps/web/src/review/CommentComposer.tsx:94-104`). Share tokens, classes, and copy rules; keep domain state and transitions in the owning component.

### Extend the grammar to lifecycle-owned recovery pages

A dedicated recovery page may reuse the same header, body, footer, button, focus, and responsive tokens without becoming an application dialog. The terminal recovery renderer derives `Reopen <filename>`, builds icon-and-label **Copy Link** and **Reopen** controls, and keeps status and conditional choices in the body (`apps/web/src/production-entry.tsx:73-132`, `apps/web/src/production-entry.tsx:183-212`, `apps/web/src/production-entry.tsx:286-338`). The card shares foundation and button rules with the application while retaining recovery-specific DOM and transitions (`apps/web/src/app/review-layout-dialogs.css:1-59`).

Keep authority below that presentation layer. The ordinary **Reopen** click sends the confirmed same-origin request; when no protected draft intervenes, the fresh session mounts directly without a second “Open this PDF” step (`apps/web/src/production-entry.tsx:232-260`, `test/acceptance/reloadable-links.spec.ts:485-490`). Only a service-issued recovery offer expands the body into **Resume draft**, **Discard draft**, and **Open separate copy**. Retries preserve one operation ID for the same decision and use different IDs for different decisions (`apps/web/src/production-entry.tsx:134-143`, `test/acceptance/reloadable-links.spec.ts:597-617`). Codex reattachment remains a separate two-sided authorization flow, so the page never presents task identity as another recovery choice. The authority contract belongs in [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md).

Let content determine the shape. The card uses a bounded three-row grid and an overflow-capable body; an empty action region is removed from layout, while protected-draft choices switch that region to a grid (`apps/web/src/app/review-layout.css:24-39`, `apps/web/src/app/review-layout.css:64-71`, `apps/web/src/app/review-layout.css:105-130`). The ordinary state therefore fits its explanation and shared padding, the footer stays one control row high when copy status is empty, and the same card grows only when a real conditional decision appears. Do not encode separate magic heights for ordinary and protected states.

### Let the title carry context without weakening accessibility

Supporting copy belongs only where it answers a question the title cannot. Save Destination explains that the choice can be changed later (`apps/web/src/save/SaveDestinationDialog.tsx:69-73`). A single-field composer titled “Replacement” should not visibly repeat “Replacement” immediately above its text area.

Removing visible repetition must not remove the field's accessible name. `CommentComposer` keeps the label in an `sr-only` span and supplies the same value as the textarea title (`apps/web/src/review/CommentComposer.tsx:67-81`). Focus and disabled-state rules also name `.compact-editorial-modal` directly because Save Destination can be mounted outside `.review-shell` (`apps/web/src/app/review-layout-foundation.css:85-97`).

Retain visible labels when the body has several controls or the field would otherwise be ambiguous. Save Destination correctly keeps “Copy name” beside its filename input (`apps/web/src/save/SaveDestinationDialog.tsx:149-176`).

### Make action labels describe the transition

Use verbs consistently:

| Transition | Label |
| --- | --- |
| Create a comment or Page Note | **Save** |
| Apply replacement or insertion text | **Apply** |
| Edit an existing Review Item | **Apply** |
| Establish save settings | **Confirm** |
| Preserve a highlight without a comment | **Keep** |
| Abandon the pending action | **Cancel** |

For optional Highlight Comment, render all three truthful outcomes—Cancel, Keep, and Save—because dismissal, retention without text, and retention with text are separate transitions (`apps/web/src/review/CommentComposer.tsx:84-115`). `ReviewShell` supplies concise noun titles and the Apply override without moving workflow logic into the presentational component (`apps/web/src/app/ReviewShell.tsx:1314-1335`, `apps/web/src/app/ReviewShell.tsx:1337-1375`, `apps/web/src/app/ReviewShell.tsx:1377-1404`).

### Test semantics and appearance separately

Deterministic preview routes make every composer variant reviewable without reproducing its PDF gesture. The harness enumerates four creation states and four edit states with exact titles, field names, actions, and representative content (`test/acceptance/review-harness/main.tsx:34-77`). Always include a valid visual scene in a preview URL: the harness applies production-root styling only when a visual scenario resolves (`test/acceptance/review-harness/main.tsx:34-50`). An unstyled raw harness route is not evidence of a product CSS regression.

Use three complementary layers:

1. Semantic component and workflow tests assert accessible names, action labels, cancellation, submission, focus, and draft preservation.
2. Production flows prove that the same wording works through real annotation and Save Destination lifecycles.
3. Visual and geometry tests cover modal snapshots, narrow containment, touch target height, visible initial focus, and reduced motion (`test/acceptance/review-visual.spec.ts:576-607`, `test/acceptance/review-visual.spec.ts:610-640`).

For a lifecycle-owned recovery page, add state-coupled geometry assertions rather than relying on a screenshot alone. The ordinary successor flow measures that empty status and action regions contribute no height and that the footer equals its control row plus padding and border (`test/acceptance/reloadable-links.spec.ts:375-418`). The protected-draft flow proves that discovered choices make the same card taller, while the touch-viewport flow proves containment and controls of at least 44 pixels (`test/acceptance/reloadable-links.spec.ts:538-555`, `test/acceptance/reloadable-links.spec.ts:663-698`). Run these lifecycle assertions in both Chromium and WebKit because a visually correct static shell does not prove the reopen state machine.

Keep responsive and motion behavior in the shared grammar. Composer sheets become bottom-aligned and full width on small screens, modal controls receive touch height, and the establishing spinner is disabled under reduced motion (`apps/web/src/app/review-layout-responsive.css:41-53`, `apps/web/src/app/review-layout-responsive.css:117-124`, `apps/web/src/app/review-layout-responsive.css:215-228`).

## Why This Matters

Modal polish is not merely cosmetic. Titles and action verbs tell a reviewer whether they are creating content, applying a transformation, preserving an annotation without text, or changing a save contract. Ambiguous wording hides materially different outcomes; explicit actions make the state transition legible.

The presentation-only boundary also limits regression risk. One visual system can cover both modal families without disturbing filename reconciliation, save recovery, optional-comment semantics, keyboard submission, or focus restoration. This preserves the behavioral invariants identified during planning—focus containment, responsive draft preservation, recovery actions, and command isolation—while allowing the presentation to evolve (session history).

That boundary matters even more for interrupted-session recovery. A stale page must not inspect the PDF or restore browser or task authority on `GET`; one explicit **Reopen** gesture crosses the confirmation boundary, and only discovered protected work expands the decision. Reusing the modal grammar makes this security-owned state machine legible without turning appearance into authority. Removing empty layout regions is part of the same truthfulness: the ordinary card looks like a small task, while protected work visibly increases the amount of decision content (session history).

The test split prevents three different kinds of drift. Semantic assertions catch language and accessibility mistakes. Production flows catch lifecycle regressions. Visual and geometry checks catch spacing, containment, alignment, and motion regressions. A stylesheet-shape assertion alone cannot provide all three.

## When to Apply

Apply this pattern when:

- several dialogs belong to one product surface but retain distinct state machines;
- the task title already identifies a single input and its visible label adds no information;
- creation and editing need different action verbs;
- an optional step has more than two truthful outcomes;
- modal choices should echo an established tray or list pattern;
- copy and layout must be reviewed across desktop, narrow, recovery, disabled, and reduced-motion states.
- a dedicated recovery page should look related to application dialogs while remaining outside the interactive application mount;
- conditional risk or protected work should expand one bounded card instead of reserving empty space in the ordinary state.

Do not use it to collapse distinct workflows into one conditional component, remove labels from multi-field forms, or force task-specific recovery actions into generic verbs. Retry, Locate PDF…, and Return to annotations remain specific because they perform different recovery transitions (`apps/web/src/save/SaveDestinationDialog.tsx:76-121`).

Do not use shared modal language to make a stale route act like a live dialog. The recovery page may borrow presentation hooks, but service-owned confirmation, draft offers, idempotency, source validation, and task reattachment remain outside the visual grammar.

## Examples

| Context | Drifted wording | Compact Editorial wording |
| --- | --- | --- |
| Create replacement | “Replacement Text” plus a repeated field label | “Replacement,” hidden accessible field name, **Apply** |
| Create insertion | “Insertion Text” plus a repeated field label | “Insertion,” hidden accessible field name, **Apply** |
| Edit insertion | “Edit Insert” and **Save** | “Edit Insertion” and **Apply** |
| Add Page Note | Visible “Comment” and **Save comment** | Hidden accessible “Comment” and **Save** |
| Add highlight without a comment | One overloaded keep/dismiss action | **Cancel**, **Keep**, and **Save** |
| Reopen an ordinary interrupted session | **Reopen review**, then a second open confirmation | Filename-led title with **Copy Link** and one primary **Reopen** |
| Reopen with protected work | Always-visible or client-invented draft controls | Expand only after the service returns **Resume draft**, **Discard draft**, and **Open separate copy** |

```tsx
// Share presentation hooks and action vocabulary.
<section className="save-destination-dialog compact-editorial-modal">…</section>
<div className="comment-composer compact-editorial-modal">…</div>

// Keep field naming available to assistive technology without visual repetition.
<label className="comment-composer__field">
  <span className="sr-only">{fieldLabel}</span>
  <textarea title={fieldLabel} />
</label>

// A dedicated recovery page can reuse structure without becoming a dialog.
<main className="terminal-recovery">
  <header>Reopen Paper.pdf</header>
  <section>{serviceOwnedRecoveryState}</section>
  <footer>{copyLink}{reopen}</footer>
</main>
```

This is the useful abstraction level: shared visual structure and language rules, separate components or pages for save-domain, annotation-domain, and successor-recovery behavior.

## Related

- [Content-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) supplies the compact tray-entry precedent reused by Save Destination choices.
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md) distinguishes visible control copy, accessible names, and tooltip ownership.
- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) owns the Save Destination and recovery lifecycle that this presentation pattern must preserve.
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) applies the same presentation-versus-lifecycle ownership boundary to the workspace.
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) shows the complementary browser-validation pattern for compact control reuse.
- [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) owns the inert stale route, explicit reopen gesture, protected-draft offer, and independent Codex reconnect authority that this recovery presentation must not widen.
