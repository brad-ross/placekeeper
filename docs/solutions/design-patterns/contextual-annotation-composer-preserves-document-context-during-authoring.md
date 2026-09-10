---
title: "Contextual Annotation Composer preserves document context during authoring"
date: "2026-08-22"
last_updated: 2026-09-10
category: "design-patterns"
module: "PDF review annotation authoring"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Annotation authoring must remain bound to its original passage during navigation"
  - "A stable provisional mark can show the frozen anchor in the live document"
  - "A passage-attached nonmodal editor must remain usable after its anchor leaves view"
  - "A nested prerequisite must preserve draft and source authority"
  - "Host revision events may arrive before their originating command response"
related_components:
  - "Contextual Annotation Composer"
  - "ReviewShell"
  - "usePassageEditorPlacement"
  - "Owned Annotation"
  - "Review Host Runtime"
  - "Viewer Framing Adapter"
tags:
  - "contextual-annotation-composer"
  - "annotation-authoring"
  - "frozen-authority"
  - "stable-preview-projection"
  - "passage-placement"
  - "anchor-recovery"
  - "command-invalidation-ordering"
  - "nonmodal-composer"
---

# Contextual Annotation Composer preserves document context during authoring

## Context

Anchored annotation entry must preserve both the source passage and the unfinished draft. Blocking composers made reviewers cancel, reread, recreate the anchor, and start again. A contextual editor instead keeps the PDF live and projects the prospective annotation at its original anchor. The durable design separates immutable authoring authority, mutable draft text, provisional document projection, placement, and asynchronous submission.

The [accepted passage-attached editor contract](../../plans/2026-09-05-neutral-soft-design-contract.md#editor-placement--passage-attached-editor) supersedes the earlier edge-surface takeover recommendation. The composer now sits beside, below, or above the visible passage when space permits, with a bottom-sheet fallback. Existing workspace state remains retained behind authoring. The earlier implementations in [PR #49](https://github.com/brad-ross/placekeeper/pull/49) and [PR #68](https://github.com/brad-ross/placekeeper/pull/68) remain useful context for frozen authority, stable previews, and host invalidation ordering; their old edge-placement mechanics are not current guidance.

## Guidance

### Freeze authority; keep only the draft mutable

Create one authoring session from the source identity, document generation, selection/caret/page anchor or existing Review Item, origin control, and workspace snapshot. Clone and freeze nested geometry and payloads rather than retaining mutable selection objects (`apps/web/src/review/authoring-session.ts`). `useAuthoringSession` refuses a second active session and asks the shell to snapshot workspace mode, active item, and annotation scroll before authoring (`apps/web/src/review/use-authoring-session.ts`).

Typing changes the composer's local value, not the frozen source. Generated-output authoring additionally protects that text as a revisioned draft. Apply first protects the latest value and then submits the exact protected draft revision; commands carry the original session authority and close stale sessions rather than retargeting them (`apps/web/src/review/use-authoring-session.ts`). Exploration may change what is visible without changing what Apply means.

### Keep document projection stable while text changes

Construct a temporary Review Item from the frozen source and use the ordinary Review Item projection functions, including page-specific projections for multi-page anchors (`apps/web/src/review/authoring-session.ts`). Publish preview annotations when the session changes, not on every keystroke (`apps/web/src/review/use-authoring-session.ts`). The PDF merges previews into its visible annotation population, while interaction geometry remains derived from accepted annotations (`apps/web/src/pdf/PdfWorkspace.tsx`).

This distinction prevents unchanged PDF geometry from becoming a controlled text-input surface. Current text stays authoritative in the composer and protected draft until commit. Cancel clears provisional presentation; generated-output cancellation also discards its protected draft through the canonical command path. Neither operation turns a preview into an accepted Review Item (`apps/web/src/review/use-authoring-session.ts`).

### Attach placement to visible passage geometry

The shell selects rendered owned marks by the frozen item's ID or the session preview ID and supplies a selection, caret, or page-menu fallback when available (`apps/web/src/app/ReviewShell.tsx`). The placement hook measures the stage, open supporting surfaces, editor, and visual viewport. Open trays constrain usable boundaries; the editor does not become another runway owner (`apps/web/src/review/use-passage-editor-placement.ts`).

Prefer side placement, then below, then above, and retain the prior placement kind while it still fits. Fall back to a bottom sheet when the adjacent editor cannot fit. Clamp all choices to usable bounds (`apps/web/src/review/use-passage-editor-placement.ts`). Use the intended editor width for fresh measurement, not a previously clamped rendered width: otherwise a narrow layout becomes permanently narrow after the stage grows (`apps/web/src/review/use-passage-editor-placement.ts`).

For multiline or multi-page marks, determine visibility from all rendered target rectangles. Choose a visible fragment, preferring the fragment nearest the original fallback when several are visible. A single anchor point may be offscreen while another part of the passage remains visible; it must not incorrectly trigger recovery (`apps/web/src/review/use-passage-editor-placement.ts`). The shell prefers this rendered-passage visibility over point-based navigation visibility (`apps/web/src/app/ReviewShell.tsx`).

When the target leaves view, keep the last usable editor placement and reclamp it to current bounds. If no visible placement has existed, establish a safe contained placement. Do not chase an offscreen anchor or navigate automatically. Deduplicate unchanged placement state, coalesce geometry events, and scope preferred placement to the session anchor key (`apps/web/src/review/use-passage-editor-placement.ts`).

### Preserve workspace continuity without prescribing edge takeover

The composer remains a nonmodal form in the drawer host. Open workspaces stay mounted and become inert during authoring; their `aria-hidden` state follows whether they are open, and takeover CSS disables pointer events and transitions rather than hiding them (`apps/web/src/app/ReviewShell.tsx`, `apps/web/src/review/ReferenceWorkspace.tsx`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx`, `apps/web/src/app/review-layout-annotations.css`). The old guidance that the editor must replace and hide the edge surface should not be restored.

Closing clears the provisional projection and nested authoring state, restores the recorded active item and list scroll, and returns focus with `preventScroll`. Originating controls, restored row actions, the prior workspace, and the PDF provide ordered fallbacks. Edits launched from the full reader have their own reader-resume branch (`apps/web/src/review/use-authoring-session.ts`). This restores interaction context without using a synthetic tray toggle or rewinding the current PDF location.

Save Destination may temporarily inert the drawer host, including the still-mounted composer. Cancelling that prerequisite returns focus to its editor; the prerequisite never becomes draft authority (`apps/web/src/review/use-authoring-session.ts`).

### Make recovery explicit and local

When the passage is outside, show the original-page cue and Back to passage. While return is pending, disable its action; when visible or unavailable, omit it (`apps/web/src/review/CommentComposer.tsx`). Return routes through `NavigationCoordinator.navigateMainAnnotation` with session-token checks, preserving navigation cancellation and history rather than issuing an uncoordinated scroll (`apps/web/src/app/ProductionReviewApp.tsx`). It changes the viewport, never the frozen source.

Keep Cancel and Save/Apply beside the input. For an optional highlight comment, Save accepts an empty value and preserves the highlight; Cancel abandons it (`apps/web/src/review/CommentComposer.tsx`). The textarea grows within bounds and then scrolls internally; typing, focus, and draft state survive placement updates (`apps/web/src/review/CommentComposer.tsx`). Avoid permanent editor/reading modes or duplicated source cards when the live provisional mark already supplies context.

### Reconcile host invalidations with their originating command

A host can emit a command's revision before returning its response. Rehydrating for both messages can replace the PDF and composer during an otherwise valid draft update. The runtime defers revision invalidations while commands are pending, retains the newest one, updates observed identity from the response, then releases only an invalidation not already represented by that identity. Release runs in `finally`, so failed commands cannot strand legitimate events; generation and freshness events do not enter this revision-only deferral (`apps/web/src/host/vscode-runtime.ts`).

Keep this causal reconciliation in the transport. Do not teach the shared composer to ignore host revisions. Likewise, disposed viewer adapters return unavailable snapshots so late layout work cannot read torn-down viewer state (`apps/web/src/pdf/viewer-framing-adapter.ts`).

A separate interaction boundary also survives the redesign: reverse-SyncTeX PDF gestures must release pointer capture before subsequent composer clicks. Otherwise a valid Cancel or Apply control can appear unresponsive despite correct draft state (`apps/web/src/pdf/PdfWorkspace.tsx`).

## Why This Matters

These failures share a mistaken ownership transfer: live selection replacing frozen source, keystrokes replacing stable geometry, conditional visibility replacing placement, a command notification replacing its response, or a completed PDF gesture retaining the next click. Each lifetime needs its own authority.

Placement is presentation, not semantic ownership. Keeping that boundary allows a local editor to follow a visible passage, remain usable after scrolling away, survive nested prerequisites, and commit exactly the original intended annotation. Retained workspace state provides continuity without requiring the obsolete edge layout.

## When to Apply

Use this pattern for anchored edits that benefit from live document exploration and may wait on asynchronous prerequisites. Identify immutable source authority, mutable text, provisional projection, placement, and restoration before implementation. Prefer simpler inline editing when the accepted object is already directly editable.

Test retained-state combinations: frozen nested anchors and multi-page projection (`apps/web/test/authoring-session.test.ts`), stable placement preferences (`apps/web/test/neutral-overlay-layout.test.ts`), first-page multiline visibility and offscreen recovery (`test/acceptance/production-flow.spec.ts`), unchanged preview publication while typing (`test/acceptance/review-workflow.spec.ts`), command-caused versus newer invalidations and command failure (`apps/web/test/host-runtime.test.ts`), and conflict retry retaining the composer (`test/acceptance/production-flow.spec.ts`). Geometry coverage should assert containment and passage visibility rather than obsolete desktop coordinates.

## Examples

A reviewer starts replacing text, scrolls to another page, and continues typing. The editor stays at its last usable clamped position with an original-page cue. Back to passage explicitly reveals the source; Apply still uses the original frozen selection.

A multiline highlight's first fragment leaves view while its last fragment remains visible. Recovery stays absent because rendered-passage visibility considers every fragment. Only when the whole rendered passage leaves the usable region does the return action appear.

A protected draft command emits revision 12 before returning revision 12. The runtime consumes the duplicate invalidation after the response. If revision 13 arrives instead, it remains actionable; stability does not justify suppressing a newer external change.

## Related

- [Overlay framing](../architecture-patterns/adaptive-annotation-tray-framing.md) separates passive reachability from explicit navigation.
- [Full Annotation Reader](full-annotation-reader-preserves-tray-context.md) owns inspection identity and return-to-list restoration.
- [Host runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) retain transport-specific authority outside shared review UI.
- [Selection snapshots](../ui-bugs/reject-stale-viewer-selection-snapshots.md) establish a temporally consistent anchor before authoring freezes it.
- [Annotation navigation history](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) defines the Meaningful Jump used by explicit passage recovery.
