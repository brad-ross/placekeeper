# Documentation

Start with [Contributing](../CONTRIBUTING.md) for code ownership, builds, and test aliases, or [Concepts](concepts.md) for domain vocabulary.

## Operating instructions

- [Installation and removal](installation.md): native app, updates, and optional integrations.
- [Privacy and recovery](privacy-and-recovery.md): local storage and durability boundaries.
- [Support and diagnostics](support.md): troubleshooting and evidence collection.
- [Web beta](web-beta.md): static distribution profiles and publication qualification. The presence of a build does not imply public release clearance.

## Decisions and current learnings

[Architecture decisions](decisions/) record consequential choices, including the [PDF backend](decisions/pdf-backend.md). [Captured learnings](solutions/) explain verified problems and the reasoning behind their solutions:

| Area | Start here |
| --- | --- |
| Host boundaries | [Shared production runtime](solutions/architecture-patterns/shared-production-review-client-host-runtime-boundaries.md), [shared daemon lifecycle](solutions/architecture-patterns/upgrade-safe-shared-per-user-daemon-lifecycle.md) |
| Session state | [Autosave/recovery](solutions/architecture-patterns/recoverable-editable-pdf-annotation-autosave.md), [atomic generations](solutions/architecture-patterns/atomic-generation-transitions-for-rebuilt-pdf-reviews.md) |
| Source and agent work | [Manual precedence](solutions/architecture-patterns/manual-precedence-agent-source-reconciliation.md), [live context](solutions/architecture-patterns/task-scoped-prompt-refreshed-live-pdf-context.md), [SyncTeX](solutions/architecture-patterns/generation-bound-bidirectional-synctex-across-embedded-vscode-reviews.md) |
| Reader interaction | [Authoring](solutions/design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md), [full reader](solutions/design-patterns/full-annotation-reader-preserves-tray-context.md), [workspace framing](solutions/architecture-patterns/adaptive-annotation-tray-framing.md) |
| PDF representation | [Portable appearance](solutions/integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md), [source-style absence](solutions/integration-issues/preserve-source-style-absence-across-pdf-rewrites.md), [bounded metadata](solutions/integration-issues/valid-long-highlights-rejected-by-portable-shape-limit.md) |
| Verification boundaries | [Native first paint](solutions/ui-bugs/native-webkit-workspace-first-paint-redundant-clipping.md), [WebKit retry convergence](solutions/test-failures/webkit-recoverable-reference-flow-acceptance-test.md) |

Learnings retain dated incident and verification history. Follow their current guidance and source references; historical observations are not a claim about today's installed application.

## Plans, evidence, and experiments

[Plans](plans/) contain proposals, implementation plans, design contracts, and dated verification records. Their existence does not establish completion. [Plan assets](plans/assets/) preserve design and investigation artifacts. [Audits](audits/) record scoped refreshes and validation outcomes; [residual review findings](residual-review-findings/) record unresolved or deliberately bounded observations.

The [Electron shell spike](../apps/electron-spike/README.md) remains a runnable decision probe, not an adopted host. Keep such experiments distinct from the production host map.
