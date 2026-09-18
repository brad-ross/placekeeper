# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Live review context

### Review Session
A live Placekeeper review of a document, carrying its review state and serving the host views that participate in that review.

### Document Generation
The identity boundary separating successive document versions within a Review Session, so observations and evidence from an earlier version cannot silently authorize work on its replacement.

### Review Revision
The version of a Review Session's canonical review state, ordering accepted changes independently of its Document Generation.

A new revision can update annotations without replacing PDF bytes; transient presence can change without a new revision.

### Task Binding
The exclusive association between an agent task and a Review Session's Document Generation, established through a correlated launch and authenticated browser activation.

Ownership alone does not mean the agent has a current observation; prompt-time verification establishes freshness separately.

### Live PDF Context
The task-scoped observation of a bound review at prompt time, with review changes and bounded access to its document evidence.

### Live Observation Identity
The identity of a verified review observation, tying its Review Session, Document Generation, source, and semantic review state together.

### PDF Evidence Handle
An opaque, expiring authorization to retrieve bounded document evidence for a verified Live Observation Identity under its Task Binding.

Evidence access is rechecked against the live association; an old handle cannot make cached document content current.

## Annotation authoring and recovery

### Protected Draft
Durably accepted annotation work that remains recoverable before its final application or discard, even if its editing window disconnects.

A draft's existence does not mean an editor is still active or that it should block a Document Generation change.

### Interaction Hold
Temporary authority for an admitted source-dependent interaction to finish against the displayed Document Generation before the shared Review Session advances.

A live editor does not lose its hold merely through inactivity; loss of its authenticated connection releases live authority without discarding its Protected Draft.

### Active Authoring Presence
A temporary indication that one exact Protected Draft is being edited or awaiting bounded reconnect recovery, used to distinguish a live editor from recovery work in other views of the Review Session.

Presence and durable recovery have separate lifetimes; reconnect continuity must not permanently hide an abandoned draft.

## PDF persistence

### Save Destination
The authorized original PDF or independent copy selected to receive a Review Session's annotation changes.

Its identity changes independently of semantic edits; a source Document Generation change must preserve the distinction between the original and a separate copy.

### Save Sync
The durable relationship between the desired annotation state and the state last verified in the Save Destination.

Recoverable work need not yet be saved in the PDF, and a successful write of older annotation state does not make newer edits saved.
