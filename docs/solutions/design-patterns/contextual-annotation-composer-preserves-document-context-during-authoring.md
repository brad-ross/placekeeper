---
title: Contextual Annotation Composer preserves document context during authoring
date: 2026-08-22
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
related_components:
  - "Contextual Annotation Composer"
  - "ReviewShell"
  - "PdfWorkspace"
  - "Owned Annotation"
  - "Annotation Tray"
  - "Review Item"
tags:
  - "contextual-annotation-composer"
  - "compact-editorial"
  - "annotation-authoring"
  - "frozen-authority"
  - "owned-annotation-preview"
  - "nonmodal-composer"
  - "anchor-recovery"
  - "tray-restoration"
---

# Contextual Annotation Composer preserves document context during authoring

## Context

Anchored annotation entry should not force a reviewer to choose between remembering the source passage and preserving a half-written draft. The former modal composers hid the PDF at exactly the moment the reviewer needed to compare a replacement, insertion, or comment with its source. In practice, forgetting the passage meant cancelling, rereading, recreating the anchor, and starting again.

An initial contextual design kept a separate source-text or insertion-point card and added explicit reading, editor-return, anchor-status, and return controls. That preserved more context than a blocking dialog, but duplicated the document in composer chrome and coupled a local authoring concern to global navigation. Once the prospective annotation could be rendered at its real PDF anchor, that layer became unnecessary. The durable pattern is to keep the PDF live, freeze the original authoring authority, and project only the mutable draft into the normal annotation layer (session history).

The Contextual Annotation Composer applies this pattern to new replacements, insertions, highlight comments, Page Notes, and mutable Review Item edits. It is a nonmodal Compact Editorial edge surface rather than a new annotation data model: existing Review commands remain the commit path, and accepted Review Item projection remains the rendering path. The implementation merged in [PR #49](https://github.com/brad-ross/placekeeper/pull/49) on 2026-08-22.

## Guidance

### Freeze authority; keep only the draft mutable

Capture one authoring session when the user begins. The session owns the source identity and document generation, the selection/caret/page anchor or cloned Review Item, the originating control, and a snapshot of the displaced workspace. Clone and freeze nested geometry and payload data so later selection, navigation, responsive layout, or object mutation cannot retarget the draft (`apps/web/src/review/authoring-session.ts:97-125`, `apps/web/src/review/authoring-session.ts:128-200`, `apps/web/src/review/authoring-session.ts:253-262`).

The textarea value is deliberately outside that immutable authority. Typing publishes a new preview derived from the frozen session, while Apply or Save builds its Review command from the same frozen source (`apps/web/src/app/ReviewShell.tsx:688-715`, `apps/web/src/app/ReviewShell.tsx:1218-1229`). Refuse a second authoring session while one is active, and fail closed if the source identity or document generation changes before or during asynchronous submission (`apps/web/src/app/ReviewShell.tsx:646-681`, `apps/web/src/app/ReviewShell.tsx:817-844`).

```ts
const session = createAuthoringSession({
  authority: authoringAuthorityFor(reviewState, documentGeneration),
  source: frozenAnchorOrReviewItem,
  workspace: snapshotAuthoringWorkspace(),
  origin,
  token,
});

onValueChange(value => setPreview(authoringPreviewAnnotation(session, value)));
onSave(value => submitCommandBuiltFrom(session.source, value));
```

The essential distinction is immutable semantic authority versus mutable prospective state. Document exploration stays visually free but semantically inert.

### Preview through the accepted annotation projection

Build the preview as a temporary Review Item, then call the same `projectReviewItem` function used for accepted state. For an edit, clone the persisted item and replace only its editable field; for a new annotation, construct the corresponding replacement, insertion, highlight, or Page Note payload from the frozen anchor (`apps/web/src/review/authoring-session.ts:311-393`).

Pass the resulting annotation into the already-mounted PDF viewer. `PdfWorkspace` merges it into the visible annotation population and replaces a matching persisted annotation by ID during edits (`apps/web/src/pdf/PdfWorkspace.tsx:123-135`). It then renders the preview inside the ordinary Owned Annotation layer with a preview marker (`apps/web/src/pdf/PdfWorkspace.tsx:346-380`). This makes the proposal appear where and how it will appear after acceptance, without inventing a composer-only rendering vocabulary.

Keep preview state visual and provisional. The visible layer includes the preview, but Owned Annotation interaction geometry remains derived from accepted annotations only (`apps/web/src/pdf/PdfWorkspace.tsx:123-139`). Cancel clears the preview without building a Review command; Apply, Save, or Keep commits through the canonical command path and then clears the provisional projection (`apps/web/src/app/ReviewShell.tsx:765-810`).

### Let the composer take over the existing edge surface

The composer is a labeled `region` and form with no backdrop or modal role (`apps/web/src/review/CommentComposer.tsx:151-166`). On wide layouts it occupies the review edge; on narrow layouts the same mounted component becomes a viewport-contained bottom surface (`apps/web/src/app/review-layout-dialogs.css:111-124`, `apps/web/src/app/review-layout-responsive.css:17-44`). The mounted PDF therefore remains readable, navigable, and at the same zoom.

Nonmodal does not mean that every workspace control remains concurrently active. While authoring owns the edge, the References and tools workspaces remain mounted but become inert and hidden from the accessibility tree (`apps/web/src/review/ReferenceWorkspace.tsx:363-378`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx:116-129`). This avoids competing tray interactions while retaining the displaced workspace's logical mode, active row, scroll, and responsive state. Earlier focused tests failed when the ordinary tray remained live behind the composer and when Save Destination did not inert the composer beneath it (session history).

Do not recreate the displaced workspace after authoring. Snapshot whether it was open, its mode, active item, and Annotation Tray scroll offset. On Apply, Save, Keep, or Cancel, clear the preview, release the takeover, restore the active row and scroll, and return focus to the originating control, restored row edit action, prior workspace, or PDF fallback (`apps/web/src/app/ReviewShell.tsx:688-695`, `apps/web/src/app/ReviewShell.tsx:765-803`). Because the workspace stayed mounted, restoration does not need a synthetic toggle or a PDF reframe.

### Make anchor recovery conditional and minimal

The frozen session exposes one semantic page point for visibility and return navigation (`apps/web/src/review/authoring-session.ts:282-305`). Measure that point against the usable PDF viewport after subtracting composer occlusion. If it is outside, show one title-adjacent target icon; if it is visible or unavailable, show no recovery control (`apps/web/src/review/CommentComposer.tsx:27-54`, `apps/web/src/app/ProductionReviewApp.tsx:708-780`).

Route the return action through `NavigationCoordinator.navigateMainAnnotation` instead of directly scrolling the viewer. This preserves cancellation, settled-location, focus, and Meaningful Jump semantics. The recovery action may change the viewport, but it never changes the frozen anchor. Avoid permanent status badges, separate “Read Document” or “Return to Editor” modes, and always-visible return controls: the live PDF already supports reading, and recovery chrome is useful only when the anchor leaves view.

### Keep input semantics and actions local

Place Cancel, optional Keep, and the primary Save or Apply action directly below the textarea (`apps/web/src/review/CommentComposer.tsx:167-218`). Let the title carry single-field context while keeping the field's accessible name in a screen-reader-only label. Preserve the established Compact Editorial verbs: Save creates comments and Page Notes, Apply proposes text or edits a Review Item, Keep retains an uncommented highlight, and Cancel abandons the pending action (`apps/web/src/review/authoring-session.ts:203-250`).

A nested prerequisite such as Save Destination may temporarily supersede the composer, but it must not become draft authority. Keep the frozen authoring session mounted and inert while the true dialog is open. Cancelling destination selection or rejecting the command returns to the same draft; acceptance closes it; source replacement discards it as stale (`apps/web/src/app/ReviewShell.tsx:354-360`, `apps/web/src/app/ProductionReviewApp.tsx:1482-1510`, `apps/web/src/app/ProductionReviewApp.tsx:1682-1702`).

### Test retained-state combinations, not isolated elements

The riskiest regressions happen where two valid states coexist. Assert that:

- every authoring kind projects through accepted annotation semantics, and nested source mutation cannot retarget a session (`apps/web/test/authoring-session.test.ts:73-145`, `apps/web/test/authoring-session.test.ts:162-216`);
- the composer takeover survives wide/narrow transitions without remounting and restores the original tray row, scroll, focus, and PDF geometry after both Cancel and Apply (`test/acceptance/review-workflow.spec.ts:660-748`);
- an out-of-view anchor can be recovered through Back and Forward while the draft and preview remain attached to the original page (`test/acceptance/production-flow.spec.ts:3043-3100`);
- Save Destination cancellation preserves the exact draft and its single provisional preview without committing a Review Item; a first-command conflict likewise returns to the preserved composer for retry (`test/acceptance/production-flow.spec.ts:3888-3919`, `test/acceptance/production-flow.spec.ts:4344-4383`);
- opening Search or another workspace does not suppress a reliable insertion caret in the PDF (`apps/web/test/review-layout.test.tsx:180-201`, `test/acceptance/production-flow.spec.ts:2782-2813`).

The last invariant matters because in-place preview work exposed a real-PDF regression where insertion placement remained an input state but its cursor disappeared while a workspace was open. The durable boundary is that base-surface disclosure may coexist with selection actions and a reliable caret; only a genuinely nested authoring layer should suppress the caret (session history).

Prefer visibility and containment assertions over desktop-coordinate assertions at responsive breakpoints. Earlier tests over-specified the composer's exact narrow-screen position even though the product contract was simply that it remain visible, contained, and actionable (session history).

## Why This Matters

The live overlay removes the memory tax that caused reviewers to abandon a draft, reread the passage, recreate the selection, and start again. Showing the proposal at its eventual PDF location provides stronger context than repeating source text in an edge card, and it automatically gives new annotation kinds the accepted geometry and visual language.

Freezing authority prevents a subtle correctness failure. A new selection, caret click, tray interaction, responsive change, Back or Forward jump, or asynchronous Save Destination response must not redefine what Apply means. The session makes that invariant explicit while leaving the mutable draft responsive to typing.

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

| User action | Frozen authority | Live prospective state | Commit outcome |
| --- | --- | --- | --- |
| Type a replacement | Original text selection and document generation | Replacement mark at the selected text | Apply builds a replacement Review command |
| Type an insertion | Original caret position and surrounding context | Insertion caret and proposed text at that point | Apply builds an insertion Review command |
| Comment on a highlight | Original selection geometry | Highlight with the draft comment | Save commits the comment; Keep commits the highlight without it |
| Add a Page Note | Original page position | Page Note at that position | Save builds the Page Note command |
| Edit a Review Item | Cloned item identity, payload, and geometry | Existing mark replaced in place by the draft projection | Apply edits that same Review Item |

The unit contract covers this complete projection family in one table-shaped suite and separately covers stale authority plus nested Save Destination outcomes (`apps/web/test/authoring-session.test.ts:73-145`, `apps/web/test/authoring-session.test.ts:218-283`). In browser coverage, assert exactly one composer and one prospective mark: a duplicated source card or a second preview indicates that presentation has drifted away from the single-authority model.

## Related

- [Compact Editorial language for review task surfaces](compact-editorial-language-for-annotation-modals.md) defines the concise titles, hidden-but-accessible field labels, action verbs, and button language retained by the nonmodal composer.
- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md) owns the mounted-viewer, right-or-bottom host, and viewer-reachability contract that the authoring takeover reuses.
- [Return-to-origin navigation for stateful PDF Reference Tabs](../architecture-patterns/reference-tab-return-to-origin-navigation.md) is the precedent for an immutable semantic origin, viewer-owned visibility, and an outside-only target control.
- [Content-aware annotation workspace presentation](outline-aware-annotation-workspace-presentation.md) defines the logical tray state that authoring snapshots and restores.
- [Preserve document history for Annotation Tray navigation](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) owns the Meaningful Jump boundary reused by Return to annotation.
- [Reject stale viewer selection snapshots before creating annotation anchors](../ui-bugs/reject-stale-viewer-selection-snapshots.md) establishes the same frozen-authority principle one stage earlier, while text and geometry are captured into an anchor.
- [Portable PDF annotations invisible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md) defines the canonical Review Item-to-Owned Annotation projection reused for prospective marks.
- [Native control tooltip contract](../conventions/native-control-tooltip-contract.md) governs the target icon's visible, hover, and accessible naming.
