# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Naming

People see **Document** for an open PDF and its annotations, **Annotations** for what they add to it, and **Annotated Document** for an exported copy. In code the same ideas are `DocumentSession`, `Annotation`, `AnnotationRevision`, and `annotated-copy`, and the UI layer (shell, chrome, toolbar) is the **Reader**. Code identifiers, file and folder names, CSS classes, and protocol names now use these terms. Serialized fields, some wire values, and saved-data keys such as `reviewSessionId`, `reviewRevision`, `reviewItems`, and the `reviewed-copy` export kind keep their original spelling on disk and on the wire, and the older `display_review` MCP tool and `placekeeper.exportReviewedPdf` VS Code command remain as deprecated aliases.
*Avoid:* Review, Review Item, Reviewed PDF, reviewer

## Live document context

### Document Session
A live Placekeeper session for one PDF, carrying its annotation state and serving the host views that participate in it. Shown to people simply as the Document.
*Avoid:* Review Session, Review (`reviewSessionId` survives as a serialized field name)

### Document Generation
The identity boundary separating successive document versions within a Document Session, so observations and evidence from an earlier version cannot silently authorize work on its replacement.

### Annotation Revision
The version of a Document Session's canonical annotation state, ordering accepted changes independently of its Document Generation.
*Avoid:* Review Revision

A new revision can update annotations or protect unfinished text without replacing PDF bytes. A revision does not necessarily add a document undo step; transient presence can change without a new revision.

### Task Binding
The exclusive association between an agent task and a Document Session's Document Generation, established through a correlated launch and authenticated host activation.

Ownership alone does not mean the agent has a current observation; prompt-time verification establishes freshness separately.

### Native Reconnect Hint
A task-scoped reminder of a previously approved native document source, used to request a fresh launch after live participation ends.

It carries reopening intent only: it grants no Task Binding, current observation, ownership reservation, or access to recovered work.

### Live PDF Context
The task-scoped observation of a bound Document Session at prompt time, with annotation changes and bounded access to its document evidence.

### Live Observation Identity
The identity of a verified document observation, tying its Document Session, Document Generation, source, and semantic annotation state together.

### PDF Evidence Handle
An opaque, expiring authorization to retrieve bounded document evidence for a verified Live Observation Identity under its Task Binding.

Evidence access is rechecked against the live association; an old handle cannot make cached document content current.

### App-owned Document
A Document Session opened through a chat host's direct app entrypoint, whose presentation and context publication are authorized independently of a Task Binding.
*Avoid:* App-owned Review

Its live presentation can expire without discarding protected annotation work. Host acceptance of published context establishes availability, not that an agent consumed it.

### Document in Context
The full-document status indicating that the chat host has accepted the current PDF version supplied by Placekeeper.

It establishes host acceptance, not that an assistant has read the PDF. Lightweight document context alone does not establish this status.

### Captured Document Context
The selection or annotations from a particular Document Generation and Annotation Revision that a reader explicitly attaches to chat, optionally with a note.

Later reading or selection changes do not retarget the captured evidence. It is distinct from automatically updated document context, and attaching it does not send a chat message.
*Avoid:* Captured Review Context

## PDF annotation presentation

### Reference Tab
A secondary view of a PDF passage that lets the reader inspect related material while keeping the main reading position separate.

### Destination Band
A transient mark over the passage a followed PDF link points to, so the reader can see exactly which spot the link meant.

It is presentation only: never an annotation, never saved or exported.

### PDF Annotation Surface
The particular Main view or Reference Tab, within a Document Generation, that supplied an annotation interaction.

The same annotation can appear on multiple surfaces; shared annotation identity does not give one surface ownership of another surface's transient inspection.

## Reader toolbar

### Fit Text
A reading view that fits the body-text block to the usable viewport at a shared zoom and centers each page by its reading area rather than its page edges.

Text-centered alignment can remain after manual zoom, even though the zoom percentage is then custom rather than an active fit.

### Toolbar Presentation
The composition of the single-row reader toolbar, determining which controls appear directly and which are reached through menus for the available space and input method.
*Avoid:* Responsive Toolbar Presentation, toolbar mode

Moving controls into a menu preserves their actions, availability, and keyboard access. History actions retain disabled slots or menu entries when unavailable. Optional groups, such as the separate References toggle, enter the width budget only when the current layout exposes them.

## Annotation authoring and recovery

### Protected Draft
Durably accepted annotation work that remains recoverable before its final application or discard, even if its editing window disconnects.

A draft's existence does not mean an editor is still active or that it should block a Document Generation change. Updating or discarding it does not create a document undo step; applying it creates an annotation action whose undo does not reopen the consumed draft.

### Interaction Hold
Temporary authority for an admitted source-dependent interaction to finish against the displayed Document Generation before the shared Document Session advances.

A live editor does not lose its hold merely through inactivity; loss of its authenticated connection releases live authority without discarding its Protected Draft.

### Active Authoring Presence
A temporary indication that one exact Protected Draft is being edited or awaiting bounded reconnect recovery, used to distinguish a live editor from recovery work in other views of the Document Session.

Presence and durable recovery have separate lifetimes; reconnect continuity must not permanently hide an abandoned draft.

## PDF persistence

### Save Destination
The authorized original PDF, host resource, or independent copy selected to receive a Document Session's annotation changes.

Its identity changes independently of semantic edits; a source Document Generation change must preserve the distinction between the original and a separate copy.

### Save Sync
The durable relationship between the desired annotation state and the state last verified in the Save Destination.

Recoverable work need not yet be saved in the PDF, and a successful write of older annotation state does not make newer edits saved.

## Source navigation

### Return Editor
The editor associated with one Placekeeper viewer for PDF-to-source navigation.

For a shared native PDF window, the latest explicit editor navigation request sets this association; background refresh and automatic following do not change it. A directly opened viewer can establish this association through explicit source-navigation setup before requesting reverse search. An embedded VS Code viewer retains its own host association.

### Source Navigation Intent
A captured source position whose request remains associated with the user's navigation choice while Placekeeper waits for a usable PDF mapping.

An explicit request retains its original position even if the editor cursor moves. Newer explicit navigation supersedes older pending navigation; automatic following cannot replace the user's newer explicit choice. The intent does not itself grant source access or establish that a particular Document Generation is ready.
