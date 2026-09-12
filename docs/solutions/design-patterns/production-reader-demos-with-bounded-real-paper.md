---
title: Build focused landing demos from the production reader and a bounded real paper
date: "2026-09-12"
last_updated: "2026-09-12"
category: design-patterns
module: Landing page interactive reader demos
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Changing interactive feature demos without diverging from the actual reader"
  - "Reducing demo PDF bytes while preserving original page labels and reference navigation"
tags: [landing-page, demo, fit-width, references, annotations, pdf-excerpt]
---

# Build focused landing demos from the production reader and a bounded real paper

## Context

Hand-built app illustrations were rejected because they did not match the real interface. Replacing them with a production reader solved visual fidelity but exposed lifecycle problems: feature changes refreshed the PDF, annotation popups survived the hidden tray, reference tabs appeared hovered without a pointer, and a scroll-range correction undid Fit Width. These failures came from combining otherwise reasonable behaviors without assigning clear ownership.

The resulting guidance is to keep one real reader alive, restrict feature availability at explicit boundaries, and preserve the reader's own navigation/geometry operations. The September 2026 local branch contains these changes; this document does not assert an upstream merge.

## Guidance

### Keep a single reader mounted across feature switches

`apps/web/src/landing/ProductShowcase.tsx` keeps the iframe source fixed at `?demo=read` and changes `data-demo-mode`. `apps/web/src/landing/demo-entry.tsx` observes that attribute and drives `WorkspacePresentation` and `WorkspaceModeAvailability` around the production app. Do not key/remount the iframe or navigate it for every selector click. Remounting loses the review and makes every switch look like a page refresh rather than the workspace animation users will encounter in the app.

The sample reference is opened after initial readiness and tracked once by `sampleReferenceOpened` in `apps/web/src/app/ProductionReviewApp.tsx:589`; switching modes should not create a fresh sample reference every time. This preserves one accumulated review, not three independent sessions.

Use the production workspace selector styling for the external feature selector, with all three labels visible and the selector centered. Restrict non-focal actions without making the entire toolbar visually disabled. The user wanted normal hover affordances for non-clickable demo controls, no redundant tooltips on labeled feature buttons, and no dark hover change on an already selected card/tab. Treat hover, active selection, keyboard focus, and action eligibility as distinct states.

The current demo modes are Read with focus, Follow a reference, and Make comments. The reference presentation opens Appendix A on original page 31, bottom dock, with a 260-pixel requested height; these are staging choices in `demo-entry.tsx`, not general reader defaults. Main preview pages are 14–16. The explanatory text must describe the actual staged links rather than an earlier synthetic Table 1 fixture.

### Treat annotation visibility as a whole feature, not just a tray

The user's accepted behavior is: seeded highlights/deletions/replacements and newly authored annotations appear in Make comments; changing modes hides them without deleting them. The selection popup, insertion caret, expanded annotation card, and page overlay belong to that same mode visibility boundary. Hiding only the annotation tray leaves floating artifacts on the document. Reentering Make comments should allow selection-based authoring, including an existing still-valid selection.

`apps/web/src/app/ProductionReviewApp.tsx` derives authoring eligibility from `WorkspaceModeAvailability`. Long-lived viewer subscriptions read current eligibility from a ref, preventing stale permission closures when the mounted demo changes mode. The render projection receives an empty item list outside authoring while canonical items are retained; do not clear review state as a hiding mechanism. Selection/page-note popovers and annotation peeks have their own visibility gates in `apps/web/src/app/ReviewShell.tsx`. Keep this eligibility connected to actual interaction paths; disabling pointer events on the entire reader to hide annotations also disables selection and insertion authoring. Exercise selection, adding a comment, insertion, and mode exit/reentry, not only seeded-overlay rendering.

When a reference opens automatically, do not synthesize hover or leave a programmatically focused control styled as hovered. The observed symptom was a reference tab initially showing close/open-in-main actions and a tooltip, then returning to its page number. A delayed screenshot misses that bug. Check the first opening animation with the pointer outside the tray and compare it with genuine mouseover. Preserve real keyboard navigation while separating programmatic activation from pointer-only affordances. `apps/web/src/review/ReferenceWorkspace.tsx` retains intentional tab focus, suppresses focus-triggered reference tooltips, and avoids intermediate loading-header focus. The demo-specific endcap rules in `apps/web/src/static-entry.css` retain page numbers when the pointer is absent. Do not generalize this into disabling focus throughout the production app.

### Let the production shell own Fit Width

`apps/web/src/app/ReviewShell.tsx:1148` centralizes the command: it marks framing intent, waits for settled workspace geometry, and invokes the viewer's fit operation. The initial fit request and the toolbar button call that same operation. The demo's externally driven workspace changes also consult current fit state there. Do not implement a separate demo zoom formula or set a fixed 100% after a layout change.

Loading should reveal the first correctly fitted view, not paint at 100% and visibly jump to the fitted scale. `apps/web/src/app/ProductionReviewApp.tsx` exposes the initial-view-ready boundary. Keep hidden initialization finite and yield permanently to normal viewer navigation once ready. Opening the side tray while fitted should refit for its available geometry; opening a tray while manually zoomed should not unconditionally reset the user's scale.

The broader fit-eligibility and geometry policy is documented in [adaptive annotation tray framing](../architecture-patterns/adaptive-annotation-tray-framing.md); the demo must not redefine it.

A key failure was the **preview scroll guard**, not Fit Width itself. A generic scroll-event handler saw Fit Width's programmatic anchor write as an out-of-range user scroll, corrected it, and invalidated the operation; the viewer briefly fitted then rolled back. `apps/web/src/pdf/MainDocumentPreviewBoundary.tsx` now bounds upward wheel/key/touch input before it moves, handles native scrollbar input separately, and keeps initialization correction behind readiness. Do not reintroduce unconditional post-scroll snap-back to page 14. Test Fit Width while zoomed in with the workspace open as well as on initial load.

### Separate committed content, original numbering, and visible scroll range

Simply retaining pages 14–16 breaks useful references. Shipping all 100 pages wastes bytes and hides the actual dependency set. The reproducible compromise is in `scripts/build-demo-excerpt.py`:

- Input must be the 100-page arXiv v3 paper. The script checks page count only, not version identity or a checksum; verify the authorized source separately.
- Retained ranges are 6–9, 12–19, 25–33, 46–52, and 75–79: 33 pages total.
- The range list is manually specified for this paper, not automatically discovered from section semantics. It retains sections corresponding to direct links from pages 14–16, including shared boundary pages. Do not recursively expand links from all retained appendix/bibliography pages back into the whole paper.
- Rebuild link destinations against retained page objects. Drop out-of-excerpt destinations on supporting pages; missing direct targets on pages 14–16 fail the script.
- Write the compact PDF and `demo-page-map.json` together.

`apps/web/src/landing/create-demo-document.ts` checks the excerpt page count against map length (not map ordering, uniqueness, or source identity) and inserts blank omitted pages **in memory** so retained page objects occupy their original indices. Thus the reader can display page 14 / 100 and retain destination identity without committing omitted paper content. The blanks are not missing-content claims about the source paper. Keep the filtered outline and bounded main preview from inviting users into placeholders.

The main-reader restriction is separate from reference viewers. `MainDocumentPreviewBoundary.tsx` limits the main scroller; reference destinations outside 14–16 remain useful. Test the upper boundary, lower boundary, original page labels, outline destinations, Appendix A, zoom, and programmatic navigation independently. A correct file size does not establish a usable excerpt.

### Preserve the visual decisions that motivated the implementation

The user repeatedly removed redundant landing prose. Preserve the simple hierarchy: large Placekeeper brand and short tagline plus a prominent Try box; feature selector and working demo with readable explanation; secondary features; actual app surfaces; concise Install and Try invitations. Avoid reintroducing preheaders, FAQ, reset-demo controls, sample-document footnotes, or duplicate benefit slogans.

Current secondary feature choices are symbol search, horizontal scroll lock, document history, and portable annotations. They supplement rather than restate the three main demos. Use “document” in general marketing copy, but keep the explicit file affordances **Upload PDF** and **or drop a PDF here**. Give the demo/text and surface-list/image columns enough separation. At narrow widths, put the horizontal surface cards above the image; shrink the hero brand to fit rather than letting it overflow. These are user-established design constraints from the session, not universal CSS rules.

## Why This Matters

A landing demo is a constrained product session, not a separately implemented reader. Keeping shared state and geometry ownership avoids demo-only bugs and makes future interface changes appear naturally. The PDF dependency closure and in-memory page map preserve a credible real-paper example without an oversized repository fixture.

## When to Apply

Apply when changing the demo paper, increasing demo UI scale, modifying workspace transitions, or updating annotation authoring. Keep the exact staging constants local to the demo and the actual behavior in the production components. Do not weaken normal app navigation to accommodate the marketing preview.

## Examples

Regeneration template (requires the script's documented pypdf version and an authorized full v3 PDF):

```sh
python3 scripts/build-demo-excerpt.py /path/to/2312.07520v3.pdf
```

The input path is illustrative, not a checked-in fixture. Review both generated assets and the legal attribution recorded in `apps/web/src/landing/assets/README.md`. Rebuild static output before judging the served page.

A compact regression sequence is: initial Read view → zoom in → Fit Width → Make comments → add an annotation and leave a selection → Read → Make comments → Follow a reference → open another reference with pointer away → scroll upward to the preview boundary → Fit Width with tray open. Observe transitions and final states; a final still image cannot prove absence of flashing.

## Related

- [Production host/runtime boundaries](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [PDF navigation rollback](../ui-bugs/pdf-navigation-rollback-from-predicted-scroll-geometry.md)
- [Initial virtualized PDF calibration](../ui-bugs/calibrate-virtualized-pdf-navigation-before-first-paint.md)
- [Real surface screenshot workflow](../workflow-issues/refresh-real-app-surface-screenshots.md)
