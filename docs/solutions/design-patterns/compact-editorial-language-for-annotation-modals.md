---
title: Compact Editorial language for annotation modals
date: 2026-08-21
category: design-patterns
module: PDF review modal presentation
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Several related modal workflows have drifted in hierarchy, terminology, or action styling"
  - "Create and edit flows need concise but distinct action semantics"
  - "Visible field labels repeat an already-specific modal title while accessible field names must remain intact"
  - "A dialog should match the surrounding Warm Neutral interface without changing its state or focus behavior"
  - "Live polish needs deterministic previews for every modal variant before approval"
related_components:
  - "CommentComposer"
  - "SaveDestinationDialog"
  - "ReviewShell"
  - "Annotation Tray"
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
  - "deterministic-previews"
---

# Compact Editorial language for annotation modals

## Context

Placekeeper has modal workflows that should feel related but do different jobs. `CommentComposer` owns free-form annotation text, validation, keyboard submission, and focus restoration (`apps/web/src/review/CommentComposer.tsx:19-44`, `apps/web/src/review/CommentComposer.tsx:67-115`). `SaveDestinationDialog` owns destination selection, filename proposal synchronization, rewrite eligibility, and recovery actions (`apps/web/src/save/SaveDestinationDialog.tsx:24-50`, `apps/web/src/save/SaveDestinationDialog.tsx:76-123`). Treating each as a visual one-off allowed their hierarchy, wording, and controls to drift away from the surrounding Warm Neutral interface.

The durable solution is a shared presentation grammar, not a shared stateful modal component. Both surfaces opt into `compact-editorial-modal` and its header, body, and footer hooks while retaining their own state and outcomes (`apps/web/src/review/CommentComposer.tsx:46-115`, `apps/web/src/save/SaveDestinationDialog.tsx:51-75`, `apps/web/src/save/SaveDestinationDialog.tsx:184-209`). This implementation is pending in [PR #46](https://github.com/brad-ross/placekeeper/pull/46), which remained open as of 2026-08-21.

Planning exposed one especially useful boundary: an early acceptance rule required a visible Cancel action while also prohibiting any change to the optional-highlight action set. That was inconsistent because keeping a highlight without a comment and cancelling the annotation are distinct outcomes. The final grammar exposes both instead of overloading one control (session history).

## Guidance

### Share structure and visual tokens

Use a small set of stateless hooks for the common frame:

- Put a direct task title in the header, task-specific controls in the body, and actions in a restrained footer. The shared surface defines a three-row grid, consistent dividers, spacing, type hierarchy, body scrolling, and footer treatment (`apps/web/src/app/review-layout-dialogs.css:53-100`).
- Reuse the application's `review-button` vocabulary. The common rule owns height, centering, icon-and-label spacing, inherited type, and horizontal padding; primary styling remains an explicit modifier (`apps/web/src/app/review-layout-dialogs.css:1-41`).
- Reuse the nearest established selection pattern instead of inventing modal-only radio cards. Save Destination choices use workspace card surfaces, hover treatment, selection color, and a left selection marker (`apps/web/src/app/review-layout-dialogs.css:146-183`).

Do not promote the shared frame into a configurable “god modal.” Save Destination resets and reconciles a proposed filename, while the composer validates text, traps focus, restores its trigger, and can keep an optional highlight without text (`apps/web/src/save/SaveDestinationDialog.tsx:24-47`, `apps/web/src/review/CommentComposer.tsx:31-44`, `apps/web/src/review/CommentComposer.tsx:94-104`). Share tokens, classes, and copy rules; keep domain state and transitions in the owning component.

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

Keep responsive and motion behavior in the shared grammar. Composer sheets become bottom-aligned and full width on small screens, modal controls receive touch height, and the establishing spinner is disabled under reduced motion (`apps/web/src/app/review-layout-responsive.css:41-53`, `apps/web/src/app/review-layout-responsive.css:117-124`, `apps/web/src/app/review-layout-responsive.css:215-228`).

## Why This Matters

Modal polish is not merely cosmetic. Titles and action verbs tell a reviewer whether they are creating content, applying a transformation, preserving an annotation without text, or changing a save contract. Ambiguous wording hides materially different outcomes; explicit actions make the state transition legible.

The presentation-only boundary also limits regression risk. One visual system can cover both modal families without disturbing filename reconciliation, save recovery, optional-comment semantics, keyboard submission, or focus restoration. This preserves the behavioral invariants identified during planning—focus containment, responsive draft preservation, recovery actions, and command isolation—while allowing the presentation to evolve (session history).

The test split prevents three different kinds of drift. Semantic assertions catch language and accessibility mistakes. Production flows catch lifecycle regressions. Visual and geometry checks catch spacing, containment, alignment, and motion regressions. A stylesheet-shape assertion alone cannot provide all three.

## When to Apply

Apply this pattern when:

- several dialogs belong to one product surface but retain distinct state machines;
- the task title already identifies a single input and its visible label adds no information;
- creation and editing need different action verbs;
- an optional step has more than two truthful outcomes;
- modal choices should echo an established tray or list pattern;
- copy and layout must be reviewed across desktop, narrow, recovery, disabled, and reduced-motion states.

Do not use it to collapse distinct workflows into one conditional component, remove labels from multi-field forms, or force task-specific recovery actions into generic verbs. Retry, Locate PDF…, and Return to annotations remain specific because they perform different recovery transitions (`apps/web/src/save/SaveDestinationDialog.tsx:76-121`).

## Examples

| Context | Drifted wording | Compact Editorial wording |
| --- | --- | --- |
| Create replacement | “Replacement Text” plus a repeated field label | “Replacement,” hidden accessible field name, **Apply** |
| Create insertion | “Insertion Text” plus a repeated field label | “Insertion,” hidden accessible field name, **Apply** |
| Edit insertion | “Edit Insert” and **Save** | “Edit Insertion” and **Apply** |
| Add Page Note | Visible “Comment” and **Save comment** | Hidden accessible “Comment” and **Save** |
| Add highlight without a comment | One overloaded keep/dismiss action | **Cancel**, **Keep**, and **Save** |

```tsx
// Share presentation hooks and action vocabulary.
<section className="save-destination-dialog compact-editorial-modal">…</section>
<div className="comment-composer compact-editorial-modal">…</div>

// Keep field naming available to assistive technology without visual repetition.
<label className="comment-composer__field">
  <span className="sr-only">{fieldLabel}</span>
  <textarea title={fieldLabel} />
</label>
```

This is the useful abstraction level: shared visual structure and language rules, separate components for save-domain and annotation-domain behavior.

## Related

- [Content-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) supplies the compact tray-entry precedent reused by Save Destination choices.
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md) distinguishes visible control copy, accessible names, and tooltip ownership.
- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) owns the Save Destination and recovery lifecycle that this presentation pattern must preserve.
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) applies the same presentation-versus-lifecycle ownership boundary to the workspace.
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) shows the complementary browser-validation pattern for compact control reuse.
