# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## PDF review

### Review Item
A durable, user-authored proofread instruction associated with PDF geometry, such as a replacement, deletion, insertion, highlight, or page note.

Review Items are the canonical review state: viewer markings and delivery artifacts are projections of them rather than independent editable records.

### Owned Annotation
A viewer marking projected from a Review Item and identified by that item's canonical identity.

One Owned Annotation can appear as several visual segments; interactions treat those segments as one annotation and resolve back to the same Review Item.

### Existing PDF Annotation
A display-only annotation discovered in the source PDF, kept separate from Review Items so source-document viewer state cannot become editable review state.

### Annotation Tray
The nonmodal review surface that lists Review Items and Existing PDF Annotations while leaving the PDF available for reading and navigation.

Its presentation may change with available reading space, but disclosure changes do not replace the underlying viewer or discard review state.

## Viewer framing

### Viewer Runway
Temporary scroll extent added beyond viewer content so an overlaid review surface does not make covered document regions unreachable.

Runway expands reachability without participating in page layout and is removed when the overlay closes or the viewer is disposed.

### Framing Session
The interval during which an open review surface may automatically reveal document content while tracking which movement belongs to the interface and which belongs to the user.

Automatic movement is reversible per axis; deliberate user navigation takes ownership of the affected axis and supersedes stale automatic work.

## Visual language

### Warm Neutral
The review session's light-theme visual language: warm gray and ivory environmental surfaces, soft borders and generous radii, neutral high-contrast routine chrome, and color reserved for selection, focus, annotation meaning, success, warning, and danger.

Warm Neutral changes presentation only; reading-first behavior and adaptive Annotation Tray framing remain governed by their product contracts.

## Reference navigation

### Main Reading Thread
The primary PDF view and its current reading location.

In-body reference lookups do not move the Main Reading Thread; embedded-outline navigation, explicit promotion from a Reference Tab, and ordinary direct reading actions may move it.

### Reference Tab
A temporary, independently scrollable and zoomable view of one author-encoded destination in the current PDF.

One live Reference Tab exists per target. Hiding the workspace preserves its tabs, while promotion to the Main Reading Thread consumes the promoted tab.

### Meaningful Jump
An explicit destination change in the Main Reading Thread that enters PDF Back and Forward history, such as embedded-outline navigation or promotion from a Reference Tab.

Ordinary scrolling, sequential page turns, and zoom changes are not Meaningful Jumps.

## PDF search

### Search Result
A page-positioned occurrence derived from reliable searchable text in the current source PDF.

Activating its primary row creates a Meaningful Jump in the Main Reading Thread, while its References action opens the same destination without moving the Main Reading Thread.

## Relationships

A Review Item projects to an Owned Annotation. Existing PDF Annotations remain a separate read-only population. The Annotation Tray presents both populations, while a Framing Session may use Viewer Runway to keep the relevant PDF content reachable.
