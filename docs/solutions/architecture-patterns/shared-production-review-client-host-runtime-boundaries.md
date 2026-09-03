---
title: Shared production review client with host-specific runtime boundaries
date: 2026-09-02
last_updated: 2026-09-03
category: architecture-patterns
module: Embedded review runtime
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - The same interactive product client must run in a browser, editor webview, or browser extension document
  - Hosts differ in transport, resource URLs, lifecycle, presentation persistence, or privileged actions
  - An embedded frame or extension document must remain untrusted relative to its native host or local service
  - A one-shot document stream must join durable state across reload, duplication, restart, and suspension
  - Document generations and review revisions can invalidate asynchronous requests and events
resolution_type: code_fix
related_components:
  - Review Host Runtime
  - Review Runtime Protocol
  - VS Code webview bridge
  - Chrome MIME handler
  - Chrome native runtime
  - Loopback Review URL
  - shared production web assets
tags: [host-runtime, vscode-webview, chrome-extension, shared-client, typed-rpc, trust-boundaries, presentation-lease, capability-safety]
---

# Shared production review client with host-specific runtime boundaries

## Context

Placekeeper's complete production experience must run in three materially different hosts: an ordinary loopback browser page, a VS Code webview, and a Chrome top-level PDF handler. Building separate interfaces would duplicate annotations, navigation, reconciliation, save, and export behavior and invite the products to drift. For VS Code, a nested loopback page was unreliable inside Electron's security model, while an external browser broke the source-centered workflow. For Chrome, navigating the PDF tab to a loopback review worked but discarded the original URL and felt unlike a native PDF viewer (session history).

The durable seam is the Review Host Runtime. The application depends on one host-neutral bootstrap, command, save, export, invalidation, resource, and disposal interface. Its host identity is explicitly `browser`, `vscode`, or `chrome` (`apps/web/src/host/runtime.ts:40-48`). All three entry paths converge on `startRuntime`, which renders the same `RuntimeProductionReviewApp` and `ProductionReviewApp` component tree (`apps/web/src/production-entry.tsx:383-405`, `apps/web/src/production-entry.tsx:427-486`).

The hosts retain different authority models:

- The browser runtime uses authenticated HTTP and WebSocket behavior (`apps/web/src/host/browser-runtime.ts:21-24`, `apps/web/src/host/browser-runtime.ts:74`).
- The VS Code runtime uses a versioned message bridge. Credentials, filesystem paths, SyncTeX, and resource issuance stay in the trusted extension host (`apps/web/src/host/vscode-runtime.ts:209-220`, `apps/vscode/src/webview-bridge.ts:86-125`).
- The Chrome handler uses native messaging to reach the service, but gives the shared client only a constrained RPC port and host policy. The client receives neither native-messaging access nor service credentials (`apps/web/src/production-entry.tsx:489-513`).

Chrome experiments first tried to infer continuity from navigation-entry IDs, replacement type, and handler-local attachment tokens. Reload replaced those values and misclassified the same review as an independent attachment. Browser navigation is presentation evidence, not canonical application identity (session history).

The integrated rule is: **share product semantics, keep authority in each host, and keep durable review truth behind every disposable presentation**.

## Guidance

### Share product semantics, not host authority

Keep one production component tree and semantic review model. Hide transport, bootstrap, invalidation delivery, privileged actions, resource materialization, and disposal behind the Review Host Runtime (`apps/web/src/host/runtime.ts:19-48`). A host can then use its natural transport without creating host-specific product logic.

The browser adapter remains a direct session client. The VS Code adapter translates semantic operations into webview messages and materializes only extension-issued resources. The Chrome adapter translates those same operations into native-runtime requests while preserving the PDF's source tab and URL. Each host exposes only operations it can safely supply: the shared protocol explicitly excludes SyncTeX methods from Chrome (`packages/core/src/review-runtime-protocol.ts:4-37`).

Do not force every host through one physical transport. The stable abstraction is the semantic contract, not HTTP, WebSocket, webview messaging, or native messaging.

### Centralize stable protocol vocabulary, then validate at each boundary

Keep protocol identity, version, operation names, and shared opaque-identifier guards in one platform-neutral module. The Review Runtime Protocol declares the complete method tuple and derives host-specific subsets from it (`packages/core/src/review-runtime-protocol.ts:1-37`). This makes a rename or addition a visible contract change rather than unrelated string edits across hosts.

Shared vocabulary is not permission to accept an arbitrary payload. The receiving boundary must still enforce exact keys, message size, method-specific shapes, numeric bounds, replay rules, and current identity. Chrome adds a second versioned protocol whose envelopes are separated into acquisition, runtime, resource, and lifecycle lanes (`packages/core/src/chrome-native-runtime-protocol.ts:18-51`, `packages/core/src/chrome-native-runtime-protocol.ts:98-175`). A data frame therefore cannot be reinterpreted as a control frame, and quotas and cleanup can remain lane-specific.

Define routing as exhaustive records or switches over the derived method unions. New operations should fail compilation or contract tests until every host has made a deliberate routing, rejection, and output-sanitization decision.

### Keep canonical review identity behind the least reliable process

Do not make a browser tab, navigation entry, extension token, native-host process, or source URL the owner of review identity. Chrome resolves a canonical review from the conjunction of normalized source identity, the verified PDF digest, and document generation (`apps/service/src/browser/chrome-runtime.ts:316-335`). A source URL is only a lookup coordinate; identical URLs can serve different bytes.

Give every attachment a separate presentation lease. The backend tracks presentations independently from the canonical record, and detaching one lease does not destroy the review or interfere with another tab (`apps/service/src/browser/chrome-runtime-backend.ts:106-116`, `apps/service/src/browser/chrome-runtime-backend.ts:188-203`). Reload, duplicate, restore, and fresh reopen can therefore create new presentations of one semantic review instead of copying fragile tab-local identity.

This distinction also protects cleanup. A broad "opened versus created" test can delete a resumed protected draft when provisional setup fails. Cleanup must release only the provisional claim unless the service record is both newly disposable and has no activated or remaining presentation (`apps/service/src/browser/chrome-runtime-backend.ts:194-203`; session history).

### Make acquisition reversible and activation a commit point

Separate acquisition from activation. The service may stage a canonical review as provisional, but it does not activate the presentation until the handler has validated the document and the shared client is ready (`apps/service/src/browser/chrome-runtime.ts:538-565`, `apps/service/src/browser/chrome-runtime.ts:634-642`). The extension checks byte length, SHA-256, and the PDF signature before creating the document Blob (`apps/chrome-extension/src/chrome-runtime.ts:160-167`, `apps/chrome-extension/src/chrome-runtime.ts:580-598`). The handler waits for the embedded client to report document readiness before it activates the review (`apps/chrome-extension/src/handler-entry.ts:219-249`).

Fallback semantics follow that boundary. Before activation, failure may release provisional state and return to Chrome's default viewer exactly once. After activation, disconnect or version skew must stay inside Placekeeper as a read-only reconnect or recovery state so protected work is not silently abandoned (`apps/chrome-extension/src/handler-controller.ts:67-95`, `apps/chrome-extension/src/handler-controller.ts:120-157`). Activation is therefore a real transaction boundary, not a UI status.

### Compose capabilities instead of forwarding authority

Return closed, non-authorizing projections across less-trusted boundaries. Chrome-facing state is rebuilt from allowlists and recursively rejects credentials, capabilities, paths, source URLs, task identity, presentation identifiers, and SyncTeX authority (`packages/core/src/review-runtime-protocol.ts:58-62`, `packages/core/src/review-runtime-protocol.ts:90-118`, `packages/core/src/chrome-native-runtime-protocol.ts:178-206`). The trusted backend exchanges and revokes the bootstrap credential instead of forwarding it into the extension (`apps/service/src/browser/chrome-runtime-backend.ts:300-310`).

Compose the viewer's resource capability set at the handler boundary: a digest-verified extension-owned Blob for the PDF plus exact packaged URLs for PDFium and its worker (`apps/chrome-extension/src/chrome-runtime.ts:580-598`). The shared viewer requires the document to be an extension-origin Blob and executable resources to be packaged extension assets with the correct role (`apps/web/src/pdf/embedpdf-viewer.ts:29-74`).

Keep untrusted PDF parsing away from ambient authority. Package the PDFium worker as a standalone asset, pin the engine version and extracted worker shape, and fail the build if that dependency seam changes (`apps/chrome-extension/scripts/embedpdf-worker-source.ts:3-5`, `apps/chrome-extension/scripts/embedpdf-worker-source.ts:29-48`). A caller-created trusted worker lets Chrome keep a self-only content policy rather than allowing inline or remote executable code (`apps/web/src/pdf/embedpdf-viewer.ts:82-110`, `apps/chrome-extension/manifest.json:7-14`).

### Make reconnect-safe mutations and invalidations explicit

Require idempotency keys for side-effecting methods and keep the replay journal with the long-lived service authority, not the reconnectable native process (`apps/service/src/browser/chrome-runtime.ts:169-195`, `apps/service/src/browser/chrome-runtime.ts:288-302`). Fence mutations by generation and revision so a stale presentation cannot apply a command to newer canonical state (`apps/service/src/browser/chrome-runtime.ts:649-677`). A dropped native response can then return a recorded result or an explicit indeterminate outcome instead of repeating a save or mutation.

Preserve semantic invalidation reasons through every adapter. A save can change freshness without changing generation or review revision; collapsing it into a generic unchanged-revision event prevents the client from refreshing save status (session history). Response ordering matters too: the extension defers invalidations during an invocation, updates its projection from the response, and then refreshes queued changes (`apps/chrome-extension/src/chrome-runtime.ts:698-705`, `apps/chrome-extension/src/chrome-runtime.ts:779-823`).

### Treat late timers as lifecycle ambiguity

Wall-clock callbacks do not measure peer inactivity across system suspension. If a timer callback itself arrives substantially late, the machine may have slept. Give the local request or idle lease one fresh normal deadline instead of immediately declaring a disconnect (`packages/core/src/suspend-aware-deadline.ts:4-18`).

Apply this rule on both sides of a local bridge. Pending Chrome requests, the service connection lease, and the native-host idle lease all rearm after an anomalously delayed callback (`apps/chrome-extension/src/chrome-runtime.ts:307-330`, `apps/service/src/browser/chrome-runtime.ts:742-755`, `apps/service/src/browser/chrome-native-host.ts:186-201`). Ordinary on-time expiry still reclaims resources. Use this only for local interactive lifetimes that should survive sleep, not for network or service-level deadlines where elapsed wall time is the contract.

### Test agreement, rejection, and the installed artifact

Pin protocol identities, versions, full method lists, method guards, and identifier syntax in core contract tests. Test every boundary's distinct rejection responsibilities: forbidden capability fields, oversized or replayed messages, stale generation and revision, role-swapped resources, duplicate activation, pre-activation cleanup, and post-activation recovery.

Source and mocked tests cannot establish installed-browser behavior. Real Chrome must prove MIME interception, title propagation, native-host registration, packaged worker startup, PDFium readiness, CSP isolation, reload and duplicate joining, default-viewer fallback, and recovery after restart. Bind that evidence to the exact app and extension build so a successful run against stale assets cannot approve a different release (`test/acceptance/validate-installed-chrome-evidence.ts:18-47`).

During both VS Code and Chrome work, stale installed assets looked like product regressions even while source tests passed. Compare build and installed identities, then open a fresh host surface before changing source to explain a mismatch (session history).

## Why This Matters

One shared client prevents cross-surface drift: annotation, navigation, toolbar, reconciliation, and save behavior flow through the same component tree in every host (`apps/web/src/production-entry.tsx:383-405`, `apps/web/src/production-entry.tsx:463-486`). Boundary-local transport and validation prevent that reuse from exposing paths, credentials, task authority, or privileged operations to an untrusted frame.

Chrome adds a deeper lifecycle lesson. Canonical identity, activation, operation history, and recovery cannot belong to the presentation because tabs, extension documents, native hosts, and even timer schedules are disposable. Treating presentation state as durable truth causes accidental forks, lost attachments, repeated mutations, unsafe fallback, or false idle shutdown after laptop sleep.

These failures share one root: collapsing states that look equivalent in the UI but have different authority or lifecycle meaning. "Opened" is not "newly disposable"; "same URL" is not "same bytes"; "same revision" is not "same save freshness"; and "timer fired" is not always "peer was idle" (session history). Model those distinctions directly and test every transition where ownership changes.

## When to Apply

- Two or more hosts should present the same stateful workflow but acquire state and capabilities differently.
- A webview or browser extension document is less trusted than its native host or service.
- A presentation may reload, duplicate, restore, suspend, or reconnect independently of durable application state.
- Identical locators can return changed bytes, or dropped responses can hide already-committed side effects.
- Protocol additions must fail visibly until routing, validation, redaction, and resource decisions are complete.

Do not introduce the full canonical index, activation phase, idempotency journal, and recovery policy for a stateless viewer that only renders immutable bytes. Do not move permissive payload interfaces into shared core code merely to reduce line count. Stable names and host-neutral semantics are shared; the boundary receiving untrusted data retains its validation and authority policy.

## Examples

### Adding a brokered operation

1. Add the operation once to the Review Runtime Protocol method tuple and decide which hosts may invoke it (`packages/core/src/review-runtime-protocol.ts:7-37`).
2. Add an exact payload rule at every receiving trust boundary.
3. Add the host route; exhaustive records or switches should expose omissions.
4. Add a safe-result branch that decides which fields the embedded client may observe.
5. Extend canonical contract tests and each host's rejection tests.

### Attaching a Chrome PDF

1. Acquire the one-shot PDF stream and compute its exact digest and length.
2. Resolve or stage the canonical review from normalized source identity, digest, and generation.
3. Issue a new presentation lease and a closed service projection.
4. Materialize an extension Blob plus integrity-pinned PDFium resources.
5. Mount the shared client, wait for document readiness, and only then activate.
6. Before activation, failure releases provisional state and falls back once. After activation, failure enters reconnect or protected recovery.

Reload or duplicate follows the same sequence with a new presentation lease. It does not copy a tab-local token. The verified composite identity rejoins the existing review when the document is unchanged (`apps/service/src/browser/chrome-runtime.ts:316-335`, `apps/service/src/browser/chrome-runtime-backend.ts:106-116`).

### Restoring an embedded VS Code panel

The host writes an opaque panel key into webview state before importing the application. On reload, the controller validates that key and resolves it back to a PDF binding. Independently, the shared client validates and restores bounded page and zoom values (`apps/vscode/src/review-panel.ts:141-148`, `apps/vscode/src/review-panel-controller.ts:60-94`, `apps/web/src/production-entry.tsx:571-592`). Authority recovery and visual-position recovery remain separate even though both participate in one reload.

## Related

- [Authority boundaries for reloadable local-review URLs](./reloadable-local-review-url-authority-boundaries.md)
- [Atomic generation transitions for rebuilt PDF reviews](./atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Upgrade-safe lifecycle for a shared per-user daemon](./upgrade-safe-shared-per-user-daemon-lifecycle.md)
- [Task-scoped, prompt-refreshed live PDF context](./task-scoped-prompt-refreshed-live-pdf-context.md)
- [Recoverable autosave for editable PDF annotations](./recoverable-editable-pdf-annotation-autosave.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
- [PR #73: Embedded Chrome PDF review](https://github.com/brad-ross/placekeeper/pull/73)
