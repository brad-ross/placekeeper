# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Product identity

### Placekeeper
The focused everyday PDF reader and annotator that preserves a reader's place while annotations, search, and Reference Tabs support nonlinear reading.

Placekeeper emphasizes preserving the Main Reading Thread while annotations, search, and Reference Tabs support nonlinear reading.

### Placekeeper Link
The canonical, human-readable `placekeeper://` address for a local PDF, consisting of its absolute filesystem path and an optional safe fragment for a page, portable Review Item, or normalized author-encoded same-document PDF destination.

A Placekeeper Link reopens the current file at that path and carries no live browser credential, session identity, or Codex task authority.

### Loopback Review URL
The process-scoped HTTP projection that serves one active Placekeeper review through a local browser interface.

While its owning daemon and review session remain live, a Loopback Review URL may resume only its exact in-memory projection and scoped authority. After daemon replacement, the same stable-origin route may offer an explicit Placekeeper Link reopen for the encoded path and location. The stale route itself never restores prior browser credentials or Codex task authority; any persisted session-state recovery occurs separately through the normal durable-draft flow.

After daemon replacement, a separate Restart Reconnect Ticket may let the freshly authenticated successor view regain the exact owning Codex task association. The URL remains descriptive: the ticket requires independent browser-side continuity and task-side prompt proofs, and durable review-state recovery remains a separate flow.

### Restart Reconnect Ticket
A short-lived, single-use correlation record that lets a freshly reopened successor review regain Codex scope only after browser continuity and the exact owning task's next prompt independently prove their halves of the relationship.

It transfers no old browser credential, session identity, task identity, or viewer state. Missing, mismatched, expired, consumed, or revoked proof leaves the successor review browser-scoped.

### Clean-break Identity Migration
A named process that replaces an application's human-facing and machine-facing identity as one indivisible contract while intentionally providing no compatibility path for the retired identity.

Completion requires both exclusivity in source and built artifacts and separate removal of active installed state; a clean repository alone does not prove a clean machine.

## PDF review

### Review Item
A durable, user-authored proofread instruction associated with PDF geometry, such as a replacement, deletion, insertion, highlight, or page note.

Review Items are the canonical review state: viewer markings and delivery artifacts are projections of them rather than independent editable records.

### Owned Annotation
A viewer marking projected from a Review Item and identified by that item's canonical identity.

One Owned Annotation can appear as several visual segments; interactions treat those segments as one annotation and resolve back to the same Review Item.

### Existing PDF Annotation
A reviewer-relevant, display-only annotation discovered in the source PDF, kept separate from Review Items so source-document viewer state cannot become editable review state.

Navigational PDF Annotations remain part of the document but are excluded from this reviewer-facing population.

### Navigational PDF Annotation
A source-PDF annotation whose purpose is document navigation rather than review feedback, such as a link destination affordance.

It remains available for navigation and preservation but does not appear as an Existing PDF Annotation or contribute to reviewer-facing annotation warnings.

### Portable Annotation Identity
App-authored identity and semantics stored inside a standards-visible PDF annotation so the application can reconstruct its Review Item after the PDF is closed, renamed, moved, or transferred to another device.

Portable Annotation Identity makes app-created annotations editable across sessions without making private recovery data part of the shared document contract.

Identity is ownership and editability evidence, not the annotation's visual appearance. External readability comes from the annotation's standard subtype, crop-relative geometry, and normal appearance.

### Crop-relative Geometry
The coordinate contract for Review Item rectangles: positions are measured from the visible page canvas inside the page crop boundary, before viewer rotation or scale.

Rotation and scale are presentation transforms. Persistent annotations and viewer projections do not add the crop origin; legacy offset coordinates are migrated once before use.

### Save Destination
The PDF selected to receive automatic annotation changes, either the safely validated opened document or a distinct copy.

Changing the Save Destination leaves the former PDF at its last successfully saved state and sends the complete current state plus subsequent changes to the new target.

Each establishment or relocation advances the destination's generation, so work completed for an older destination cannot update the new target or its save status.

### Save Sync
The durable comparison between the latest desired Review Items and the state last verified in the Save Destination.

Save Sync is clean only when the saved revision and semantic digest match the desired state; an older successful write remains saving, while a failed current-generation write becomes not saved without discarding Protected Recovery.

### Protected Recovery
Private local state that safeguards accepted annotation changes until the Save Destination contains the same current state.

Protected Recovery supports crash and write-failure recovery, but it is not the long-term source of portable annotation editability.

### Annotation Tray
The nonmodal review surface that lists Review Items and Existing PDF Annotations while leaving the PDF available for reading and navigation.

Its presentation may change with available reading space, but disclosure changes do not replace the underlying viewer or discard review state. Its navigation exposes only destinations supported by current document or session state—including informative loading, failure, and pending surfaces—while preserving Search as a safe fallback.

### Live PDF Context
The task-scoped, prompt-refreshed view of the PDF, Review Items, Existing PDF Annotations, and Save Sync made available to the agent task bound to the document's review session.

Live PDF Context provides complete semantic access to Review Items plus bounded, on-demand document and annotation evidence without requiring every page to be injected into every prompt, and it ends when the bound task or placekeeper session ends.

### Quiescent Review Session
A review session whose last authenticated page has disconnected and whose bounded reconnect grace lease has expired.

A Quiescent Review Session may retire only after its accepted recovery, PDF saving, picker, and agent work has drained; unsynchronized Protected Recovery remains available after retirement. One quiescent review does not make the shared daemon idle while another review or task remains active.

### Manual Precedence
The reconciliation rule that preserves a person's source edit or annotation over conflicting agent work while collapsing semantically equivalent changes into one result.

Manual Precedence applies to work created after the agent captures an execution baseline as well as work that existed before the request.

### Outline Discovery
The document-scoped capability result that distinguishes confirmed absence of a PDF outline from an outline still loading, available outline structure, or discovery failure.

Only confirmed absence removes outline-dependent modes and metadata; stale results from a previously mounted document are treated as unknown until the current document resolves.

## Viewer framing

### Committed Zoom
The provider-owned numeric PDF scale used to publish the viewer's zoom state.

For acceptance testing, transient gesture presentation is treated as non-authoritative; coordinate-based actions wait for Committed Zoom and its rendered layout before treating new geometry as settled.

### Viewer Runway
Temporary scroll extent added beyond viewer content so an overlaid review surface does not make covered document regions unreachable.

Runway expands reachability without participating in page layout and is removed when the overlay closes or the viewer is disposed. While an animated overlay is logically open, runway commits the overlay's resting layout extent and ignores transformed intermediate frames.

### Framing Session
The interval during which an open review surface may automatically reveal document content while tracking which movement belongs to the interface and which belongs to the user.

Automatic movement is reversible per axis; deliberate user navigation takes ownership of the affected axis and supersedes stale automatic work. When a Reference Tab is promoted to Main during an open session, its verified destination becomes the new baseline before subsequent workspace reflow.

## Visual language

### Warm Neutral
The review session's light-theme visual language: warm gray and ivory environmental surfaces, soft borders and generous radii, neutral high-contrast routine chrome, and color reserved for selection, focus, annotation meaning, success, warning, and danger.

Warm Neutral changes presentation only; reading-first behavior and adaptive Annotation Tray framing remain governed by their product contracts.

### Compact Editorial
The Warm Neutral task-surface grammar for Save Destination and review authoring workflows: a direct task-title header, a task-specific body, a restrained action region, and compact icon-plus-label actions.

Supporting copy appears only when it adds context. Creation comments use Save, edits use Apply, and optional-comment workflows distinguish cancelling from keeping an annotation without text. Compact Editorial governs presentation and action language; each task surface's product contract governs lifecycle, state, and accessibility behavior.

### Contextual Annotation Composer
The nonmodal Compact Editorial authoring surface for replacement, insertion, highlight comments, Page Notes, and mutable Review Item edits.

On wide surfaces it temporarily occupies the review edge while leaving the live PDF available. On narrow surfaces it becomes a contained bottom surface. Its draft remains bound to the original anchor during document navigation, and an explicit return recovers that anchor without overriding deliberate reading position or displaced Annotation Tray state.

## Reference navigation

### Main Reading Thread
The primary PDF view and its current reading location.

In-body reference lookups do not move the Main Reading Thread; embedded-outline navigation, explicit promotion from a Reference Tab, and ordinary direct reading actions may move it.

### Reference Tab
A temporary, independently scrollable and zoomable view of one author-encoded destination in the current PDF.

One live Reference Tab exists per target. Hiding the workspace preserves its tabs, while promotion to the Main Reading Thread consumes the promoted tab.

A Reference Tab retains both its immutable author-encoded origin and its last settled view. Activation prefers the settled view, but may reconstruct the origin when changed viewer geometry makes that view unusable. Returning to the origin updates only the Reference Tab's settled view and does not move the Main Reading Thread.

### Reference Fit Width
The framing policy for an author-encoded Reference destination that scales its page to the usable Reference viewer width instead of fitting the whole page vertically.

Reference Fit Width is used for a destination's initial opening and to reconstruct a Reference Tab when its saved settled view cannot survive a layout change. Author-provided vertical positioning is preserved only when it carries meaningful destination intent.

### Meaningful Jump
An explicit destination change in the Main Reading Thread that enters PDF Back and Forward history, such as activating an Annotation Tray row, embedded-outline navigation, or promotion from a Reference Tab.

Ordinary scrolling, sequential page turns, and zoom changes are not Meaningful Jumps. A jump's identity may be semantic rather than purely geometric: distinct Search Results can remain separate history destinations even when viewer constraints settle them at the same physical location, while an ordinary jump that settles back at its origin adds no history stop.

## PDF search

### Search Result
A page-positioned occurrence derived from reliable searchable text in the current source PDF.

Activating its primary row creates a Meaningful Jump in the Main Reading Thread, while its References action opens the same destination without moving the Main Reading Thread.

## Relationships

A Review Item projects to an Owned Annotation using Crop-relative Geometry and may carry Portable Annotation Identity in the saved PDF. Existing PDF Annotations remain a separate read-only population, while Navigational PDF Annotations stay outside that reviewer-facing population. The Annotation Tray presents Review Items and Existing PDF Annotations, while a Framing Session may use Viewer Runway to keep the relevant PDF content reachable. Protected Recovery covers accepted changes until Save Sync proves that the Save Destination has caught up.
