---
title: Contextual Annotation Composer preserves document context during authoring
date: 2026-08-22
last_updated: 2026-09-02
category: design-patterns
module: PDF review annotation authoring
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Annotation authoring must preserve the original selection, caret, page, or Review Item while the reader navigates"
  - "A proposed annotation can be previewed accurately in the document instead of repeated in composer chrome"
  - "A nonmodal authoring surface temporarily displaces another tray or workspace and must restore it"
  - "The original annotation anchor can move outside the visible PDF while a draft remains active"
  - "Insertion feedback must remain visible while another workspace is open"
  - "An embedded host persists draft text through revisioned commands without rehydrating the PDF for its own command event"
related_components:
  - "Contextual Annotation Composer"
  - "ReviewShell"
  - "PdfWorkspace"
  - "Owned Annotation"
  - "Annotation Tray"
  - "Review Item"
  - "Review Host Runtime"
  - "Viewer Framing Adapter"
tags:
  - "contextual-annotation-composer"
  - "compact-editorial"
  - "annotation-authoring"
  - "frozen-authority"
  - "owned-annotation-preview"
  - "nonmodal-composer"
  - "anchor-recovery"
  - "tray-restoration"
  - "stable-preview-projection"
  - "command-invalidation-ordering"
---

# Contextual Annotation Composer preserves document context during authoring

## Context

Anchored annotation entry should not force a reviewer to choose between remembering the source passage and preserving a half-written draft. The former modal composers hid the PDF at exactly the moment the reviewer needed to compare a replacement, insertion, or comment with its source. In practice, forgetting the passage meant cancelling, rereading, recreating the anchor, and starting again.

An initial contextual design kept a separate source-text or insertion-point card and added explicit reading, editor-return, anchor-status, and return controls. That preserved more context than a blocking dialog, but duplicated the document in composer chrome and coupled a local authoring concern to global navigation. Once the prospective annotation could be rendered at its real PDF anchor, that layer became unnecessary. The durable pattern is to keep the PDF live, freeze the original authoring authority, and project only the mutable draft into the normal annotation layer (session history).

The Contextual Annotation Composer applies this pattern to new replacements, insertions, highlight comments, Page Notes, and mutable Review Item edits. It is a nonmodal Compact Editorial edge surface rather than a new annotation data model: existing Review commands remain the commit path, and accepted Review Item projection remains the rendering path. The implementation merged in [PR #49](https://github.com/brad-ross/placekeeper/pull/49) on 2026-08-22.

The embedded generated-output workflow in [PR #68](https://github.com/brad-ross/placekeeper/pull/68) exposed a second-order stability requirement. Per-keystroke PDF projection, host revision events emitted by the command still awaiting its response, retained PDF pointer gestures, and intrinsically sized conditional controls could make the viewer flash, replace the composer before an action settled, or move the tray while scrolling. The refined contract keeps draft text, stable document projection, host invalidation ordering, viewer gestures, and conditional-control geometry as separate lifetimes (session history).

## Guidance

### Freeze authority; keep only the draft mutable

Capture one authoring session when the user begins. The session owns the source identity and document generation, the selection/caret/page anchor or cloned Review Item, the originating control, and a snapshot of the displaced workspace. Clone and freeze nested geometry and payload data so later selection, navigation, responsive layout, or object mutation cannot retarget the draft (`apps/web/src/review/authoring-session.ts:104-128`, `apps/web/src/review/authoring-session.ts:129-205`, `apps/web/src/review/authoring-session.ts:258-268`).

The textarea value is deliberately outside that immutable authority. Establish one provisional annotation when the session changes, then keep text editing local to the composer and, for generated output, persist it as a protected draft without republishing unchanged PDF geometry (`apps/web/src/app/ReviewShell.tsx:417-429`, `apps/web/src/app/ReviewShell.tsx:1440-1462`, `apps/web/src/app/ReviewShell.tsx:1656-1671`). Apply or Save builds its Review command from the same frozen source; generated-output Apply first protects the latest value and then applies that exact draft revision (`apps/web/src/app/ReviewShell.tsx:1484-1513`). Refuse a second authoring session while one is active, and fail closed if the source identity or document generation changes before or during asynchronous submission (`apps/web/src/app/ReviewShell.tsx:1006-1029`, `apps/web/src/app/ReviewShell.tsx:1176-1188`, `apps/web/src/app/ProductionReviewApp.tsx:1828-1876`).

```ts
const session = createAuthoringSession({
  authority: authoringAuthorityFor(reviewState, documentGeneration),
  source: frozenAnchorOrReviewItem,
  workspace: snapshotAuthoringWorkspace(),
  origin,
  token,
});

setPreview(authoringPreviewAnnotation(session, initialAuthoringValue(session)));
onValueChange(value => protectDraftWhenRequired(session, value));
onSave(value => submitCommandBuiltFrom(session.source, value));
```

The essential distinction is immutable semantic authority versus mutable prospective state. Document exploration stays visually free but semantically inert.

### Keep the document projection stable while draft text changes

Build the provisional mark as a temporary Review Item, then call the same `projectReviewItem` function used for accepted state. For an edit, clone the persisted item and replace only its editable field; for a new annotation, construct the corresponding replacement, insertion, highlight, or Page Note payload from the frozen anchor (`apps/web/src/review/authoring-session.ts:383-453`). Publish that projection when the authoring session changes, not every time the text field changes (`apps/web/src/app/ReviewShell.tsx:417-429`).

Pass the resulting annotation into the already-mounted PDF viewer. `PdfWorkspace` merges it into the visible annotation population and replaces a matching persisted annotation by ID during edits (`apps/web/src/pdf/PdfWorkspace.tsx:128-143`). It then renders the preview inside the ordinary Owned Annotation layer with a preview marker (`apps/web/src/pdf/PdfWorkspace.tsx:428-464`). This shows the annotation's stable identity and anchor in document context without making the stateful PDF renderer a controlled text-input surface. The current draft text remains authoritative in the composer and its protected draft until the user commits it.

Keep preview state visual and provisional. The visible layer includes the preview, but Owned Annotation interaction geometry remains derived from accepted annotations only (`apps/web/src/pdf/PdfWorkspace.tsx:128-144`). In an ordinary workflow, Cancel clears the projection without a Review command. In generated-output workflows it first discards the protected draft through the canonical command path; neither route creates or changes an accepted Review Item. Apply, Save, or Keep commits through the canonical command path and then closes the authoring session (`apps/web/src/app/ReviewShell.tsx:1079-1169`, `apps/web/src/app/ReviewShell.tsx:1423-1558`).

### Reconcile host invalidations with the command that caused them

An embedded host may report the revision created by a review command before returning that command's response. Treating those two messages as independent changes causes a redundant bootstrap and PDF rehydration while the composer is active. In the VS Code Review Host Runtime, retain the newest same-generation revision invalidation while any command is pending (`apps/web/src/host/vscode-runtime.ts:131-152`, `apps/web/src/host/vscode-runtime.ts:163-191`).

When the response arrives, update the observed runtime identity first. Release the deferred event only if its revision is still newer; if the response already represents it, discard the duplicate. Run the release in `finally` so a failed command cannot strand a legitimate invalidation (`apps/web/src/host/vscode-runtime.ts:311-321`). Do not apply this rule to generation or freshness events, and do not suppress genuinely newer revisions. The transport owns this causal reconciliation because the shared React client should continue consuming ordinary host invalidations without knowing how they were delivered.

Also treat viewer teardown as a normal asynchronous state. A framing callback that runs after disposal returns an unavailable snapshot instead of reading a torn-down PDF registry (`apps/web/src/pdf/viewer-framing-adapter.ts:68-82`). This prevents late layout work from turning a legitimate rehydration into a secondary exception.

### End PDF gesture ownership before composer actions

Do not let a modifier gesture in the PDF retain DOM pointer capture after the gesture ends. Reverse SyncTeX uses a bounded application-level tracker, clears stale state at the next pointer down or a move with no pressed buttons, and releases unexpected capture on pointer up or cancel (`apps/web/src/pdf/PdfWorkspace.tsx:223-265`, `apps/web/src/pdf/PdfWorkspace.tsx:288-335`). This confines pointer ownership to the viewer gesture so the next click can reach Cancel or Apply. Test the boundary by completing the viewer gesture first, asserting that the page owns no pointer capture, and then invoking both composer actions (`test/acceptance/viewer.spec.ts:178-217`).

### Let the composer take over the existing edge surface

The composer is a labeled `region` and form with no backdrop or modal role (`apps/web/src/review/CommentComposer.tsx:151-166`). On wide layouts it occupies the review edge; on narrow layouts the same mounted component becomes a viewport-contained bottom surface (`apps/web/src/app/review-layout-dialogs.css:129-144`, `apps/web/src/app/review-layout-responsive.css:23-35`). The mounted PDF therefore remains readable, navigable, and at the same zoom.

Nonmodal does not mean that every workspace control remains concurrently active. While authoring owns the edge, the References and tools workspaces remain mounted but become inert and hidden from the accessibility tree (`apps/web/src/review/ReferenceWorkspace.tsx:366-381`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx:125-138`). This avoids competing tray interactions while retaining the displaced workspace's logical mode, active row, scroll, and responsive state. Earlier focused tests failed when the ordinary tray remained live behind the composer and when Save Destination did not inert the composer beneath it (session history).

Do not recreate the displaced workspace after authoring. Snapshot whether it was open, its mode, active item, and Annotation Tray scroll offset. On Apply, Save, Keep, or Cancel, clear the preview, release the takeover, restore the active row and scroll, and return focus to the originating control, restored row edit action, prior workspace, or PDF fallback (`apps/web/src/app/ReviewShell.tsx:997-1004`, `apps/web/src/app/ReviewShell.tsx:1079-1159`). Because the workspace stayed mounted, restoration does not need a synthetic toggle or a PDF reframe.

### Make anchor recovery conditional and minimal

The frozen session exposes one semantic page point for visibility and return navigation (`apps/web/src/review/authoring-session.ts:341-363`). Measure that point against the usable PDF viewport after subtracting composer occlusion. If it is outside, show one title-adjacent target icon; if it is visible or unavailable, show no recovery control (`apps/web/src/review/CommentComposer.tsx:35-55`, `apps/web/src/app/ProductionReviewApp.tsx:998-1071`). Reserve the header height whether or not that conditional control exists, and give it explicit equal width, height, minimums, and flex basis from the shared default or touch control token (`apps/web/src/app/review-layout-dialogs.css:129-175`, `apps/web/src/app/review-layout-responsive.css:23-60`). The affordance may appear while scrolling; the composer body and action row must not move when it does.

Route the return action through `NavigationCoordinator.navigateMainAnnotation` instead of directly scrolling the viewer. This preserves cancellation, settled-location, focus, and Meaningful Jump semantics. The recovery action may change the viewport, but it never changes the frozen anchor. Avoid permanent status badges, separate “Read Document” or “Return to Editor” modes, and always-visible return controls: the live PDF already supports reading, and recovery chrome is useful only when the anchor leaves view.

### Keep input semantics and actions local

Place Cancel, optional Keep, and the primary Save or Apply action directly below the textarea (`apps/web/src/review/CommentComposer.tsx:167-218`). Let the title carry single-field context while keeping the field's accessible name in a screen-reader-only label. Preserve the established Compact Editorial verbs: Save creates comments and Page Notes, Apply proposes text or edits a Review Item, Keep retains an uncommented highlight, and Cancel abandons the pending action (`apps/web/src/review/authoring-session.ts:208-255`).

A nested prerequisite such as Save Destination may temporarily supersede the composer, but it must not become draft authority. Keep the frozen authoring session mounted and inert while the true dialog is open. Cancelling destination selection or rejecting the command returns to the same draft; acceptance closes it; source replacement discards it as stale (`apps/web/src/app/ReviewShell.tsx:417-436`, `apps/web/src/app/ReviewShell.tsx:1885-1893`, `apps/web/src/app/ReviewShell.tsx:2198-2207`, `apps/web/src/app/ProductionReviewApp.tsx:1828-1889`).

### Test retained-state combinations, not isolated elements

The riskiest regressions happen where two valid states coexist. Assert that:

- every authoring kind projects through accepted annotation semantics, and nested source mutation cannot retarget a session (`apps/web/test/authoring-session.test.ts:149-174`, `apps/web/test/authoring-session.test.ts:191-245`);
- the composer takeover survives wide/narrow transitions without remounting and restores the original tray row, scroll, focus, and PDF geometry after both Cancel and Apply (`test/acceptance/review-workflow.spec.ts:1482-1590`);
- an out-of-view anchor can be recovered through Back and Forward while the draft and preview remain attached to the original page (`test/acceptance/production-flow.spec.ts:3268-3325`);
- typing text that does not change an anchor leaves the PDF preview-update count unchanged (`test/acceptance/review-workflow.spec.ts:2196-2212`);
- reverse-SyncTeX pointer gestures release PDF ownership before later Apply or Cancel actions (`test/acceptance/viewer.spec.ts:178-217`);
- the conditional Return to annotation control matches adjacent action sizing and leaves header and body geometry unchanged across wide, bottom, and narrow presentations (`test/acceptance/review-visual.spec.ts:1059-1136`, `test/acceptance/production-flow.spec.ts:3328-3378`);
- a command-caused VS Code revision event is discarded after its matching response, a genuinely newer event still publishes, and a failed command releases its deferred invalidation (`apps/web/test/host-runtime.test.ts:401-548`);
- queued framing work after viewer disposal returns an explicit unavailable state (`apps/web/test/viewer-framing.test.ts:287-337`);
- Save Destination cancellation preserves the exact draft and its single provisional preview without committing a Review Item; a first-command conflict likewise returns to the preserved composer for retry (`test/acceptance/production-flow.spec.ts:4302-4333`, `test/acceptance/production-flow.spec.ts:4764-4803`);
- opening Search or another workspace does not suppress a reliable insertion caret in the PDF (`apps/web/test/review-layout.test.tsx:455-476`, `test/acceptance/production-flow.spec.ts:2925-2957`).

The last invariant matters because in-place preview work exposed a real-PDF regression where insertion placement remained an input state but its cursor disappeared while a workspace was open. The durable boundary is that base-surface disclosure may coexist with selection actions and a reliable caret; only a genuinely nested authoring layer should suppress the caret (session history).

Prefer visibility and containment assertions over desktop-coordinate assertions at responsive breakpoints. Earlier tests over-specified the composer's exact narrow-screen position even though the product contract was simply that it remain visible, contained, and actionable (session history).

## Why This Matters

The stable provisional overlay removes the memory tax that caused reviewers to abandon a draft, reread the passage, recreate the selection, and start again. Showing the annotation at its eventual PDF anchor provides stronger context than repeating source text in an edge card, while keeping per-keystroke text out of the viewer prevents unchanged document geometry from flashing or repainting.

Freezing authority prevents a subtle correctness failure. A new selection, caret click, tray interaction, responsive change, Back or Forward jump, host revision event, or asynchronous Save Destination response must not redefine what Apply means. The session makes that invariant explicit while leaving the mutable draft responsive to typing. Reconciliation at the VS Code transport boundary then prevents the command's own revision notification from replacing that stable interaction.

The takeover pattern also preserves reading flow and workspace continuity. It gives the edge one active job, avoids squeezing or recentering the PDF, and restores the Annotation Tray exactly where the reviewer left it. Separating provisional visibility from accepted interaction and history prevents a draft from accidentally becoming canonical state before the user acts.

## When to Apply

Use this pattern when all of the following are true:

- the user benefits from inspecting or navigating the primary document while drafting;
- the edit must remain attached to an original selection, caret, page point, or persisted entity despite later UI state changes;
- a prospective result can be projected through the same renderer used for accepted state;
- an existing tray or workspace can yield its presentation region while its state owner remains mounted; and
- submission may pause for a nested prerequisite without surrendering draft authority.

Prefer an ordinary modal when the background must be unavailable for safety or the task has no meaningful document anchor. Prefer inline editing when the accepted object is already fully visible and directly editable. Do not use this pattern to justify multiple simultaneous drafts, silently retarget a draft to the latest selection, duplicate the PDF in a source-context card, or let preview state enter canonical Review Item history.

For another anchored authoring flow, identify four owners before coding: immutable source authority, mutable draft value, accepted-state projection, and displaced-surface restoration. If any owner is ambiguous, navigation or asynchronous nesting will eventually expose it.

## Examples

| User action | Frozen authority | Stable document cue and mutable draft | Commit outcome |
| --- | --- | --- | --- |
| Type a replacement | Original text selection and document generation | Stable replacement anchor; latest text remains in the composer or protected draft | Apply builds a replacement Review command |
| Type an insertion | Original caret position and surrounding context | Stable insertion anchor; latest text remains in the composer or protected draft | Apply builds an insertion Review command |
| Comment on a highlight | Original selection geometry | Stable highlight mark plus separately mutable comment text | Save commits the comment; Keep commits the highlight without it |
| Add a Page Note | Original page position | Stable Page Note anchor plus separately mutable note text | Save builds the Page Note command |
| Edit a Review Item | Cloned item identity, payload, and geometry | Existing mark remains projected from the session while the field changes locally | Apply edits that same Review Item |

The unit contract covers this complete projection family in one table-shaped suite and separately covers stale authority plus nested Save Destination outcomes (`apps/web/test/authoring-session.test.ts:191-245`, `apps/web/test/authoring-session.test.ts:286-324`). In browser coverage, assert exactly one composer and one prospective mark: a duplicated source card or a second preview indicates that presentation has drifted away from the single-authority model.

## Related

- [Compact Editorial language for review task surfaces](compact-editorial-language-for-annotation-modals.md) defines the concise titles, hidden-but-accessible field labels, action verbs, and button language retained by the nonmodal composer.
- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md) owns the mounted-viewer, right-or-bottom host, and viewer-reachability contract that the authoring takeover reuses.
- [Shared production review client with host-specific runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) owns the browser/VS Code host split; this learning adds the command-caused invalidation ordering rule needed to keep embedded authoring stable.
- [Return-to-origin navigation for stateful PDF Reference Tabs](../architecture-patterns/reference-tab-return-to-origin-navigation.md) is the precedent for an immutable semantic origin, viewer-owned visibility, and an outside-only target control.
- [Content-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) defines the logical tray state that authoring snapshots and restores.
- [Preserve document history for Annotation Tray navigation](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) owns the Meaningful Jump boundary reused by Return to annotation.
- [Reject stale viewer selection snapshots before creating annotation anchors](../ui-bugs/reject-stale-viewer-selection-snapshots.md) establishes the same frozen-authority principle one stage earlier, while text and geometry are captured into an anchor.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) defines the canonical Review Item-to-Owned Annotation projection reused for prospective marks.
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md) governs the target icon's visible, hover, and accessible naming.
- [Full Annotation Reader preserves Annotation Tray context](full-annotation-reader-preserves-tray-context.md) owns measured overflow, reader identity, and reader-specific restoration; this learning remains the authority for frozen authoring sessions and edge-surface takeover.
