---
title: "Full Annotation Reader preserves Annotation Tray context"
date: "2026-08-24"
last_updated: "2026-09-08"
category: "design-patterns"
module: "Full Annotation Reader"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "A compact annotation excerpt needs measured-overflow detail disclosure"
  - "Detail can originate from a tray row or a PDF annotation peek"
  - "Reading full annotation text should preserve current PDF position"
  - "Residual Existing PDF Annotation content must remain read-only"
  - "Edits and rapid transitions may invalidate identity, eligibility, or queued restoration"
related_components:
  - "Annotation Tray"
  - "AnnotationPeek"
  - "ReviewShell"
  - "Owned Annotation"
  - "Existing PDF Annotation"
  - "Contextual Annotation Composer"
tags:
  - "full-annotation-reader"
  - "annotation-tray"
  - "measured-overflow"
  - "transient-detail-state"
  - "authority-boundaries"
  - "tray-restoration"
  - "focus-restoration"
  - "read-only-annotations"
---

# Full Annotation Reader preserves Annotation Tray context

## Context

Compact annotation cards need to remain scannable without hiding long authored content. The Full Annotation Reader, introduced in [PR #61](https://github.com/brad-ross/placekeeper/pull/61), reveals the complete annotation while retaining the live PDF and surrounding review state.

The current contract separates reading detail from navigating to its source. Opening through an excerpt changes selection and reader state without moving the PDF. Explicit PDF mark activation may also open the reader while retaining its mark-reveal behavior (`apps/web/src/app/ReviewShell.tsx:1174`, `apps/web/src/app/ReviewShell.tsx:1191`). The reader can appear in the Annotations workspace or as a PDF-side popup with a `peek` origin. These supersede the earlier tray-only model and its mandatory navigation on entry (`apps/web/src/app/ReviewShell.tsx:906`, `apps/web/src/app/ReviewShell.tsx:2335`, `apps/web/src/app/ReviewShell.tsx:2570`).

## Guidance

### Separate content eligibility from rendered overflow

First project meaningful authored content. Owned replacement and insertion items use proposed text; commented highlights and Page Notes use comments; deletion has no full-reader content. Residual Existing PDF Annotations use nonblank contents and remain immutable; imported native Review Items instead project their comments through the owned reader path (`apps/web/src/review/annotation-reader.ts:60`, `apps/web/src/review/annotation-reader.ts:114`). This projection is a semantic decision, not a character-count threshold.

Then measure the rendered main excerpt. `AnnotationExcerpt` compares scroll and client dimensions with a one-pixel tolerance, observes relevant elements, remeasures after fonts and resize, and cancels pending work during cleanup (`apps/web/src/review/AnnotationExcerpt.tsx:14`, `apps/web/src/review/AnnotationExcerpt.tsx:29`). Source and authored text can participate in the main excerpt, while a separate quote is outside the measured main block (`apps/web/src/review/AnnotationExcerpt.tsx:109`).

When eligible content overflows, the excerpt becomes the Read full annotation button. Its click stops propagation so detail disclosure does not also invoke row navigation (`apps/web/src/review/AnnotationExcerpt.tsx:124`). Do not restore the obsolete floated inline “More ›” cap: the current interactive excerpt supplies the disclosure target without overlaying a separate control on text.

### Store identity and origin, not copied content

Keep a transient session containing identity, authority, origin, prior selection, and scroll restoration state. Resolve its record against live review state rather than storing a copied body. Owned records, including native Review Items, resolve by item ID; residual existing identities include document and discovery generations and fail closed after replacement or rediscovery (`apps/web/src/review/annotation-reader.ts:150`). The shell additionally checks authoring authority before resolving a record (`apps/web/src/app/ReviewShell.tsx:645`).

Origin matters independently of identity. A list entry must return to list context; a popup entry returns to its peek surface. The same owned annotation can use either origin without becoming two domain objects. The shell renders a peek-origin reader outside the workspace when annotations are not visible, and otherwise supplies the reader to the mounted annotations slot (`apps/web/src/app/ReviewShell.tsx:2335`, `apps/web/src/app/ReviewShell.tsx:2570`). Residual existing readers receive no owned Edit/Delete callbacks. Native Review Items use the owned path; comment edits and deletion remain subject to independently enforced PDF locks (`apps/web/src/review/annotation-reader.ts:78`; `packages/core/src/native-pdf-annotation.ts:33`).

### Keep detail disclosure separate from explicit navigation

Both owned and imported open functions select the annotation and install reader state without invoking navigation callbacks (`apps/web/src/app/ReviewShell.tsx:906`, `apps/web/src/app/ReviewShell.tsx:931`). The live PDF remains source context, but detail opening does not assert that the reviewer wants to leave the current passage.

Back to annotation in PDF appears when the source target is outside or a return is pending. Its explicit action uses the established owned/imported navigation callback and marks navigation intent with framing authority (`apps/web/src/review/FullAnnotationReader.tsx:95`, `apps/web/src/app/ReviewShell.tsx:967`). Source text need not be duplicated into another document view merely to compensate for this separation.

When the locate action disappears, focus moves to Back only if that disappearing action held focus. Otherwise an unrelated keyboard or pointer interaction keeps its focus (`apps/web/src/review/FullAnnotationReader.tsx:30`, `apps/web/src/review/FullAnnotationReader.tsx:100`).

### Restore context as a cancellable transition

Capture the list scroll offset and prior active item on entry. On return, validate authority and the saved active item before applying them. Wait for list rendering, then restore scroll and choose a visible excerpt trigger, row navigation, workspace, or PDF fallback (`apps/web/src/app/ReviewShell.tsx:757`). Track restoration frames and a token so a newer reader or editor transition invalidates old callbacks. Without this fence, a rapid Back-then-open sequence lets the first reader steal the second reader's focus and scroll.

Back preserves input intent. Keyboard activation requests row-focus restoration; pointer activation returns to the workspace fallback rather than forcing the row's focus treatment (`apps/web/src/review/FullAnnotationReader.tsx:40`, `apps/web/src/app/ReviewShell.tsx:835`). Peek-origin close returns to the popup's excerpt control through its separate branch (`apps/web/src/app/ReviewShell.tsx:954`). Do not generalize the list's pointer-versus-keyboard policy to every origin.

### Re-evaluate reader eligibility after edits

An edit can change semantic eligibility and rendered overflow. Resolve the updated item before deciding where to return. Accepted reader edits temporarily leave reader mode and retain a pending resume identity; a fresh excerpt overflow report resumes the reader with Edit focused only if it still overflows. Otherwise restore the row (`apps/web/src/app/ReviewShell.tsx:1409`, `apps/web/src/app/ReviewShell.tsx:1021`). Cancel preserves the reader context rather than constructing another reader session from stale copied text.

If deletion, source replacement, or imported discovery refresh makes the record unresolvable, restore a safe origin/workspace state rather than displaying stale contents (`apps/web/src/app/ReviewShell.tsx:1011`). Restoration must validate authority too; validating only visible reader content leaves stale selection and focus work alive.

## Why This Matters

Four plausible shortcuts fail differently: character counts misclassify overflow after reflow; copied reader bodies survive edits incorrectly; navigation on excerpt disclosure moves the PDF unexpectedly; unguarded deferred restoration overwrites newer intent. Separating semantic projection, measured overflow, transient identity, explicit navigation, and cancellable restoration prevents those concerns from becoming one fragile click handler.

The old inline control and mandatory source jump are historical design choices, not requirements to preserve. What survives is the user's place: current PDF framing, origin surface, selection, scroll, and appropriate focus.

## When to Apply

Use this pattern when a compact list or popup exposes long authored fields while source context remains available elsewhere. It fits live domain state that can change during reading or editing. Avoid full-reader disclosure for deletion or blank authored content, and avoid using this transient reader as durable document-navigation history.

Verify transitions, not screenshots alone: unchanged PDF framing on entry and Back (`test/acceptance/review-workflow.spec.ts:1850`), long-to-short accepted edits (`test/acceptance/review-workflow.spec.ts:1934`), superseded restoration frames (`test/acceptance/review-workflow.spec.ts:1957`), imported read-only entry without navigation (`test/acceptance/review-workflow.spec.ts:2016`), and disappearing-locate focus ownership (`apps/web/test/annotation-components.test.tsx:97`).

## Examples

An owned replacement overflows its compact excerpt. Clicking the excerpt opens complete proposed text and keeps the PDF where it is. Back to annotation explicitly navigates if source context is needed.

An edit shortens a Page Note enough to fit its card. The next measured overflow report returns to that row instead of reopening an unnecessary reader.

An imported annotation refresh changes discovery generation. Its old identity becomes unresolvable; the reader and restoration paths reject stale authority instead of showing cached contents.

Related: [Contextual Annotation Composer](contextual-annotation-composer-preserves-document-context-during-authoring.md) owns frozen edit authority; [adaptive overlay framing](../architecture-patterns/adaptive-annotation-tray-framing.md) owns passive reading-position preservation; [Reference return-to-origin](../architecture-patterns/reference-tab-return-to-origin-navigation.md) describes a related cancellation-generation boundary.
