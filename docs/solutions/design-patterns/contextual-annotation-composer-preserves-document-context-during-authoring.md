---
title: "Contextual Annotation Composer preserves document context during authoring"
date: "2026-08-22"
last_updated: 2026-09-18
category: "design-patterns"
module: "PDF review annotation authoring"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Annotation authoring must remain bound to its original passage during navigation"
  - "A stable provisional mark can show the frozen anchor in the live document"
  - "A passage-attached nonmodal editor must remain usable after its anchor leaves view"
  - "Live PDF refresh must coexist with protected drafts and asynchronous finalization"
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
  - "interaction-lifecycle"
  - "pdf-persistence"
---

# Contextual Annotation Composer preserves document context during authoring

## Context

Anchored annotation entry must preserve both the source passage and the unfinished draft. Blocking composers made reviewers cancel, reread, recreate the anchor, and start again. A contextual editor instead keeps the PDF live and projects the prospective annotation at its original anchor. The durable design separates immutable authoring authority, mutable draft text, provisional document projection, placement, and asynchronous submission.

The [accepted passage-attached editor contract](../../plans/2026-09-05-neutral-soft-design-contract.md#editor-placement--passage-attached-editor) supersedes the earlier edge-surface takeover recommendation. The composer now sits beside, below, or above the visible passage when space permits, with a bottom-sheet fallback. Existing workspace state remains retained behind authoring. The earlier implementations in [PR #49](https://github.com/brad-ross/placekeeper/pull/49) and [PR #68](https://github.com/brad-ross/placekeeper/pull/68) remain useful context for frozen authority, stable previews, and host invalidation ordering; their old edge-placement mechanics are not current guidance.

## Guidance

### Freeze authority; keep only the draft mutable

Create one authoring session from the source identity, document generation, selection/caret/page anchor or existing Review Item, originating PDF Annotation Surface, origin control, and workspace snapshot. A Reference origin also freezes a recovery target and preferred tab identity; the active tab is not a substitute for that origin. Clone and freeze nested geometry and payloads rather than retaining mutable selection objects (`apps/web/src/review/authoring-session.ts`). `useAuthoringSession` refuses a second active session and asks the shell to snapshot workspace mode, active item, and annotation scroll before authoring (`apps/web/src/review/use-authoring-session.ts`).

Typing changes the composer's local value, not the frozen source. Generated-output authoring and interaction-lifecycle authoring additionally protect that text as a revisioned draft. Apply first protects the latest value and then submits the exact protected draft revision; commands carry the original session authority and revoke stale submission authority rather than retargeting the draft (`apps/web/src/review/use-authoring-session.ts`). Exploration may change what is visible without changing what Apply means.

### Keep document projection stable while text changes

Construct a temporary Review Item from the frozen source and use the ordinary Review Item projection functions, including page-specific projections for multi-page anchors (`apps/web/src/review/authoring-session.ts`). Publish preview annotations when the session changes, not on every keystroke (`apps/web/src/review/use-authoring-session.ts`). The PDF merges previews into its visible annotation population, while interaction geometry remains derived from accepted annotations (`apps/web/src/pdf/PdfWorkspace.tsx`).

This distinction prevents unchanged PDF geometry from becoming a controlled text-input surface. Current text stays authoritative in the composer and protected draft until commit. Cancel clears provisional presentation and discards protected work through the appropriate canonical command or interaction finalization path. Neither operation turns a preview into an accepted Review Item (`apps/web/src/review/use-authoring-session.ts`).

### Attach placement to visible passage geometry

The shell selects rendered owned marks by the frozen item's ID or the session preview ID and supplies a selection, caret, or page-menu fallback when available (`apps/web/src/app/ReviewShell.tsx`). The placement hook measures the stage, open supporting surfaces, editor, and visual viewport. Open trays constrain usable boundaries; the editor does not become another runway owner (`apps/web/src/review/use-passage-editor-placement.ts`).

Prefer side placement, then below, then above, and retain the prior placement kind while it still fits. Fall back to a bottom sheet when the adjacent editor cannot fit. Clamp all choices to usable bounds (`apps/web/src/review/use-passage-editor-placement.ts`). Use the intended editor width for fresh measurement, not a previously clamped rendered width: otherwise a narrow layout becomes permanently narrow after the stage grows (`apps/web/src/review/use-passage-editor-placement.ts`).

For multiline or multi-page marks, determine visibility from all rendered target rectangles. Choose a visible fragment, preferring the fragment nearest the original fallback when several are visible. A single anchor point may be offscreen while another part of the passage remains visible; it must not incorrectly trigger recovery (`apps/web/src/review/use-passage-editor-placement.ts`). The shell prefers this rendered-passage visibility over point-based navigation visibility (`apps/web/src/app/ReviewShell.tsx`).

When the target leaves view, keep the last usable editor placement and reclamp it to current bounds. If no visible placement has existed, establish a safe contained placement. Do not chase an offscreen anchor or navigate automatically. Deduplicate unchanged placement state, coalesce geometry events, and scope preferred placement to the session anchor key (`apps/web/src/review/use-passage-editor-placement.ts`).

### Preserve workspace continuity without prescribing edge takeover

The composer remains a nonmodal form in the drawer host. Supporting workspaces stay mounted, but authoring is not a blanket inert state: an open Reference workspace keeps its tab, hide/show, and close controls available while suppressing automatic focus changes that would steal editor focus. Competing semantic operations are guarded separately, including Send to Main during authoring (`apps/web/src/app/ReviewShell.tsx`, `apps/web/src/review/ReferenceWorkspace.tsx`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx`). The old guidance that the editor must replace and hide the edge surface should not be restored.

Closing clears the provisional projection and nested authoring state. Ordinary Main-origin closing restores the recorded active item and annotation-list scroll, using the originating control, restored row actions, prior workspace, and PDF as ordered focus fallbacks. Reference-origin closing preserves the current Reference context and prefers its visible origin control or current Reference view for focus. Both focus-restoration paths use `preventScroll`; source-replacement closure skips restoration. Edits launched from the full reader have their own reader-resume branch (`apps/web/src/review/use-authoring-session.ts`). This restores interaction context without using a synthetic tray toggle or rewinding the current PDF location.

Save Destination may temporarily inert the drawer host, including the still-mounted composer. Cancelling that prerequisite returns focus to its editor; the prerequisite never becomes draft authority (`apps/web/src/review/use-authoring-session.ts`).

### Make recovery explicit and local

When the passage is outside, show the original-page cue and Back to passage. While return is pending, disable its action; when visible or unavailable, omit it (`apps/web/src/review/CommentComposer.tsx`). Main-origin return routes through `NavigationCoordinator.navigateMainAnnotation`. Reference-origin return instead validates the session token and source authority, then opens or reuses the frozen recovery target with its preferred tab identity and optional annotation identity. It can recreate a closed origin tab without moving Main (`apps/web/src/app/ProductionReviewApp.tsx`). Both routes change presentation, never the frozen source.

Keep Cancel and Save/Apply beside the input. For an optional highlight comment, Save accepts an empty value and preserves the highlight; Cancel abandons it (`apps/web/src/review/CommentComposer.tsx`). The textarea grows within bounds and then scrolls internally; typing, focus, and draft state survive placement updates (`apps/web/src/review/CommentComposer.tsx`). Avoid permanent editor/reading modes or duplicated source cards when the live provisional mark already supplies context.

### Let the draft outlive its Reference view

[PR #121](https://github.com/brad-ross/placekeeper/pull/121), open as of 2026-09-18, extends frozen authoring to Reference Tabs. Switching tabs, hiding References, changing the dock, or closing the origin changes whether the passage is visible; none changes what Apply means. Retain the same composer and text node through those transitions. An inactive or unmounted origin is outside, not automatically invalid. Back to passage is the explicit way to reconstruct its view (`apps/web/src/review/authoring-session.ts`, `apps/web/src/review/use-authoring-session.ts`, `apps/web/src/app/ProductionReviewApp.tsx`).

A lifecycle-capable host admits an Interaction Hold before opening the editor. An active Reference edit therefore defers local PDF replacement until its interaction finishes; a replacement request does not itself invalidate the draft. If authority actually changes, or another view deletes the edited item, remove the stale provisional projection and block a new Apply. Reference editors retain copyable text and release their hold, whereas Main editors with an interaction release their hold and close. Legacy editors without an interaction retain invalid text. Keep these presentation policies separate from source authority (`apps/web/src/review/use-authoring-session.ts`, `beginAuthoring` and its invalidation layout effect).

Retaining text and releasing a hold are not the same as discarding a Protected Draft. If an edited item disappears within the current generation, Cancel must discard its protected draft before closing; otherwise queued typing can leave a recovery entry after explicit cancellation. If document authority changed, do not send a discard against the old authority. A failed current-generation discard retains the editor. Check authority before and after awaiting commands, and bind invalidation to the original session token (`apps/web/src/review/use-authoring-session.ts`, `dismissAuthoring`; `test/acceptance/reference-annotation-stale-commands.spec.ts`).

### Separate an uncertain terminal result from a new submission

After a finalization response is lost, the server may already have applied the annotation and published a successor generation. Ordinary invalid-draft checks cannot decide whether that operation completed. Retry the frozen terminal outcome, draft ID, and draft revision before checking whether a new submission is allowed; the retry must ignore later textarea changes. The button's disabled state must use the same precedence as the handler, or the correct retry code becomes unreachable (`apps/web/src/review/use-authoring-session.ts`, `authoringSaveDisposition`, `saveAuthoring`, and `finalizeProtectedAuthoring`; `apps/web/src/app/ReviewShell.tsx`).

Canonical state and viewer observation can advance separately. A same-session canonical successor can settle the original receipt even while the viewer-generation observer lags. For same-generation settlement, retain the receipt revision, source identity, and observer-generation checks. This recognizes a completed operation; it does not grant an old draft permission to mutate the successor (`apps/web/src/review/use-authoring-session.ts`, `canonicalStateForFinalizedInteraction`; `test/acceptance/automatic-pdf-refresh.spec.ts`).

### Close after the required persistence boundary

Canonical acceptance, terminal-receipt acknowledgement, and PDF durability are separate facts. The legacy command path can report `persistence-pending`; the interaction path must carry an explicit persistence requirement into receipt settlement. Production requires that tail for an active save destination when the session is neither export-only nor generated-output. Missing `persistedRevision` alone cannot establish the requirement, because some valid workflows do not save to that destination (`apps/web/src/app/ProductionReviewApp.tsx`, `interactionPersistenceRequired`).

When PDF persistence is required and canonical state accounts for an applied receipt, record its review revision with the authoring token and acknowledge the receipt independently. Keep the editor mounted, read-only, and protected against duplicate submission until persistence reaches that revision and source/edit-target authority remains valid. Discarded receipts do not wait for PDF persistence. Apply shows progress within the button; a failed PDF write uses the existing save-recovery UI rather than another annotation popup (`apps/web/src/review/use-authoring-session.ts`, `settleCanonicalAuthoring` and `authoringPersistenceCanClose`; `apps/web/src/review/CommentComposer.tsx`).

A failed PDF write does not undo acceptance of the annotation. Retry or a new destination must persist the accepted mutation rather than applying it again. Reconnect during this persistence wait retries receipt acknowledgement without reacquiring or reapplying the completed interaction. Closing the editor after acceptance is also different from discarding an unapplied draft. The [autosave architecture](../architecture-patterns/recoverable-editable-pdf-annotation-autosave.md) owns the underlying durability and recovery contract.

The discriminating regressions combine these boundaries: retain one editor across Reference switch/hide/close; defer replacement during its hold; fail PDF persistence after accepting exactly one annotation; retry without duplication; and close only after durability catches up. Separately lose the finalization response after publishing a successor, and delete an edit target while draft protection is queued, then Cancel and prove the protected draft is gone. [PR #121](https://github.com/brad-ross/placekeeper/pull/121) adds this live PDF refresh integration coverage for Chromium and WebKit; the PR remains open as of 2026-09-18 (`test/acceptance/reference-annotations.spec.ts`, `test/acceptance/reference-annotation-stale-commands.spec.ts`, `test/acceptance/automatic-pdf-refresh.spec.ts`).

### Reconcile host invalidations with their originating command

A host can emit a command's revision before returning its response. Rehydrating for both messages can replace the PDF and composer during an otherwise valid draft update. The runtime defers revision invalidations while commands are pending, retains the newest one, updates observed identity from the response, then releases only an invalidation not already represented by that identity. Release runs in `finally`, so failed commands cannot strand legitimate events; generation and freshness events do not enter this revision-only deferral (`apps/web/src/host/vscode-runtime.ts`).

Keep this causal reconciliation in the transport. Do not teach the shared composer to ignore host revisions. Likewise, disposed viewer adapters return unavailable snapshots so late layout work cannot read torn-down viewer state (`apps/web/src/pdf/viewer-framing-adapter.ts`).

A separate interaction boundary also survives the redesign: reverse-SyncTeX PDF gestures must release pointer capture before subsequent composer clicks. Otherwise a valid Cancel or Apply control can appear unresponsive despite correct draft state (`apps/web/src/pdf/PdfWorkspace.tsx`).

## Why This Matters

These failures share a mistaken ownership transfer: live selection replacing frozen source, keystrokes replacing stable geometry, conditional visibility replacing placement, a command notification replacing its response, or a completed PDF gesture retaining the next click. Each lifetime needs its own authority. An editor closing, an interaction ending, and a PDF save finishing likewise prove different things: none alone establishes that unfinished text was discarded or accepted text reached the destination. Collapsing these boundaries can orphan cancelled drafts, duplicate accepted annotations, or disable the only valid retry.

Placement is presentation, not semantic ownership. Keeping that boundary allows a local editor to follow a visible passage, remain usable after scrolling away, survive nested prerequisites, and commit exactly the original intended annotation. Retained workspace state provides continuity without requiring the obsolete edge layout.

## When to Apply

Use this pattern for anchored edits that benefit from live document exploration and may wait on asynchronous prerequisites. Identify immutable source authority, mutable text, provisional projection, placement, and restoration before implementation. Prefer simpler inline editing when the accepted object is already directly editable.

Test retained-state combinations: frozen nested anchors and multi-page projection (`apps/web/test/authoring-session.test.ts`), stable placement preferences (`apps/web/test/neutral-overlay-layout.test.ts`), first-page multiline visibility and offscreen recovery (`test/acceptance/production-flow.spec.ts`), unchanged preview publication while typing (`test/acceptance/review-workflow.spec.ts`), command-caused versus newer invalidations and command failure (`apps/web/test/host-runtime.test.ts`), and conflict retry retaining the composer (`test/acceptance/production-flow.spec.ts`). Geometry coverage should assert containment and passage visibility rather than obsolete desktop coordinates.

## Examples

A reviewer starts replacing text, scrolls to another page, and continues typing. The editor stays at its last usable clamped position with an original-page cue. Back to passage explicitly reveals the source; Apply still uses the original frozen selection.

A multiline highlight's first fragment leaves view while its last fragment remains visible. Recovery stays absent because rendered-passage visibility considers every fragment. Only when the whole rendered passage leaves the usable region does the return action appear.

A protected draft command emits revision 12 before returning revision 12. The runtime consumes the duplicate invalidation after the response. If revision 13 arrives instead, it remains actionable; stability does not justify suppressing a newer external change.

## Related

- [Atomic generation transitions](../architecture-patterns/atomic-generation-transitions-for-rebuilt-pdf-reviews.md) owns replacement admission and the separate lifetimes of holds, protected drafts, and receipts.
- [Temporal UI regression testing](../workflow-issues/prove-temporal-ui-stability-across-stateful-lifecycle-seams.md) explains how to test composed lifecycle transitions and intermediate frames.
- [Overlay framing](../architecture-patterns/adaptive-annotation-tray-framing.md) separates passive reachability from explicit navigation.
- [Full Annotation Reader](full-annotation-reader-preserves-tray-context.md) owns inspection identity and return-to-list restoration.
- [Host runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md) retain transport-specific authority outside shared review UI.
- [Selection snapshots](../ui-bugs/reject-stale-viewer-selection-snapshots.md) establish a temporally consistent anchor before authoring freezes it.
- [Annotation navigation history](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) defines the Meaningful Jump used by explicit passage recovery.
