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

### Portable Annotation Identity
App-authored identity and semantics stored inside a standards-visible PDF annotation so the application can reconstruct its Review Item after the PDF is closed, renamed, moved, or transferred to another device.

Portable Annotation Identity makes app-created annotations editable across sessions without making private recovery data part of the shared document contract.

### Save Destination
The PDF selected to receive automatic annotation changes, either the safely validated opened document or a distinct copy.

Changing the Save Destination leaves the former PDF at its last successfully saved state and sends the complete current state plus subsequent changes to the new target.

### Protected Recovery
Private local state that safeguards accepted annotation changes until the Save Destination contains the same current state.

Protected Recovery supports crash and write-failure recovery, but it is not the long-term source of portable annotation editability.

### Annotation Tray
The nonmodal review surface that lists Review Items and Existing PDF Annotations while leaving the PDF available for reading and navigation.

Its presentation may change with available reading space, but disclosure changes do not replace the underlying viewer or discard review state.

### Outline Discovery
The document-scoped capability result that distinguishes confirmed absence of a PDF outline from an outline still loading, available outline structure, or discovery failure.

Only confirmed absence removes outline-dependent modes and metadata; stale results from a previously mounted document are treated as unknown until the current document resolves.

## Viewer framing

### Committed Zoom
The provider-owned numeric PDF scale used to publish the viewer's zoom state.

For acceptance testing, transient gesture presentation is treated as non-authoritative; coordinate-based actions wait for Committed Zoom and its rendered layout before treating new geometry as settled.

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

A Reference Tab retains both its durable author-encoded destination and its last settled view. Activation prefers the settled view, but may reconstruct the destination when changed viewer geometry makes that view unusable.

### Reference Fit Width
The framing policy for an author-encoded Reference destination that scales its page to the usable Reference viewer width instead of fitting the whole page vertically.

Reference Fit Width is used for a destination's initial opening and to reconstruct a Reference Tab when its saved settled view cannot survive a layout change. Author-provided vertical positioning is preserved only when it carries meaningful destination intent.

### Meaningful Jump
An explicit destination change in the Main Reading Thread that enters PDF Back and Forward history, such as embedded-outline navigation or promotion from a Reference Tab.

Ordinary scrolling, sequential page turns, and zoom changes are not Meaningful Jumps.

## Relationships

A Review Item projects to an Owned Annotation and may carry Portable Annotation Identity in the saved PDF. Existing PDF Annotations remain a separate read-only population. The Annotation Tray presents both populations, while a Framing Session may use Viewer Runway to keep the relevant PDF content reachable. Protected Recovery covers accepted changes until the Save Destination catches up.
