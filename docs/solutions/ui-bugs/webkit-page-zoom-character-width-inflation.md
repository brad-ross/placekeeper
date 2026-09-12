---
title: "Diagnose character-width inflation under native WebKit page zoom"
date: "2026-09-11"
last_updated: "2026-09-11"
category: "ui-bugs"
module: "PDF toolbar and native app zoom"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "low"
symptoms:
  - "Page-number and PDF-zoom inputs widen disproportionately as native app zoom increases."
root_cause: "logic_error"
resolution_type: "code_fix"
tags: ["macos", "webkit", "app-zoom", "css", "toolbar"]
---

# Diagnose character-width inflation under native WebKit page zoom

## Problem

The compact toolbar inputs should grow with their text. Before the fix, the PDF-zoom input used `3ch`, while the page-number input used `28px`. Both changed to `2em`; the character-unit diagnosis below applies specifically to the zoom input. During native testing for [PR #103](https://github.com/brad-ross/placekeeper/pull/103), character-relative sizing instead made them grow disproportionately. The fix is pending merge in that PR as of 2026-09-11.

## Root cause and diagnostic evidence

The implementation session recorded a reduced native WKWebView experiment that compared two borderless, unpadded inputs with the same `13px` system font, one sized to `3ch` and the other to `2em`. Changing `pageZoom` from 1 to 2 increased the character-sized input's measured CSS width from approximately 24.3 to 48.1 pixels even while computed font size remained 13 pixels. Native page scaling then enlarged the rendered control again. This isolated the extra growth from flex layout, toolbar content, and PDF zoom.

The `2em` control remained 26 CSS pixels wide at page scales 0.8, 1, 1.25, and 2. At the diagnostic scale 0.5, the observed computed font size became 18 pixels and its width became 36 pixels, still tracking the actual font size. That last scale was an experimental control, not a supported app setting. These are observations from the tested native WebKit environment, not a claim about every browser or WebKit release.

## Reproducing the diagnostic comparison

Load this content in a native WKWebView:

```html
<style>
input { font: 400 13px/20px system-ui; padding: 0; border: 0; }
.ch { width: 3ch; }
.em { width: 2em; }
</style>
<input class="ch" value="100"><input class="em" value="1">
```

After navigation, set `WKWebView.pageZoom` to each comparison scale. Record `getBoundingClientRect().width`, `getComputedStyle(input).fontSize`, and `getComputedStyle(input).width` after layout settles. The original probe used a 1200-by-800 web view and a 100-millisecond delay; that delay describes the experiment, not a general guarantee of layout readiness. Record the OS/WebKit version when repeating it, since the original evidence did not retain one.

The reduced page removes the production flex container, toolbar contents, and PDF viewer from the comparison. Stable font size with increasing CSS width distinguishes extra unit growth from the expected enlargement of the whole web surface. This documentation review inspected the retained probe source but did not rerun the native measurements.

## Solution

The input rules in `apps/web/src/app/neutral-controls.css` use font-relative widths:

```css
.review-chrome__page-input { width: 2em; text-align: center; }
.review-chrome__zoom-input { width: 2em; text-align: right; }
```

The source comment records the unit choice; the native comparison above records why it was justified. Avoid compensating with the reciprocal app scale: that would couple a shared control to a host setting and could suppress legitimate font growth.

## Prevention

When a control grows faster than its text, compare computed font size and bounding width in CSS pixels before changing container constraints. Use a minimal native WKWebView with the real `pageZoom` property to separate unit behavior from layout. Browser CSS zoom emulation can test shared layout but does not establish how native page zoom measures font-relative units.

## Related guidance

- [Measured responsive toolbar](../design-patterns/measured-one-row-responsive-review-toolbar.md) covers fitting complete control groups after fonts settle; it addresses container presentation rather than this unit measurement.
- [Native WebKit first-paint diagnosis](native-webkit-workspace-first-paint-redundant-clipping.md) explains why browser geometry and native visual evidence serve different purposes.
