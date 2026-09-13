# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Live review context

### Review Session
A live Placekeeper review of a document, carrying its review state and serving the host views that participate in that review.

### Document Generation
The identity boundary separating successive document versions within a Review Session, so observations and evidence from an earlier version cannot silently authorize work on its replacement.

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
