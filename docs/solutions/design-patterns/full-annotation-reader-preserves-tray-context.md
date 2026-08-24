---
title: Full Annotation Reader preserves Annotation Tray context
date: 2026-08-24
category: design-patterns
module: Full Annotation Reader
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "A compact annotation list clamps authored content and needs a detail disclosure only after rendered overflow is measured"
  - "A detail surface must preserve live PDF source context and use the annotation's existing navigation path before opening"
  - "Owned and imported annotations share a tray presentation but imported content must remain read-only"
  - "A transient detail view inside a mounted tray must restore list selection, scroll position, and focus"
  - "An edit or rapid transition can invalidate reader identity, overflow eligibility, or queued animation-frame restoration"
related_components:
  - "Annotation Tray"
  - "ReviewShell"
  - "Owned Annotation"
  - "Existing PDF Annotation"
  - "Contextual Annotation Composer"
  - "testing_framework"
tags:
  - "full-annotation-reader"
  - "annotation-tray"
  - "measured-overflow"
  - "transient-detail-state"
  - "authority-boundaries"
  - "tray-restoration"
  - "animation-frame"
  - "read-only-annotations"
---

# Full Annotation Reader preserves Annotation Tray context

## Context

Compact annotation cards must stay scannable, but visually clamping authored comments, replacement text, and insertion text can hide information a reviewer needs. The Full Annotation Reader introduced in [PR #61](https://github.com/brad-ross/placekeeper/pull/61) keeps the compact list as the browsing surface and reveals complete annotation-specific content without moving source context into a second document view. PR #61 merged into `main` on 2026-08-24.

The implementation evolved from a general “read the truncated text” affordance into a coordinated list/detail state contract. Live review rejected controls that overlaid excerpt text, redundant source-text repetition, and reader chrome that consumed the metadata line; the settled design uses a true inline `More ›` cap, the live highlighted PDF as source context, and compact title actions (session history).

Reader eligibility has two layers. First, project only meaningful authored content: owned Replace and Insert items use `proposedText`, commented Highlight and Page Note items use `comment`, and Delete has no reader content (`apps/web/src/review/annotation-reader.ts:58-101`). Imported PDF annotations project their `contents` into an immutable reader record and retain document and discovery generations in their identity (`apps/web/src/review/annotation-reader.ts:110-135`). Second, test rendered geometry rather than character count: visual overflow is the measured difference between scroll and client dimensions, with a one-pixel tolerance (`apps/web/src/review/AnnotationExcerpt.tsx:12-16`).

## Guidance

### Gate disclosure on meaning and rendered geometry

Keep the compact row as the browsing surface and render `More ›` only when the annotation has reader-eligible content and the excerpt actually overflows. `AnnotationExcerpt` measures after layout, observes its own and parent dimensions, reacts to resize and font completion, and removes pending work and listeners during cleanup (`apps/web/src/review/AnnotationExcerpt.tsx:29-68`). A character threshold cannot stay truthful across tray widths, fonts, zoom, or responsive presentation.

The affordance must consume real line space. The control is rendered inside the excerpt, and its floated inline placement caps the final visible line instead of absolutely overlaying arbitrary text (`apps/web/src/review/AnnotationExcerpt.tsx:95-115`, `apps/web/src/app/review-layout-annotations.css:1604-1646`). Keep the row-navigation button as a separate target so `More ›` does not replace ordinary annotation selection (`apps/web/src/review/AnnotationList.tsx:166-183`).

### Store identity, not copied reader content

Reader state should contain a transient identity, current authority, and restoration snapshot. Resolve the visible record from live state on every render. `ReviewShell` rejects a reader whose authoring authority no longer matches, then resolves current owned items or imported annotations using the active document generation (`apps/web/src/app/ReviewShell.tsx:546-557`). Imported identities fail closed when their document generation, discovery status, or discovery generation changes (`apps/web/src/review/annotation-reader.ts:146-176`).

This makes edits and source replacement ordinary state changes rather than synchronization problems. If the identity no longer resolves, close the reader and restore a safe list/workspace state instead of displaying a frozen copy (`apps/web/src/app/ReviewShell.tsx:725-733`).

### Keep the PDF and Annotation Tray mounted

Swap the Annotations panel's list content for `FullAnnotationReader`; do not replace the PDF or create another source-context surface. `OutlineAnnotationsWorkspace` continues to own the mounted tray while its annotations slot renders either the list or reader (`apps/web/src/app/ReviewShell.tsx:1824-1861`).

Opening a reader must retain the annotation's established PDF-navigation behavior. Owned readers mark the Review Item active and invoke its navigation callback before installing reader state; imported readers invoke their existing-annotation navigation callback before opening (`apps/web/src/app/ReviewShell.tsx:678-723`). This keeps the highlighted PDF location authoritative and avoids duplicating “original text” in reader chrome.

Imported annotations remain read-only. The reader receives Edit only for an owned identity, while source provenance remains display metadata (`apps/web/src/review/FullAnnotationReader.tsx:63-96`, `apps/web/src/app/ReviewShell.tsx:1845-1859`). In list cards, keep compact Edit, Delete, and Copy Link actions in the title row while the excerpt retains its own body row (`apps/web/src/review/AnnotationList.tsx:184-222`).

### Treat restoration as a cancellable transition

Capture tray scroll and prior active selection on entry. On Back, restore only after the list has rendered, prefer the originating `More ›` control when it is still visible, and fall back through the row, workspace, and PDF targets (`apps/web/src/app/ReviewShell.tsx:620-652`, `apps/web/src/app/ReviewShell.tsx:688-700`). Validate a saved active Review Item against current state before restoring it (`apps/web/src/app/ReviewShell.tsx:610-619`).

Deferred focus and scroll work can outlive the interaction that scheduled it. Track queued animation frames, invalidate them with a restoration token when a newer reader or editor transition begins, and guard callbacks before applying old state (`apps/web/src/app/ReviewShell.tsx:599-607`). Without cancellation, a rapid Back-then-More sequence can let the first reader's restoration steal focus and scroll from the second.

### Re-evaluate eligibility after editing

An accepted edit can change both content and geometry. Resolve the updated annotation first, leave reader mode temporarily, and wait for the restored excerpt to report current overflow. Resume the reader only when content still overflows; otherwise keep the row active and return focus to its navigation target (`apps/web/src/app/ReviewShell.tsx:735-751`, `apps/web/src/app/ReviewShell.tsx:1036-1065`).

### Test the transition matrix

The risky behavior lies between individually valid states. Browser coverage should exercise owned and imported entry, Back restoration, edit Cancel, accepted long and short edits, deletion, source replacement, imported discovery refresh, and rapid navigation while restoration frames are pending. The implementation's acceptance suite checks ordinary selection/scroll/focus restoration (`test/acceptance/review-workflow.spec.ts:751-795`), explicitly holds animation frames to catch stale Back restoration (`test/acceptance/review-workflow.spec.ts:860-916`), and verifies imported navigation remains read-only (`test/acceptance/review-workflow.spec.ts:918-932`).

Keep behavioral and visual evidence independent. During development, the browser runner could not share the polish server and one live DOM helper was unavailable; stopping the preview before focused browser runs and retaining screenshot-plus-assertion coverage prevented those tooling constraints from becoming product blind spots (session history).

## Why This Matters

Geometry-gated disclosure keeps the compact card honest as font metrics and available width change. An identity-keyed reader prevents stale copied content from surviving accepted edits, document replacement, or imported-annotation refresh. A mounted surface preserves the reader's place in both the PDF and tray instead of reconstructing either state after every transition.

Restoration is user-visible behavior, not incidental polish. Scroll, selection, and focus together define where the reviewer was; cancellation ensures that a newer intent owns those values. Treating these concerns as one state contract avoids a feature that reads correctly in a screenshot but fails under reflow, keyboard use, or rapid navigation.

## When to Apply

Apply this pattern when a compact, scrollable list is the primary navigation surface but one authored field can be too long to read reliably in place, especially when the original source remains visible elsewhere. It fits when:

- full content can be derived from current domain state rather than copied into a durable UI record;
- opening detail should retain an existing navigation or selection side effect;
- the source or item may refresh while detail is open; or
- returning to the list must preserve scroll position, selection, and keyboard context.

Do not create a full reader for source-only content already represented by the live PDF. The owned projection intentionally returns `null` for Delete and for annotations without non-blank authored content (`apps/web/src/review/annotation-reader.ts:58-89`). Do not use this pattern for sequential document browsing, durable reader navigation history, or multiple simultaneous detail sessions.

## Examples

- **Owned replacement:** `projectOwnedAnnotationReader` labels non-blank replacement content, assigns an owned identity, and marks it mutable; the reader can offer Edit without duplicating source text (`apps/web/src/review/annotation-reader.ts:63-101`). Projection tests verify the reader content excludes the original selection (`apps/web/test/annotation-reader.test.ts:39-79`).
- **Imported highlight:** `projectExistingAnnotationReader` carries contents, optional author, and source generations while setting `mutable: false` (`apps/web/src/review/annotation-reader.ts:110-135`). The browser workflow asserts that opening uses existing PDF navigation and renders no Edit action (`test/acceptance/review-workflow.spec.ts:918-932`).
- **Edit becomes short:** the accepted-edit path clears reader mode pending a fresh measurement; when overflow becomes false, it restores the active row and row-navigation focus (`apps/web/src/app/ReviewShell.tsx:735-751`, `apps/web/src/app/ReviewShell.tsx:1036-1065`; `test/acceptance/review-workflow.spec.ts:837-858`).
- **Source becomes stale:** document and discovery generations make an imported identity unresolvable after source replacement or refresh, so the reader closes to the annotations workspace (`apps/web/src/review/annotation-reader.ts:146-176`; `test/acceptance/review-workflow.spec.ts:934-962`).

## Related

- [Contextual Annotation Composer preserves document context during authoring](contextual-annotation-composer-preserves-document-context-during-authoring.md) owns the adjacent authoring takeover, frozen-authority, and displaced-surface restoration pattern.
- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md) owns the mounted right-or-bottom tray and live-PDF framing boundary.
- [Preserve document history for Annotation Tray navigation](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) owns the canonical owned/imported annotation navigation path used before reader entry.
- [Return-to-origin navigation for stateful PDF Reference Tabs](../architecture-patterns/reference-tab-return-to-origin-navigation.md) documents the related cancellation-generation pattern for stale deferred restoration.
- [Exclude Navigation Links from Existing PDF Annotation Inventories](../integration-issues/exclude-navigation-links-from-existing-pdf-annotations.md) defines the reviewer-relevant imported-annotation boundary.
