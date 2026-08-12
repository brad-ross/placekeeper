---
title: Outline-aware annotation workspace presentation
date: 2026-08-11
category: design-patterns
module: PDF review workspace presentation
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - A document-dependent workspace mode may be definitively unavailable
  - Annotation metadata is derived from optional document structure
  - A responsive tab strip changes its visible mode count at runtime
  - Owned and external annotations share one browsing surface
related_components:
  - ReviewShell
  - OutlineAnnotationsWorkspace
  - ReferenceWorkspace
  - annotation outline context
tags:
  - pdf-review
  - annotation-workspace
  - document-outline
  - progressive-disclosure
  - responsive-tabs
  - webkit
  - accessible-labeling
---

# Outline-aware annotation workspace presentation

## Context

The annotation workspace has three pieces of document-dependent presentation: an Outline mode, outline-derived subsection labels on annotation rows, and a References mode that may join the same selector. Treating those pieces as a fixed two- or three-column interface produces misleading empty states and fragile sizing. A PDF with a confirmed empty outline should not expose an inert Outline tab or fabricated subsection context, while an outline that is still loading—or whose discovery result belongs to an older document generation—must not be treated as absent.

PR #11, merged on 2026-08-11, made the workspace derive its visible modes and annotation metadata from the current outline discovery state. It also aligned the two annotation populations under one visual hierarchy: user-owned Review Items remain “Annotations,” while PDF-sourced, non-editable marks are presented as “External Annotations (read only).” The latter is a presentation label for the existing **Existing PDF Annotation** domain concept, not a new entity.

## Guidance

### Model absence as a confirmed capability state

Keep `loading`, `loaded-empty`, `loaded-tree`, and `unavailable` distinct (`apps/web/src/pdf/pdf-outline.ts:22-30`). Hide outline-dependent UI only for `loaded-empty`, which is produced when bookmark discovery succeeds with no items (`apps/web/src/pdf/pdf-outline.ts:69-83`). Loading means the capability is not known yet; unavailable means discovery failed rather than proving absence.

`OutlineAnnotationsWorkspace` projects that state into its actual mode list. Every state except `loaded-empty` keeps Outline available; a confirmed empty result switches from `['outline', 'annotations']` to `['annotations']` and coerces an obsolete Outline selection to Annotations (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx:16-17`, `apps/web/src/review/OutlineAnnotationsWorkspace.tsx:63-67`). The Outline panel follows the same predicate, so the tablist and tabpanel cannot disagree (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx:153-174`).

Generation-gate before applying that policy. `ReviewShell` normalizes a missing or stale discovery result to `loading`, then derives both outline absence and annotation-label visibility from the normalized result (`apps/web/src/app/ReviewShell.tsx:285-305`). This prevents an asynchronous result for the previous document from hiding controls for the document now mounted in the Main Reading Thread.

Use the same gate for derived metadata. The shell passes owned and external subsection labels only for a current `loaded-tree` result (`apps/web/src/app/ReviewShell.tsx:1094-1099`, `apps/web/src/app/ReviewShell.tsx:1146-1169`). The derivation layer independently requires both `loaded-tree` and a matching generation before resolving any row (`apps/web/src/review/annotation-outline-context.ts:62-74`). Loading, confirmed absence, discovery failure, stale generations, unsafe targets, and invalid geometry therefore omit the subsection and its separator rather than guessing.

### Derive selector columns from the visible mode list

The selector is a projection of available modes, not a fixed layout. In a tools-only tray, an outline-free document has one mode. When References shares the workspace, the shell supplies `['annotations', 'references']` without an outline and `['outline', 'annotations', 'references']` with one (`apps/web/src/app/ReviewShell.tsx:1037-1042`).

Give the browser an explicit track list derived from that array:

```tsx
style={{ gridTemplateColumns: `repeat(${modes.length}, minmax(0, 1fr))` }}
```

Both workspace renderers use this contract (`apps/web/src/review/OutlineAnnotationsWorkspace.tsx:120-128`, `apps/web/src/review/ReferenceWorkspace.tsx:267-278`). CSS owns the tab surface, gap, typography, and selected-state treatment (`apps/web/src/app/review-layout-annotations.css:262-281`, `apps/web/src/app/review-layout-annotations.css:347-375`); the renderer owns the number of tracks because it owns the mode array.

Do not rely on implicit grid columns here. During implementation, a lone Annotations tab appeared full-width in Chromium but occupied only half the selector in WebKit. Explicit `repeat(count, minmax(0, 1fr))` makes the invariant engine-independent: one visible mode fills the strip, two divide it equally, and three divide it into thirds.

### Present annotation populations with one hierarchy

Owned and external annotations are peer sections in one tray, so their headings should share typography and spacing. The stylesheet applies one heading rule and one header-spacing rule to both sections (`apps/web/src/app/review-layout-annotations.css:808-815`, `apps/web/src/app/review-layout-annotations.css:1060-1063`). The owned section retains its count beside “Annotations” (`apps/web/src/review/AnnotationList.tsx:98-102`); the PDF-sourced section uses “External Annotations (read only)” as both its visible heading and section label (`apps/web/src/app/ReviewShell.tsx:1128-1131`). This communicates origin and capability without redundant overlines or a separate read-only pill.

When an outline tree exists, compact row metadata renders kind, page number, then subsection, separated by centered dots. The visible component omits the word “Page,” keeps the full wording in the accessible label, and conditionally adds a bounded, ellipsized subsection (`apps/web/src/review/AnnotationMetadata.tsx:7-29`, `apps/web/src/app/review-layout-annotations.css:944-988`). Omitting `sectionLabel` naturally removes both the second separator and the subsection.

### Test state branches with sensitive fixtures

Fail-closed tests are easy to make vacuous. A loading or stale-generation test with no annotations would pass even if label suppression were broken. Start from an otherwise valid annotation, page geometry, and resolvable outline destination, then change exactly one condition: status, document generation, target safety, or geometry. This proves the tested branch—not the empty fixture—caused the label to disappear.

Test dynamic mode removal as a navigation change, not only a render change. Cover selected-mode fallback, remembered focus, and a References tab that already exists in the background. The installed acceptance flow verifies the missing Outline tab and panel, selected Annotations mode, external-section heading, absent subsection metadata, focus restoration, and stable Main Reading Thread mount (`test/acceptance/production-flow.spec.ts:1453-1491`).

For selector geometry, count the modes that are actually visible and compare each tab with `bar width / visible mode count`. Do not infer the expected count from viewport width alone: in a narrow unified workspace, References may already have joined the tray. The focused assertion permits the one- or two-mode composition produced by the settled layout, then verifies proportional width (`test/acceptance/production-flow.spec.ts:1469-1479`). Run this layout-sensitive flow in both Chromium and WebKit.

## Why This Matters

The interface follows the document instead of exposing unavailable product structure. A confirmed outline-free PDF gets a simpler workspace, while temporary loading and failure states remain honest. The same source-of-truth rule prevents annotation rows from showing subsection names that belong to another document.

Explicit mode-count sizing also makes responsive composition robust. A lone Annotations mode fills the selector; when References moves into the tray, both modes share it; when an outline exists, the selector can expand to three equal segments. No mode has a hard-coded fraction.

Finally, consistent section hierarchy makes owned and external annotations feel related without blurring their distinct capabilities. The Main Reading Thread, Reference Tabs, Review Items, and Existing PDF Annotations keep their established domain meanings; this pattern changes only how the current document’s capabilities are projected into the tray.

## When to Apply

- A tab or workspace mode is meaningful only after asynchronous capability discovery.
- Derived labels or grouping metadata depend on both document identity and an optional document structure.
- Responsive composition moves modes between surfaces or changes the visible mode count.
- A tray presents editable application-owned records alongside read-only source-document records.
- Browser engines must agree on equal-width dynamic tab geometry.

## Examples

### Outline-free document

For a current `loaded-empty` result, render Annotations as the only tools mode, select it even if Outline was previously remembered, omit the Outline panel, and suppress subsection labels. If References moves into the shared tray, render two equal-width modes: Annotations and References.

### Outline available

For a current `loaded-tree`, retain Outline and allow both owned and external annotations to show their containing subsection. External rows remain read-only; adding outline context does not change their ownership or interaction semantics.

### Outline not yet known

For `loading`, retain the Outline mode and show its loading state, but omit annotation subsection labels. For `unavailable`, retain the Outline mode so the failure remains visible and likewise omit derived labels. Neither state is evidence that the document has no outline.

### Cross-browser geometry

If only Annotations is visible, its tab width should approximate the selector’s full inner width. If References joins, each tab should approximate half. Assert that proportional relationship after responsive layout settles rather than hard-coding a mode count from the viewport.

## Related

- [Adaptive annotation tray framing without resizing the PDF viewer](../architecture-patterns/adaptive-annotation-tray-framing.md)
- [PR #11: compact outline and annotation context](https://github.com/brad-ross/pdf-markup/pull/11)
