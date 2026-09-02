---
title: Compact Editorial language for review task and recovery surfaces
date: 2026-08-21
last_updated: 2026-09-02
category: design-patterns
module: PDF review task and recovery surface presentation
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Related task or setting surfaces have drifted in hierarchy, terminology, or action styling"
  - "A title already supplies context that nearby labels, status rows, or supporting copy would only repeat"
  - "Dialogs, nonmodal composers, recovery pages, and browser popups should share Warm Neutral presentation without sharing lifecycle ownership"
  - "Create, edit, recovery, and preference flows need concise but distinct action semantics"
  - "A blocked document action should route directly to the focused workspace that owns its recovery"
related_components:
  - "CommentComposer"
  - "SaveDestinationDialog"
  - "ReviewShell"
  - "Annotation Tray"
  - "ReconciliationWorkspace"
  - "DocumentActionsMenu"
  - "terminal recovery"
  - "review harness"
  - "testing_framework"
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

Placekeeper has task surfaces that should feel related but do different jobs. `CommentComposer` owns free-form annotation text, validation, and keyboard submission inside a nonmodal region (`apps/web/src/review/CommentComposer.tsx:46-65`, `apps/web/src/review/CommentComposer.tsx:151-218`). `SaveDestinationDialog` owns a true modal's destination selection, filename proposal synchronization, rewrite eligibility, recovery actions, and focus trap (`apps/web/src/save/SaveDestinationDialog.tsx:24-64`, `apps/web/src/save/SaveDestinationDialog.tsx:75-209`). Treating each as a visual one-off allowed their hierarchy, wording, and controls to drift away from the surrounding Warm Neutral interface.

The durable solution is a shared presentation grammar, not a shared lifecycle or stateful modal component. Both surfaces retain the historically named `compact-editorial-modal` presentation hooks, but only Save Destination uses the footer and modal interaction contract; the composer keeps its actions local to the input and delegates authoring-session restoration to `ReviewShell` (`apps/web/src/review/CommentComposer.tsx:151-218`, `apps/web/src/save/SaveDestinationDialog.tsx:52-75`, `apps/web/src/save/SaveDestinationDialog.tsx:184-209`, `apps/web/src/app/ReviewShell.tsx:765-803`). The initial grammar merged in [PR #46](https://github.com/brad-ross/placekeeper/pull/46) on 2026-08-21 and later became the presentation vocabulary for the nonmodal Contextual Annotation Composer.

The same grammar now also covers a structurally different surface: the successor-daemon page that reopens an interrupted Placekeeper session. That page is centered on an otherwise inert document canvas and explicitly remains a page rather than a dialog over an interactive review (`apps/web/src/app/review-layout.css:6-39`). It reuses the visual hierarchy without moving the gesture-gated reopen, protected-draft choices, or Codex task reattachment into presentation code. Earlier versions required two reopen confirmations, exposed internal-looking identifiers, used review-oriented copy, and reserved empty layout rows; the settled surface uses one **Reopen** action, a filename-led title, session terminology, and content-driven height (session history). [PR #48](https://github.com/brad-ross/placekeeper/pull/48), merged on 2026-08-22, extended the grammar to this recovery surface.

The Chrome extension's automatic-PDF preference exposed the same presentation boundary at popup scale. Its underlying setting persisted and PDF handoff worked, but every short-lived popup document recreated a static “Reading Chrome's PDF setting…” sentence and repeated the control's purpose across a long title, explanatory copy, toggle label, and state pill (session history). The current popup keeps only a direct **Placekeeper** title, one semantic **Open PDFs automatically** switch, and an initially empty live status region (`apps/chrome-extension/popup.html:6-18`). Runtime code owns synchronization, mutation, and failure copy while an ordinary successful read remains quiet (`apps/chrome-extension/src/popup-entry.ts:15-31`, `apps/chrome-extension/src/popup-entry.ts:34-60`).

Generated-PDF reconciliation extends the same grammar from authoring to recovery. Unresolved prior-generation annotations are concrete tasks, not status prose: the Annotation Tray puts them first, selecting one immediately establishes the smallest useful apply, reattach, or discard state, and the live PDF remains the only replacement-selection surface. Reviewed-PDF export is a document action, so it lives in the PDF-title menu; when annotation work blocks it, that menu explains the block and routes directly to the owning Annotations workspace. Planning and visual iteration were important here because merely moving the export button would have split eligibility, pending state, results, and recovery across components without assigning lifecycle ownership (session history).

Planning exposed one especially useful boundary: an early acceptance rule required a visible Cancel action while also prohibiting any change to the optional-highlight action set. That was inconsistent because keeping a highlight without a comment and cancelling the annotation are distinct outcomes. The final grammar exposes both instead of overloading one control (session history).

## Guidance

### Share structure and visual tokens

Use a small set of stateless hooks for the common presentation:

- Put a direct task title in the header and task-specific controls in the body. A true dialog may use the restrained shared footer; a contextual composer keeps its actions immediately below the input. The shared hooks still own spacing, type hierarchy, body treatment, and dialog footer styling (`apps/web/src/app/review-layout-dialogs.css:53-100`, `apps/web/src/review/CommentComposer.tsx:163-218`).
- Reuse the application's `review-button` vocabulary. The common rule owns height, centering, icon-and-label spacing, inherited type, and horizontal padding; primary styling remains an explicit modifier (`apps/web/src/app/review-layout-dialogs.css:1-41`).
- Reuse the nearest established selection pattern instead of inventing task-local radio cards. Save Destination choices use workspace card surfaces, hover treatment, selection color, and a left selection marker (`apps/web/src/app/review-layout-dialogs.css:146-183`).

Do not promote the shared presentation into a configurable “god surface.” Save Destination resets and reconciles a proposed filename and traps focus, while the composer validates text and can keep an optional highlight without a comment (`apps/web/src/save/SaveDestinationDialog.tsx:24-64`, `apps/web/src/review/CommentComposer.tsx:46-65`, `apps/web/src/review/CommentComposer.tsx:167-218`). `ReviewShell` owns the composer's frozen authoring authority, displaced-workspace restoration, and focus return (`apps/web/src/app/ReviewShell.tsx:688-715`, `apps/web/src/app/ReviewShell.tsx:765-803`). Share tokens, classes, and copy rules; keep domain state and transitions with their actual lifecycle owner.

### Extend the grammar to lifecycle-owned recovery pages

A dedicated recovery page may reuse the same header, body, footer, button, focus, and responsive tokens without becoming an application dialog. The terminal recovery renderer derives `Reopen <filename>`, builds icon-and-label **Copy Link** and **Reopen** controls, and keeps status and conditional choices in the body (`apps/web/src/production-entry.tsx:73-132`, `apps/web/src/production-entry.tsx:183-212`, `apps/web/src/production-entry.tsx:286-338`). The card shares foundation and button rules with the application while retaining recovery-specific DOM and transitions (`apps/web/src/app/review-layout-dialogs.css:1-59`).

Keep authority below that presentation layer. The ordinary **Reopen** click sends the confirmed same-origin request; when no protected draft intervenes, the fresh session mounts directly without a second “Open this PDF” step (`apps/web/src/production-entry.tsx:232-260`, `test/acceptance/reloadable-links.spec.ts:485-490`). Only a service-issued recovery offer expands the body into **Resume draft**, **Discard draft**, and **Open separate copy**. Retries preserve one operation ID for the same decision and use different IDs for different decisions (`apps/web/src/production-entry.tsx:134-143`, `test/acceptance/reloadable-links.spec.ts:597-617`). Codex reattachment remains a separate two-sided authorization flow, so the page never presents task identity as another recovery choice. The authority contract belongs in [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md).

Let content determine the shape. The card uses a bounded three-row grid and an overflow-capable body; an empty action region is removed from layout, while protected-draft choices switch that region to a grid (`apps/web/src/app/review-layout.css:24-39`, `apps/web/src/app/review-layout.css:64-71`, `apps/web/src/app/review-layout.css:105-130`). The ordinary state therefore fits its explanation and shared padding, the footer stays one control row high when copy status is empty, and the same card grows only when a real conditional decision appears. Do not encode separate magic heights for ordinary and protected states.

### Let the title carry context without weakening accessibility

Supporting copy belongs only where it answers a question the title cannot. Save Destination explains that the choice can be changed later (`apps/web/src/save/SaveDestinationDialog.tsx:69-73`). A single-field composer titled “Replacement” should not visibly repeat “Replacement” immediately above its text area.

Removing visible repetition must not remove the field's accessible name. `CommentComposer` keeps the label in an `sr-only` span and supplies the same value as the textarea title (`apps/web/src/review/CommentComposer.tsx:167-186`). Focus and disabled-state rules also name `.compact-editorial-modal` directly because Save Destination can be mounted outside `.review-shell` (`apps/web/src/app/review-layout-foundation.css:85-97`).

Retain visible labels when the body has several controls or the field would otherwise be ambiguous. Save Destination correctly keeps “Copy name” beside its filename input (`apps/web/src/save/SaveDestinationDialog.tsx:149-176`).

### Keep short-lived preference hydration quiet

A browser popup is reconstructed every time it opens, so transient progress text in static HTML is replayed even when the browser has already persisted the preference. Static markup should express only stable structure: product title, semantic control, and an empty live region. Disable the control while authoritative state resolves, then update the switch without announcing an ordinary successful read (`apps/chrome-extension/popup.html:10-18`, `apps/chrome-extension/src/popup-entry.ts:15-31`).

Populate status only when it changes what the person needs to understand: synchronization was repaired by pausing automatic opening, an explicit mutation is pending or complete, or the browser setting could not be read or changed (`apps/chrome-extension/src/popup-entry.ts:23-60`). Keep the underlying operations bounded so quiet startup cannot become an indefinitely inert control; Placekeeper's automatic-open reads and writes reject after their operation timeout. If enabling Chrome's MIME handler then fails after the sentinel write succeeds, Placekeeper attempts to roll the sentinel back (`apps/chrome-extension/src/opt-in.ts:3-20`, `apps/chrome-extension/src/opt-in.ts:58-64`).

Use one inline `role="switch"` rather than a generic button plus a separate state pill. Synchronize `aria-checked` from the same state that drives the visual thumb, keep the row touch-sized, hide the empty status node from layout, and reuse the app's ink, surface, border, focus, success, and motion values (`apps/chrome-extension/src/popup-entry.ts:17-21`, `apps/chrome-extension/src/extension.css:28-50`, `apps/chrome-extension/src/extension.css:68-150`). This shares Compact Editorial presentation without importing the web app's lifecycle or stylesheet ownership into the extension.

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

For optional Highlight Comment, render all three truthful outcomes—Cancel, Keep, and Save—because dismissal, retention without text, and retention with text are separate transitions (`apps/web/src/review/CommentComposer.tsx:187-218`). Authoring semantics supply concise noun titles and the Apply or Save action without moving workflow logic into the presentational component (`apps/web/src/review/authoring-session.ts:203-250`, `apps/web/src/app/ReviewShell.tsx:1194-1230`).

### Present unresolved annotations as tasks

Project every unresolved canonical item and pending draft into one **Needs attention** queue ahead of ordinary owned annotations and read-only source-PDF annotations (`apps/web/src/review/ReconciliationWorkspace.tsx:249-284`, `apps/web/src/app/ReviewShell.tsx:2049-2128`). Remove the optional section entirely when it becomes empty instead of replacing it with “No previous annotations,” “Reattachment saved,” or “Discard recorded” chrome (`apps/web/src/review/ReconciliationWorkspace.tsx:392-394`, `test/acceptance/review-workflow.spec.ts:235-268`). Task completion itself is the feedback: close the detail, remove the resolved row from current state, and focus the next task or a stable annotations fallback (`apps/web/src/review/ReconciliationWorkspace.tsx:352-379`).

Make the unresolved row the entry point to its expected resolution. Clicking it opens apply or reattach detail; discard remains the one separate destructive row action (`apps/web/src/review/ReconciliationWorkspace.tsx:493-540`). Do not require another Reattach or anchor button after selection. The row has already expressed the user's intent.

The focused detail follows an intent-first hierarchy:

1. Name the transition and type together—**Reattach highlight**, **Reattach deletion**, **Apply insert**—and place one human-readable status pill on the same header line (`apps/web/src/review/ReconciliationWorkspace.tsx:152-162`, `apps/web/src/review/ReconciliationWorkspace.tsx:406-426`).
2. Show the authored annotation as primary content.
3. Show “Previously attached to · Page N” as secondary context, and include old source text only when it is nonblank and distinct from the authored text (`apps/web/src/review/ReconciliationWorkspace.tsx:164-177`, `apps/web/src/review/ReconciliationWorkspace.tsx:429-440`).
4. Use the main PDF as the sole new-anchor selection surface. Keep Confirm disabled until the current reliable selection or caret can supply valid evidence (`apps/web/src/review/ReconciliationWorkspace.tsx:70-130`, `apps/web/src/review/ReconciliationWorkspace.tsx:442-464`).

Translate internal dispositions into concise human labels at projection time: **Ready to apply**, **Needs new location**, **Needs review**, **Multiple matches**, or **Missing text** (`apps/web/src/review/ReconciliationWorkspace.tsx:238-247`). Do not repeat the same status in a heading, metadata row, helper card, and instruction.

Reuse the ordinary annotation icon and button grammar. Metadata uses the shared type mapping, actions use `ReviewIcon` and standard review-button classes, and destructive meaning stays red from the row's trash icon through the focused Discard action (`apps/web/src/review/AnnotationMetadata.tsx:9-29`, `apps/web/src/review/ReconciliationWorkspace.tsx:406-485`, `apps/web/src/app/review-layout-annotations.css:1846-1852`, `apps/web/src/app/review-layout-annotations.css:2135-2147`). Secondary row actions remain mounted for focus and accessibility but become visually prominent only on hover, focus-within, active selection, or coarse-pointer layouts (`apps/web/src/review/AnnotationList.tsx:186-214`, `apps/web/src/app/review-layout-responsive.css:153-183`).

### Route blocked document actions to their owner

Whole-document export belongs with document identity, not inside the Annotation Tray. The PDF-title menu derives its presentation from the canonical review summary: refresh can block export without an annotation recovery link; unresolved items or drafts block it with a count and recovery action; stale-only state permits an explicit confirmation path (`apps/web/src/review/DocumentActionsMenu.tsx:23-61`, `packages/core/src/live-context.ts:400-431`).

When annotation work blocks export, keep **Export** visible but semantically unavailable using `aria-disabled` and `aria-describedby`. Place one short blocker count and **Open Annotations** directly beneath it, using the same annotations icon as workspace navigation (`apps/web/src/review/DocumentActionsMenu.tsx:206-214`, `apps/web/src/review/DocumentActionsMenu.tsx:282-324`, `apps/web/src/review/ReviewIcon.tsx:42-80`). Visually group the relationship as one attention unit instead of a detached recovery card.

The recovery action closes the menu and, when a protected composer is active, preserves and refocuses it; otherwise it opens the Annotations workspace and focuses its first actionable task (`apps/web/src/review/DocumentActionsMenu.tsx:314-323`, `apps/web/src/app/ReviewShell.tsx:925-943`, `apps/web/src/review/ReconciliationWorkspace.tsx:318-379`). Ownership therefore stays coherent: the title menu explains a blocked document action; the Annotation Tray resolves it.

### Test semantics and appearance separately

Deterministic preview routes make every composer variant reviewable without reproducing its PDF gesture. The harness enumerates creation and edit states with exact titles, field names, actions, and representative content (`test/acceptance/review-harness/main.tsx:39-93`). Always include a valid visual scene in a preview URL: the harness applies production-root styling only when a visual scenario resolves. An unstyled raw harness route is not evidence of a product CSS regression.

Use three complementary layers:

1. Semantic component and workflow tests assert accessible names, action labels, cancellation, submission, focus, and draft preservation.
2. Production flows prove that the same wording works through real annotation and Save Destination lifecycles.
3. Visual and geometry tests cover contextual-composer snapshots, narrow containment, touch target height, local action placement, anchor recovery, modal layering, and reduced motion (`test/acceptance/review-visual.spec.ts:817-990`).

For a lifecycle-owned recovery page, add state-coupled geometry assertions rather than relying on a screenshot alone. The ordinary successor flow measures that empty status and action regions contribute no height and that the footer equals its control row plus padding and border (`test/acceptance/reloadable-links.spec.ts:375-418`). The protected-draft flow proves that discovered choices make the same card taller, while the touch-viewport flow proves containment and controls of at least 44 pixels (`test/acceptance/reloadable-links.spec.ts:538-555`, `test/acceptance/reloadable-links.spec.ts:663-698`). Run these lifecycle assertions in both Chromium and WebKit because a visually correct static shell does not prove the reopen state machine.

For a browser popup, protect the smallest stable contract directly. The extension test asserts the concise document and visible titles, semantic switch structure, absence of redundant explanation and startup-reading copy, and inert control before saved state is known (`apps/chrome-extension/test/extension-contract.test.ts:22-52`). Pair that semantic check with a rendered popup-width preview and a production extension build; earlier attempts to rely on an isolated extension service worker timed out, so they did not provide dependable popup evidence (session history).

Keep responsive and motion behavior in the shared grammar. The nonmodal composer becomes a contained bottom surface on small screens, controls receive touch height, and pending animation is disabled under Reduced Motion (`apps/web/src/app/review-layout-responsive.css:17-48`, `apps/web/src/app/review-layout-responsive.css:234-248`).

For task-first reconciliation, test the handoff as one workflow: blocked Export, concise reason, icon-consistent **Open Annotations**, selected workspace, and first-task focus (`test/acceptance/production-flow.spec.ts:4193-4214`). Separately assert list-to-detail hierarchy, PDF-driven Confirm enablement, focus repair after completion, danger styling, and absence of obsolete success blocks (`test/acceptance/review-workflow.spec.ts:192-268`, `test/acceptance/review-workflow.spec.ts:312-343`). Visual coverage should render the same focused task at wide and narrow widths and keep coarse-pointer actions persistent and touch-sized (`test/acceptance/review-visual.spec.ts:52-95`, `test/acceptance/review-visual.spec.ts:589-649`).

## Why This Matters

Task-surface polish is not merely cosmetic. Titles and action verbs tell a reviewer whether they are creating content, applying a transformation, preserving an annotation without text, or changing a save contract. Ambiguous wording hides materially different outcomes; explicit actions make the state transition legible.

The presentation-only boundary also limits regression risk. One visual system can cover a true Save Destination dialog and a nonmodal annotation composer without confusing their owners: the dialog traps focus and reconciles save state, while `ReviewShell` preserves authoring authority, draft, workspace, and focus restoration. Shared appearance can evolve without merging those lifecycle contracts.

That boundary matters even more for interrupted-session recovery. A stale page must not inspect the PDF or restore browser or task authority on `GET`; one explicit **Reopen** gesture crosses the confirmation boundary, and only discovered protected work expands the decision. Reusing the modal grammar makes this security-owned state machine legible without turning appearance into authority. Removing empty layout regions is part of the same truthfulness: the ordinary card looks like a small task, while protected work visibly increases the amount of decision content (session history).

The test split prevents three different kinds of drift. Semantic assertions catch language and accessibility mistakes. Production flows catch lifecycle regressions. Visual and geometry checks catch spacing, containment, alignment, and motion regressions. A stylesheet-shape assertion alone cannot provide all three.

Quiet ordinary preference hydration is part of the same truthfulness. A loading sentence that appears on every popup open makes persisted state look uncertain, while removing all status would hide repairs and failures. Stable markup plus runtime-owned exceptional feedback keeps the common path calm without suppressing actionable information.

Task-first reconciliation applies that truthfulness to blockers. The queue says what requires action, row selection establishes the action, the live PDF supplies replacement evidence, and Confirm commits it. Removing duplicate previews, anchor buttons, technical reason strings, repeated labels, and completion cards makes the recovery state feel like an ordinary focused task rather than exposed reconciliation machinery.

The export gate also remains legible because eligibility and recovery derive from the same canonical summary. A disabled command without a route feels broken; a recovery link detached from the command makes the relationship implicit. Placing a direct recovery action beside the unavailable export command explains the dependency while keeping lifecycle ownership in the Annotation Tray (`packages/core/src/live-context.ts:406-431`, `apps/web/src/review/DocumentActionsMenu.tsx:35-61`).

## When to Apply

Apply this pattern when:

- several task surfaces belong to one product area but retain distinct state machines and modality;
- the task title already identifies a single input and its visible label adds no information;
- creation and editing need different action verbs;
- an optional step has more than two truthful outcomes;
- choice controls should echo an established tray or list pattern;
- copy and layout must be reviewed across desktop, narrow, recovery, disabled, and reduced-motion states;
- a dedicated recovery page should look related to application dialogs while remaining outside the interactive application mount;
- conditional risk or protected work should expand one bounded card instead of reserving empty space in the ordinary state.
- a short-lived browser popup reads a persisted preference asynchronously and should stay quiet unless synchronization, mutation, or failure needs explanation.
- a document-level action is blocked by one focused workspace and should route directly to its first actionable task.
- prior-generation annotations need explicit resolution in the live document without a duplicate preview or extra mode-selection control.

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
| Read an automatic-open preference | Static “Reading…” copy, repeated explanation, and a separate state pill | **Placekeeper**, one inline **Open PDFs automatically** switch, and status only for repairs, mutations, or failures |
| Reattach an ambiguous annotation | Separate Open and Reattach controls, duplicate PDF preview, technical reason rows | Click the task, select in the live PDF, then **Confirm** under one type-specific heading and state pill |
| Discard an obsolete prior annotation | Neutral action plus a persistent “Discard recorded” block | Red trash action, concise focused confirmation, then remove the completed task |
| Recover from blocked reviewed export | Export controls inside the tray or a disabled menu item with no route | Disabled **Export**, concise blocker count, and icon-consistent **Open Annotations** in the PDF-title menu |

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

<!-- A browser popup keeps transient work out of static markup. -->
<main aria-labelledby="title">
  <h1 id="title">Placekeeper</h1>
  <button role="switch" aria-checked="false">Open PDFs automatically</button>
  <p role="status" aria-live="polite"></p>
</main>
```

This is the useful abstraction level: shared visual structure and language rules, separate components or pages for save-domain, annotation-domain, successor-recovery, and browser-preference behavior.

## Related

- [Content-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) supplies the compact tray-entry precedent reused by Save Destination choices.
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md) distinguishes visible control copy, accessible names, and tooltip ownership.
- [Truthful compact status for live agent context](truthful-compact-agent-context-status.md) supplies the complementary rule that stable ordinary state stays quiet while transitions and failures communicate precise meaning.
- [Recoverable autosave for editable PDF annotations](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) owns the Save Destination and recovery lifecycle that this presentation pattern must preserve.
- [Adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md) applies the same presentation-versus-lifecycle ownership boundary to the workspace.
- [Reliable compact right-docked Reference Tabs](../ui-bugs/reliable-compact-right-docked-reference-tabs.md) shows the complementary browser-validation pattern for compact control reuse.
- [Contextual Annotation Composer preserves document context during authoring](contextual-annotation-composer-preserves-document-context-during-authoring.md) owns the nonmodal authoring authority, stable provisional projection, tray takeover, and restoration lifecycle that this presentation grammar must not absorb.
- [Authority boundaries for reloadable local-review URLs](../architecture-patterns/reloadable-local-review-url-authority-boundaries.md) owns the inert stale route, explicit reopen gesture, protected-draft offer, and independent Codex reconnect authority that this recovery presentation must not widen.
- [Atomic generation transitions for rebuilt PDF reviews](../architecture-patterns/atomic-generation-transitions-for-rebuilt-pdf-reviews.md) owns the unresolved dispositions, pending drafts, and generation transition that this task-first presentation projects.
- [Full Annotation Reader preserves tray context](full-annotation-reader-preserves-tray-context.md) supplies the mounted list-to-detail and focus-restoration precedent reused by focused reconciliation.
