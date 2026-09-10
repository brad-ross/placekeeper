---
title: "Full Annotation Reader preserves Annotation Tray context"
date: "2026-08-24"
last_updated: 2026-09-10
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

Compact annotation cards must remain scannable while allowing every displayed passage to be read completely. The Full Annotation Reader, introduced in [PR #61](https://github.com/brad-ross/placekeeper/pull/61), keeps the PDF and surrounding review state available during detail reading. [PR #87](https://github.com/brad-ross/placekeeper/pull/87), open as of September 7, 2026, corrects content completeness and popup transitions; this document describes the current implementation, not a claim that that PR has merged.

The earlier authored-content-only contract omitted replacement source text, excluded deletes and quote-only highlights, and measured only the main excerpt. A short highlight comment with a long supporting quote exposed the mismatch: the annotation's longest meaningful text could be outside both eligibility and overflow detection. Tests that asserted authored-only output preserved the mistake. The shared contract now includes authored content, original source, and highlighted quotation (`apps/web/src/review/annotation-content.ts`, `apps/web/src/review/annotation-reader.ts`).

## Guidance

### Separate complete content from measured disclosure

Project the same semantic content for the compact card and full reader. Replacements retain proposed text and struck source; deletes retain struck source without authored content; highlights retain comments and a separate quote. Insertions and Page Notes use their existing content/fallback rules (`apps/web/src/review/annotation-content.ts`). A reader record is eligible when any projected content field is nonblank, not only when a comment or proposal exists (`apps/web/src/review/annotation-reader.ts`). Native Review Items project their comments through the same owned path. Residual Existing PDF Annotations still require nonblank contents and remain read-only (`apps/web/src/review/annotation-reader.ts`).

Eligibility does not imply that a disclosure control should appear. Measure actual overflow of both the main excerpt and quote, with the one-pixel tolerance, and remeasure on content, fonts, and relevant size changes. The hook observes both blocks and includes quote text in its content dependency (`apps/web/src/review/AnnotationExcerpt.tsx`). The quote itself is clamped in the compact view (`apps/web/src/app/neutral-chrome.css`). Character counts cannot substitute for these layout measurements.

When either block overflows, the excerpt becomes the Read full annotation button. Its click stops propagation so disclosure does not also navigate the row (`apps/web/src/review/AnnotationExcerpt.tsx`). The reader renders original/deleted source, authored content, and highlighted text as separate complete blocks (`apps/web/src/review/FullAnnotationReader.tsx`). A delete can therefore expose a long source passage without gaining an Edit action (`apps/web/src/review/FullAnnotationReader.tsx`). Reading eligibility and editability are separate decisions.

### Store identity and origin, not copied content

Resolve transient reader identity against current domain state. Owned records, including native Review Items, resolve by item ID; residual existing identities also carry document and discovery generations and fail closed when either changes (`apps/web/src/review/annotation-reader.ts`). `useAnnotationReader` checks authoring authority before resolution (`apps/web/src/review/use-annotation-reader.ts`). Do not retain copied text that can survive an edit or source replacement incorrectly.

Origin determines restoration. A list-origin reader returns to list context; a peek-origin reader returns to the compact popup. The shell mounts the latter outside the workspace when annotations are not visible (`apps/web/src/app/ReviewShell.tsx`). The annotation remains one domain object regardless of its presentation origin. Residual existing readers receive no owned Edit/Delete callbacks. Native comment edits and deletion remain subject to independently enforced PDF locks (`packages/core/src/native-pdf-annotation.ts`).

### Separate selected popups, hover previews, and explicit reading

With the workspace closed, selected annotation state retains the compact popup independently of hover correspondence (`apps/web/src/review/use-annotation-reader.ts`). The popup distinguishes selected and preview state and exposes owned actions accordingly (`apps/web/src/review/AnnotationPeek.tsx`). Hovering is not equivalent to selecting or expanding.

A PDF mark activation cancels older restoration and reader-resume work, clears the current reader, and changes selection. When no workspace is open it returns a compact peek, even if the annotation previously overflowed; expansion requires the explicit Read full action. The workspace-open branch may still disclose a measured long annotation in the list (`apps/web/src/review/use-annotation-reader.ts`). This distinction prevents cached overflow knowledge from silently reopening the full popup after dismissal.

### Keep detail disclosure separate from source navigation

Owned and imported excerpt entry install reader state and selection without invoking PDF navigation (`apps/web/src/review/use-annotation-reader.ts`). Back to annotation in PDF is an explicit navigation intent that uses the owned/imported navigation callbacks (`apps/web/src/review/use-annotation-reader.ts`). In the full reader it appears when the target is outside or a return is pending; disappearing-action focus restoration is conditional on that action having held focus (`apps/web/src/review/FullAnnotationReader.tsx`).

The compact popup also needs source visibility. Its target falls back to the current peek identity when no reader is open, and its return action is exposed when that target is outside (`apps/web/src/review/use-annotation-reader.ts`). Visibility refresh listens to actual PDF framing viewport scroll events, filtering out scrolling inside the annotation body, and responds to stage/window size changes (`apps/web/src/review/use-annotation-reader.ts`). A long reader body scrolling is not evidence that the PDF source moved.

### Restore context as a cancellable transition

Capture prior selection and list scroll on entry. On list restoration, validate document/discovery authority and the saved item, wait for rendering, restore scroll, and choose an available disclosure control, row target, workspace, or PDF fallback (`apps/web/src/review/use-annotation-reader.ts`). Restoration tokens and tracked animation frames let newer transitions invalidate old callbacks (`apps/web/src/review/use-annotation-reader.ts`). Otherwise a rapid Back-then-open sequence can steal focus and scroll from the newer reader.

Popup Back clears reader and pending resume/mark requests, returning to the compact card; keyboard activation can restore its disclosure focus (`apps/web/src/review/use-annotation-reader.ts`). Dismissal clears selected/peek state and pending reader work as well as cancelling restoration (`apps/web/src/review/use-annotation-reader.ts`). A selection change invalidates the old popup reader (`apps/web/src/review/use-annotation-reader.ts`). Escape invokes dismissal, and outside-click handling includes expanded peek readers rather than depending solely on compact-card state (`apps/web/src/review/use-annotation-reader.ts`). Reopening must start from the compact view instead of reviving a stale full-reader session.

### Re-evaluate eligibility after edits

An accepted edit can change both semantic content and rendered overflow. Retain a pending resume identity, then let a fresh overflow report decide whether to resume the reader or return to the origin (`apps/web/src/review/use-annotation-reader.ts`). Cancellation preserves the reader's editing context. If deletion or source replacement makes its identity unresolvable, restore a safe origin state rather than displaying stale contents (`apps/web/src/review/use-annotation-reader.ts`). Authority validation must protect restoration as well as visible content.

## Why This Matters

Content completeness and interaction continuity are independent requirements. A perfectly measured comment is insufficient when the quote is omitted. A complete reader is still broken if it prevents choosing another annotation or resurrects after dismissal. Keep semantic projection, layout measurement, identity authority, selected versus hover state, explicit navigation, and cancellable restoration distinct.

Tests should challenge these boundaries rather than repeat implementation assumptions. In particular, a short comment with a long quote catches failures that a long Page Note never exercises. Source-only content also proves that reader eligibility is not accidentally coupled to editability.

## When to Apply

Use this pattern when compact annotation cards expose potentially long authored or source text while a live PDF remains available. It fits mutable review state and read-only imported annotations. Exclude genuinely empty records; do not exclude deletion or quote-only highlights merely because they have no authored body. The reader remains transient presentation state, not durable navigation history.

Verify source-return visibility after PDF scrolling (`test/acceptance/annotation-behavior-followup.spec.ts`), selection changes while expanded (`test/acceptance/annotation-behavior-followup.spec.ts`), outside/Escape dismissal and compact reopening (`test/acceptance/annotation-behavior-followup.spec.ts`), and complete source-driven overflow across annotation kinds (`test/acceptance/annotation-behavior-followup.spec.ts`). Retain existing authority, edit-resume, framing, and restoration tests alongside these cases.

## Examples

A replacement has a brief proposal and a long original passage. The original passage triggers disclosure; the reader retains both source and proposal, and explicit source return leaves disclosure itself free of PDF navigation (`apps/web/src/review/annotation-content.ts`, `apps/web/src/review/FullAnnotationReader.tsx`).

A highlight's comment fits the card but its quote does not. Measuring the quote exposes Read full, and the reader includes the highlighted passage. A delete uses the same principle for its source text without offering Edit (`apps/web/src/review/AnnotationExcerpt.tsx`, `apps/web/src/review/FullAnnotationReader.tsx`).

With the workspace closed, a reviewer expands annotation A, selects B, dismisses B, and selects A again. New activation clears A's old reader session, so A reopens as a compact card (`apps/web/src/review/use-annotation-reader.ts`).

## Related

[Contextual Annotation Composer](contextual-annotation-composer-preserves-document-context-during-authoring.md) owns frozen edit authority; [adaptive overlay framing](../architecture-patterns/adaptive-annotation-tray-framing.md) owns passive reading-position preservation; [Reference return-to-origin](../architecture-patterns/reference-tab-return-to-origin-navigation.md) describes a related cancellation-generation boundary.
