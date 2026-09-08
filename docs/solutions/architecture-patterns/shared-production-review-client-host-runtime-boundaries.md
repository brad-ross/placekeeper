---
title: Shared production review client with host-specific runtime boundaries
date: 2026-09-02
last_updated: 2026-09-07
category: architecture-patterns
module: Embedded review runtime
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - The same stateful product client must run in browser, editor webview, browser-extension, static, and native document hosts
  - Hosts differ in transport, resource URLs, lifecycle, presentation persistence, or privileged actions
  - A native OS shell owns windows and application behavior while a separate service remains the canonical state authority
  - Embedded web content must receive only closed, generation-bound, and attempt-bound capabilities
  - Shell construction, visible paint, document readiness, activation, and recovery can complete on different attempts
resolution_type: code_fix
related_components:
  - Review Host Runtime
  - Review Runtime Protocol
  - VS Code webview bridge
  - Chrome MIME handler
  - Chrome native runtime
  - Static Review Host Runtime
  - macOS Host Runtime
  - AppKit document window shell
  - Mac Review Helper
  - Mac app lifecycle control
  - native candidate packaging
  - Browser Document Session
  - Loopback Review URL
  - shared production web assets
tags: [host-runtime, shared-client, macos-native-shell, appkit, wkwebview, canonical-review, attempt-fencing, capability-safety]
---

# Shared production review client with host-specific runtime boundaries

## Context

Placekeeper's complete production experience now runs in five materially different hosts: an ordinary loopback browser page, a VS Code webview, a Chrome top-level PDF handler, a front-end-only static page, and a native AppKit document application whose content is the same React review in a `WKWebView`. Building separate interfaces would duplicate annotations, navigation, reconciliation, and export behavior and invite the products to drift. For VS Code, a nested loopback page was unreliable inside Electron's security model, while an external browser broke the source-centered workflow. For Chrome, navigating the PDF tab to a loopback review worked but discarded the original URL and felt unlike a native PDF viewer. The static page sharpened the architectural boundary because it has no trusted local service, filesystem authority, autosave destination, or durable session to forward. The Mac host adds native windows, menus, restoration, and titlebar behavior without moving Canonical Review authority out of the service ([PR #77](https://github.com/brad-ross/placekeeper/pull/77)).

The durable seam is the Review Host Runtime. The application depends on one host-neutral bootstrap, command, save, export, invalidation, resource, and disposal interface. Its host identity is explicitly `browser`, `vscode`, `chrome`, `macos`, or `static` (`apps/web/src/host/runtime.ts:40-48`). Browser, VS Code, Chrome, and macOS render the same `RuntimeProductionReviewApp` and `ProductionReviewApp` tree; static mode mounts the same production application through its export-only adapter (`apps/web/src/production-entry.tsx:438-493`, `apps/web/src/macos-entry.tsx:274-300`; `apps/web/src/static-entry.tsx:273-305`).

The hosts retain different authority models:

- The browser runtime uses authenticated HTTP and WebSocket behavior (`apps/web/src/host/browser-runtime.ts:21-24`, `apps/web/src/host/browser-runtime.ts:74`).
- The VS Code runtime uses a versioned message bridge. Credentials, filesystem paths, SyncTeX, and resource issuance stay in the trusted extension host (`apps/web/src/host/vscode-runtime.ts:209-220`, `apps/vscode/src/webview-bridge.ts:86-125`).
- The Chrome handler uses native messaging to reach the service, but gives the shared client only a constrained RPC port and host policy. The client receives neither native-messaging access nor service credentials (`apps/web/src/production-entry.tsx:489-513`).
- The static runtime holds the selected bytes and Review State in the live tab, exposes an object URL and packaged browser-PDF resources, and reports `persistenceMode: "export-only"`. It supplies no invalidation channel, destination selection, SyncTeX, service credential, or durable session authority (`apps/web/src/host/static-runtime.ts:437-492`, `apps/web/src/host/static-runtime.ts:494-520`, `apps/web/src/host/static-runtime.ts:562-575`).
- The macOS runtime is a projection across a capability-scoped Swift bridge and one service helper per window attempt. AppKit owns document windows, menus, restoration, traffic lights, dragging, and bounded native fallback; the service still owns Canonical Review identity, mutations, save state, activation, and recovery (`apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:80-143`, `apps/service/src/macos/macos-runtime.ts:31-54`, `apps/service/src/macos/macos-runtime.ts:298-359`).

The native-shell decision was tested before it entered the production package. A sandboxed Electron comparator proved that the existing client, Finder launch, and exact-origin service boundary were viable, but measured a 275 MB bundle and roughly 474–551 MB of aggregate Electron working set while still requiring the shared daemon; it remains decision evidence rather than an adopted host (`apps/electron-spike/RESULTS.md`). A disposable AppKit prototype then exercised the smaller, more Mac-native boundary. Early AppKit experiments used same-window document replacement and briefly tried a preflight window; the final design moved to concurrent document windows and removed the preflight workaround after the actual readiness transition became trustworthy (session history). The durable rule is broader than "put a website in a native window": let the native host own native presentation, let the shared client own product semantics, let the service own durable review truth, and make every handoff carry the identity and lifecycle fence appropriate to the authority crossing it.

Chrome experiments first tried to infer continuity from navigation-entry IDs, replacement type, and handler-local attachment tokens. Reload replaced those values and misclassified the same review as an independent attachment. Browser navigation is presentation evidence, not canonical application identity (session history).

The integrated rule is: **share product semantics, keep authority and durability explicit in each host, and never let a disposable presentation imply stronger persistence than the host can provide**. Browser, VS Code, and Chrome broker durable state through trusted authorities; the static host denies those capabilities and establishes durability only through explicit, verified export.

## Guidance

### Share product semantics, not host authority

Keep one production component tree and semantic review model. Hide transport, bootstrap, invalidation delivery, privileged actions, resource materialization, and disposal behind the Review Host Runtime (`apps/web/src/host/runtime.ts:19-48`). A host can then use its natural transport without creating host-specific product logic.

The browser adapter remains a direct session client. The VS Code adapter translates semantic operations into webview messages and materializes only extension-issued resources. The Chrome adapter translates those same operations into native-runtime requests while preserving the PDF's source tab and URL. Each host exposes only operations it can safely supply: the shared protocol explicitly excludes SyncTeX methods from Chrome (`packages/core/src/review-runtime-protocol.ts:4-37`).

Do not force every host through one physical transport. The stable abstraction is the semantic contract, not HTTP, WebSocket, webview messaging, or native messaging.

### Project native behavior without duplicating review authority

Add a native host as a projection of the shared product, not as a second implementation. The Mac entry can render a bounded pending bootstrap in the production component tree before native runtime authority arrives; unsupported operations reject instead of pretending that the pending state is usable (`apps/web/src/production-entry.tsx:438-493`, `apps/web/src/production-entry.tsx:587-606`). Once AppKit supplies the runtime, the macOS adapter becomes another RPC-backed `HostRuntime` and materializes only the document, PDFium, and worker resources installed for that attempt (`apps/web/src/host/macos-runtime.ts:28-86`).

Keep native affordances as projections of shared meaning. The web client publishes one semantic command vocabulary and enabled-state snapshot (`apps/web/src/review/review-command-surface.ts:1-25`, `apps/web/src/review/review-command-surface.ts:34-70`). AppKit validates a complete, revisioned snapshot, follows the key document window, and keeps editable-text Undo and Redo in Cocoa's responder chain while returning review commands to the shared client (`apps/macos/Sources/PlacekeeperMac/MenuCoordinator.swift:22-63`, `apps/macos/Sources/PlacekeeperMac/MenuCoordinator.swift:97-138`). The menu is an alternate native presentation of shared commands, not a competing command implementation.

### Treat missing authority as a first-class host contract

Do not emulate a service-backed host in a static page by sprinkling special cases through the shared client. Make the absence of authority explicit at the runtime seam. The static adapter keeps Review State in its closure, identifies itself as `host: "static"`, and bootstraps the production tree with `launchSurface: "static"` and `persistenceMode: "export-only"` (`apps/web/src/host/static-runtime.ts:447-492`). The shared application translates that posture into truthful product behavior: it labels the review as needing export, suppresses save-destination controls, and gates annotation commands as `ephemeral` so authoring never pretends that an autosave destination exists (`apps/web/src/app/ProductionReviewApp.tsx:543-553`, `apps/web/src/app/ProductionReviewApp.tsx:1742-1763`, `apps/web/src/app/ProductionReviewApp.tsx:2026-2033`, `apps/web/src/app/ProductionReviewApp.tsx:2092-2095`; `apps/web/src/save/save-state-controller.ts:9-21`).

Capability denial belongs in the adapter, not merely in copy. The static runtime returns a cancelled folder choice, keeps every save-status operation at `not-saved`, exposes no invalidations, and rejects both SyncTeX directions (`apps/web/src/host/static-runtime.ts:494-520`, `apps/web/src/host/static-runtime.ts:570-575`). The tab's `beforeunload` guard is only a loss warning keyed to revisions newer than the export checkpoint; it is not persistence (`apps/web/src/host/static-runtime.ts:457-472`). Because this host has no trusted peer that can recover authority, its entry point also refuses to mount inside another page, from an opener-controlled tab, or under service-worker control (`apps/web/src/static-entry.tsx:218-240`).

### Centralize stable protocol vocabulary, then validate at each boundary

Keep protocol identity, version, operation names, and shared opaque-identifier guards in one platform-neutral module. The Review Runtime Protocol declares the complete method tuple and derives host-specific subsets from it (`packages/core/src/review-runtime-protocol.ts:1-37`). This makes a rename or addition a visible contract change rather than unrelated string edits across hosts.

Shared vocabulary is not permission to accept an arbitrary payload. The receiving boundary must still enforce exact keys, message size, method-specific shapes, numeric bounds, replay rules, and current identity. Chrome adds a second versioned protocol whose envelopes are separated into acquisition, runtime, resource, and lifecycle lanes (`packages/core/src/chrome-native-runtime-protocol.ts:18-51`, `packages/core/src/chrome-native-runtime-protocol.ts:98-175`). A data frame therefore cannot be reinterpreted as a control frame, and quotas and cleanup can remain lane-specific.

Define routing as exhaustive records or switches over the derived method unions. New operations should fail compilation or contract tests until every host has made a deliberate routing, rejection, and output-sanitization decision.

### Keep canonical review identity behind the least reliable process

Do not make a browser tab, navigation entry, extension token, native-host process, or source URL the owner of review identity. Chrome resolves a canonical review from the conjunction of normalized source identity, the verified PDF digest, and document generation (`apps/service/src/browser/chrome-runtime.ts:316-335`). A source URL is only a lookup coordinate; identical URLs can serve different bytes.

Give every attachment a separate presentation lease. The backend tracks presentations independently from the canonical record, and detaching one lease does not destroy the review or interfere with another tab (`apps/service/src/browser/chrome-runtime-backend.ts:106-116`, `apps/service/src/browser/chrome-runtime-backend.ts:188-203`). Reload, duplicate, restore, and fresh reopen can therefore create new presentations of one semantic review instead of copying fragile tab-local identity.

This distinction also protects cleanup. A broad "opened versus created" test can delete a resumed protected draft when provisional setup fails. Cleanup must release only the provisional claim unless the service record is both newly disposable and has no activated or remaining presentation (`apps/service/src/browser/chrome-runtime-backend.ts:194-203`; session history).

For a native document shell, keep four identity classes separate:

- `windowID` identifies one physical AppKit presentation.
- Canonical Review identity names the service-owned review that other hosts may already present.
- the document digest binds that review to verified bytes.
- `attemptID`, `runtimeID`, and `helperID` identify disposable transport and rendering work.

The native registry stores window ID, Canonical Review ID, and digest separately (`apps/macos/Sources/PlacekeeperMac/DocumentWindowRegistry.swift:3-25`). A normalized file path is only an in-flight launch routing key. After service admission, the returned Canonical Review ID may focus an existing matching window and release the redundant provisional candidate; otherwise the app registers a new window against that service identity and digest (`apps/macos/Sources/PlacekeeperMac/LaunchCoordinator.swift:9-14`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift:270-308`).

Persist reopening intent, not live authority. The restoration record contains a source path, window frame, and optional page and zoom. It does not persist a session, lease, helper, runtime, or attempt identifier (`apps/macos/Sources/PlacekeeperMac/WindowRestoration.swift:4-35`). Startup converts the record back into an ordinary open request after fresh app-lifecycle registration (`apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift:54-120`).

### Make acquisition reversible and activation a commit point

Separate acquisition from activation. The service may stage a canonical review as provisional, but it does not activate the presentation until the handler has validated the document and the shared client is ready (`apps/service/src/browser/chrome-runtime.ts:538-565`, `apps/service/src/browser/chrome-runtime.ts:634-642`). The extension checks byte length, SHA-256, and the PDF signature before creating the document Blob (`apps/chrome-extension/src/chrome-runtime.ts:160-167`, `apps/chrome-extension/src/chrome-runtime.ts:580-598`). The handler waits for the embedded client to report document readiness before it activates the review (`apps/chrome-extension/src/handler-entry.ts:219-249`).

Fallback semantics follow that boundary. Before activation, failure may release provisional state and return to Chrome's default viewer exactly once. After activation, disconnect or version skew must stay inside Placekeeper as a read-only reconnect or recovery state so protected work is not silently abandoned (`apps/chrome-extension/src/handler-controller.ts:67-95`, `apps/chrome-extension/src/handler-controller.ts:120-157`). Activation is therefore a real transaction boundary, not a UI status.

The same transaction boundary applies without a backend. Static opening is divided into acquisition, assessment, and provisional activation. One abort signal flows from the launcher through file or URL acquisition and browser-PDF assessment; cancellation, timeout, or assessment failure disposes the provisional document session and returns control to the still-mounted launcher (`apps/web/src/static-entry.tsx:273-285`, `apps/web/src/host/static-runtime.ts:385-436`). The review renders first into a temporary hidden root. Only a document-ready signal followed by a current activation epoch unmounts the launcher and promotes that root; every earlier failure disposes the runtime and removes the provisional root (`apps/web/src/static-entry.tsx:287-316`).

Cancellation must also fence work that completes late. The Browser Document Session admits one operation, captures an epoch, races the writer against cancellation and timeout, increments the epoch before tearing down a cancelled writer, and rejects any result from an obsolete epoch (`packages/pdf-backends/src/browser-document-session.ts:67-159`). An old assessment or export therefore cannot activate a viewer, start a download, or mutate the export checkpoint after its owner has cancelled or closed it.

The Mac host makes readiness a staged transaction rather than one boolean. The page publishes `shell-ready` only after fonts and measured drag geometry settle. Native then commits routing, shows the real window, and requests a post-visibility confirmation. The page waits two animation frames before returning `visible-shell-ready`; document readiness arrives independently from the renderer with the current attempt and document generation (`apps/web/src/macos-entry.tsx:169-239`, `apps/web/src/macos-entry.tsx:342-364`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:276-345`).

Activation is the commit point. The service record remains provisional until current visible-paint and document-ready evidence agree for the same attempt. Activation installs the presentation lease; cancellation releases the provisional claim, while teardown of an active presentation detaches its lease (`apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:334-470`, `apps/service/src/macos/macos-runtime.ts:337-359`, `apps/service/src/macos/macos-runtime.ts:515-535`). Every helper envelope carries window, attempt, and request identity, and the service rejects messages that do not match the current helper record (`packages/core/src/macos-helper-protocol.ts:23-28`, `apps/service/src/macos/macos-runtime.ts:187-216`).

Invalidate the failed attempt before offering recovery. On helper or WebContent failure, the controller removes the page bridge, invalidates resource delivery, clears drag and command state, and replaces only that window with a minimal Retry, Diagnostics, and Close surface. Retry re-enters the ordinary open flow and mints fresh attempt, runtime, and helper identities (`apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:174-195`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:421-424`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift:491-496`). Do not recover by reloading a privileged page whose capabilities belong to the failed attempt.

### Compose capabilities instead of forwarding authority

Return closed, non-authorizing projections across less-trusted boundaries. Chrome-facing state is rebuilt from allowlists and recursively rejects credentials, capabilities, paths, source URLs, task identity, presentation identifiers, and SyncTeX authority (`packages/core/src/review-runtime-protocol.ts:58-62`, `packages/core/src/review-runtime-protocol.ts:90-118`, `packages/core/src/chrome-native-runtime-protocol.ts:178-206`). The trusted backend exchanges and revokes the bootstrap credential instead of forwarding it into the extension (`apps/service/src/browser/chrome-runtime-backend.ts:300-310`).

Compose the viewer's resource capability set at the handler boundary: a digest-verified extension-owned Blob for the PDF plus exact packaged URLs for PDFium and its worker (`apps/chrome-extension/src/chrome-runtime.ts:580-598`). The shared viewer requires the document to be an extension-origin Blob and executable resources to be packaged extension assets with the correct role (`apps/web/src/pdf/embedpdf-viewer.ts:29-74`).

Keep untrusted PDF parsing away from ambient authority. Package the PDFium worker as a standalone asset, pin the engine version and extracted worker shape, and fail the build if that dependency seam changes (`apps/chrome-extension/scripts/embedpdf-worker-source.ts:3-5`, `apps/chrome-extension/scripts/embedpdf-worker-source.ts:29-48`). A caller-created trusted worker lets Chrome keep a self-only content policy rather than allowing inline or remote executable code (`apps/web/src/pdf/embedpdf-viewer.ts:82-110`, `apps/chrome-extension/manifest.json:7-14`).

Apply the same rule in both directions across the Mac bridge. The page does not receive the source path, service credential, presentation lease, or generic native authority. The Swift parser accepts an exact method set and envelope shape and requires the expected runtime identity; invocation also requires the matching session and generation, activation, and a revision no older than the native projection. Side-effecting requests receive an idempotency key (`apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:11`, `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:94`). The native projection is an asynchronous cache, so equality with its revision is not the canonical freshness check. Forward the page's request revision to the authoritative helper instead (`apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:108`).

Treat resources as capabilities. The helper protocol binds document reads to a role, generation, range, and bounded chunk size. Native reassembles the chunks and verifies length, SHA-256, and the PDF signature before exposing the document. The custom scheme handler serves only manifest-listed packaged assets under the bundle root or the current role-bound document resource; the nonpersistent `WKWebView` blocks ordinary HTTP, HTTPS, WS, and WSS egress (`packages/core/src/macos-helper-protocol.ts:14-21`, `apps/macos/Sources/PlacekeeperMac/ResourceSchemeHandler.swift:59-105`, `apps/macos/Sources/PlacekeeperMac/ResourceSchemeHandler.swift:160-199`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:95-100`).

Keep app lifecycle control disjoint from review authority. Its protocol can register the app, report activity, prepare replacement, detach a helper, or detach the app, but it cannot admit a document or mutate a review (`packages/core/src/macos-app-control-protocol.ts:5-37`). A zero-window resident Mac app can therefore remain lifecycle-visible without retaining a review helper or borrowing review capabilities for update coordination.

### Treat the native titlebar as a joint geometry contract

The shared layout owns one 54px top-bar token for browser, Chrome, VS Code, static, and macOS surfaces (`apps/web/src/app/review-layout-foundation.css:24-31`, `apps/web/src/app/review-layout-foundation.css:113-128`). The Mac host passes traffic-light and trailing insets into the shared layout, aligns the web bar's center with the native controls, and independently positions the standard AppKit buttons on the same leading geometry (`apps/web/src/macos-entry.tsx:269-286`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:549-569`). Do not fork the toolbar merely to gain a native titlebar.

Dragging cannot be one static CSS rectangle because the toolbar contains responsive live controls. The page measures the rendered bar, subtracts traffic lights and every visible interactive control, and publishes the remaining gaps. Native accepts them only when no transition is in progress, the geometry identity matches, the revision increases, and every rectangle is valid (`apps/web/src/macos-entry.tsx:32-121`, `apps/macos/Sources/PlacekeeperMac/MacPolicies.swift:55-80`). Resize, screen, backing-scale, and full-screen transitions clear the overlays before issuing a fresh geometry identity. Safe native overlays perform ordinary drag or standard double-click zoom without stealing web-button interaction (`apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:241-274`, `apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift:756-775`).

### Make reconnect-safe mutations and invalidations explicit

Require idempotency keys for side-effecting methods and keep the replay journal with the long-lived service authority, not the reconnectable native process (`apps/service/src/browser/chrome-runtime.ts:169-195`, `apps/service/src/browser/chrome-runtime.ts:288-302`). Fence mutations by generation and revision so a stale presentation cannot apply a command to newer canonical state (`apps/service/src/browser/chrome-runtime.ts:649-677`). A dropped native response can then return a recorded result or an explicit indeterminate outcome instead of repeating a save or mutation.

Preserve semantic invalidation reasons through every adapter. A save can change freshness without changing generation or review revision; collapsing it into a generic unchanged-revision event prevents the client from refreshing save status (session history). Response ordering matters too: the extension defers invalidations during an invocation, updates its projection from the response, and then refreshes queued changes (`apps/chrome-extension/src/chrome-runtime.ts:698-705`, `apps/chrome-extension/src/chrome-runtime.ts:779-823`).

### Do not make an asynchronous native projection the revision authority

A first annotation/save could succeed while the immediate status request or a later annotation action failed. The meaningful sequence was a committed command response followed by another request before the native projection refresh completed. The page had learned the committed revision from the response; the Swift bridge still held the previous revision. Requiring equality with that cached value rejected legitimate follow-up work. A transient refresh failure could prolong the mismatch, making later delete or undo commands appear broken even though the original command had committed.

The bridge now retains runtime, session, generation, and activation fences, rejects revisions older than its known projection, and forwards the request's revision rather than substituting the cache's revision (`apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:80`, `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:94`, `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:108`). A page revision ahead of the native cache is allowed to reach the helper; that does not mean an arbitrary future revision is accepted as canonical. The service helper still checks exact generation/revision agreement and refreshes canonical state before side-effecting invocation (`apps/service/src/macos/macos-runtime.ts:411`). It updates its projection from canonical state after invocation (`apps/service/src/macos/macos-runtime.ts:445`).

Response correlation is a separate identity requirement. A forwarded operation's success or rejection must echo the initiating request's session, generation, revision, request ID, and method, rather than whichever native projection happens to be current when the asynchronous reply arrives. The command payload can carry the new state revision while its envelope still identifies the request being settled (`apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:120`, `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:206`, `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:240`). Bootstrap continues to use the current projection, and locally handled presence/detach responses retain their existing projection-based path (`apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:85`, `apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:100`).

Projection refresh remains asynchronous after a mutation and publishes an invalidation when generation or revision changes (`apps/macos/Sources/PlacekeeperMac/ReviewBridge.swift:170`). Do not make completing that cache refresh a prerequisite for recognizing an already successful command. Likewise, do not remove revision checks entirely to hide the race: preserve known-stale rejection locally and canonical checks at the authority that owns current state.

The regression explicitly returns a revision-1 command result while the bridge still holds revision 0, then issues an immediate revision-1 save-status request and verifies that it reaches the helper with revision 1 (`apps/macos/Tests/PlacekeeperMacTests/MacPoliciesTests.swift:538`). It fails the subsequent refresh, verifies that a revision-1 command can still proceed, refreshes the bridge to revision 2, and confirms that a revision-0 request is rejected with revision 0 in the rejection envelope so the pending request can settle (`apps/macos/Tests/PlacekeeperMacTests/MacPoliciesTests.swift:578`). These checks prove the lagging-cache path, transient-refresh-failure path, and known-stale rejection. They should not be described as exhaustive coverage of every concurrent refresh ordering.

The reusable lesson is to distinguish a presentation cache's latest observation from canonical state and to distinguish response correlation identity from returned state identity. When the first mutation succeeds but immediate or later requests fail, trace those revisions and response ordering before changing annotation commands, retries, or UI behavior.

### Make verified export the static host's durability commit

An export-only host needs a transaction boundary even though it has no filesystem commit. Snapshot the current Review State before invoking the writer, and continue accepting edits against the live state while that snapshot is serialized (`apps/web/src/host/static-runtime.ts:522-535`). The browser writer checks the source digest, replaces only source annotations whose ownership was validated, saves a copy, and reopens the generated bytes. The reopened copy must preserve page count, contain every requested `(pageIndex, annotationId)` exactly once, give every requested mark a normal appearance, and reconstruct the exact requested editable Review Items before the writer returns success (`packages/pdf-backends/src/browser-writer.ts:246-303`, `packages/pdf-backends/src/browser-writer.ts:308-381`).

Advance the export checkpoint only after that structural reopen succeeds and the browser has been asked to download the checked bytes. Record the captured revision rather than the current live revision; if authoring advanced during export, keep those later edits dirty and tell the user to export again (`apps/web/src/host/static-runtime.ts:545-560`). This avoids two false claims: a writer call is not proof that the serialized PDF reopens, and a checked snapshot does not make concurrent later edits durable. The browser download itself is still only a requested download, not proof that the user retained the file.

Portable re-import closes the export loop without granting ownership from appearance or author strings. Inspection reconstructs editable items only from metadata whose envelope, semantic item, visible projection, identifiers, geometry, and author agree (`packages/core/src/portable-annotation.ts:458-495`, `packages/core/src/portable-annotation.ts:513-650`). The static runtime seeds its initial Review State from those validated portable items (`apps/web/src/host/static-runtime.ts:447-455`). Malformed Placekeeper-looking metadata fails closed at the ownership boundary: browser inspection maps an invalid catalog to no owned items, and export removes only catalog entries that passed validation, so invalid or foreign annotations are neither adopted as editable state nor replaced as Placekeeper-owned marks (`packages/pdf-backends/src/embedpdf-annotation.ts:72-97`, `packages/pdf-backends/src/browser-writer.ts:217-243`, `packages/pdf-backends/src/browser-writer.ts:276-288`). Keep the complete portable identity and foreign-preservation contract in [Recoverable autosave for editable PDF annotations](./recoverable-editable-pdf-annotation-autosave.md); this learning owns only how the static host consumes it.

### Treat late timers as lifecycle ambiguity

Wall-clock callbacks do not measure peer inactivity across system suspension. If a timer callback itself arrives substantially late, the machine may have slept. Give the local request or idle lease one fresh normal deadline instead of immediately declaring a disconnect (`packages/core/src/suspend-aware-deadline.ts:4-18`).

Apply this rule on both sides of a local bridge. Pending Chrome requests, the service connection lease, and the native-host idle lease all rearm after an anomalously delayed callback (`apps/chrome-extension/src/chrome-runtime.ts:307-330`, `apps/service/src/browser/chrome-runtime.ts:742-755`, `apps/service/src/browser/chrome-native-host.ts:186-201`). Ordinary on-time expiry still reclaims resources. Use this only for local interactive lifetimes that should survive sleep, not for network or service-level deadlines where elapsed wall time is the contract.

### Test agreement, rejection, and the installed artifact

Pin protocol identities, versions, full method lists, method guards, and identifier syntax in core contract tests. Test every boundary's distinct rejection responsibilities: forbidden capability fields, oversized or replayed messages, stale generation and revision, role-swapped resources, duplicate activation, pre-activation cleanup, and post-activation recovery.

Source and mocked tests cannot establish installed-browser behavior. Real Chrome must prove MIME interception, title propagation, native-host registration, packaged worker startup, PDFium readiness, CSP isolation, reload and duplicate joining, default-viewer fallback, and recovery after restart. Bind that evidence to the exact app and extension build so a successful run against stale assets cannot approve a different release (`test/acceptance/validate-installed-chrome-evidence.ts:18-47`).

During both VS Code and Chrome work, stale installed assets looked like product regressions even while source tests passed. Compare build and installed identities, then open a fresh host surface before changing source to explain a mismatch (session history).

For a native app, prove the packaged boundary with the artifact that will run. The candidate builder compiles a release Swift executable, stages the shared service and web assets, removes the legacy droplet entry point, rewrites the bundle executable, recomputes packaged identity, signs the bundle, validates it, and only then moves it into the requested output (`packaging/macos/build-native-candidate.ts:329-379`). Validation rejects missing embedded dependencies, external symlinks, checkout-path bytes, non-system native dependencies, and invalid signatures (`packaging/macos/build-native-candidate.ts:236-327`).

Run that candidate with private state rather than over the user's installed app or daemon. The runner creates a private home and launch directory, starts the candidate-contained daemon and native executable on a private port with minimal environments, waits for both document readiness and runtime activation, and removes its state afterward (`packaging/macos/run-native-candidate.ts:240-347`). This proves packaging independence and the activation path. It does not prove notarization, upgrade, accessibility, or full installed-release qualification. Earlier attempts were confounded by stale installed daemons and development override paths; isolating the candidate was the durable fix instead of killing broadly matched processes (session history).

## Why This Matters

One shared client prevents cross-surface drift: annotation, navigation, toolbar, reconciliation, and save behavior flow through the same component tree in every host (`apps/web/src/production-entry.tsx:383-405`, `apps/web/src/production-entry.tsx:463-486`). Boundary-local transport and validation prevent that reuse from exposing paths, credentials, task authority, or privileged operations to an untrusted frame.

Chrome adds a deeper lifecycle lesson. Canonical identity, activation, operation history, and recovery cannot belong to the presentation because tabs, extension documents, native hosts, and even timer schedules are disposable. Treating presentation state as durable truth causes accidental forks, lost attachments, repeated mutations, unsafe fallback, or false idle shutdown after laptop sleep.

The static host shows why a Review Host Runtime is an authority boundary rather than just a transport adapter. Reusing the same component tree is safe only if the host can declare weaker durability and deny unsupported operations without the UI inferring autosave, recovery, SyncTeX, or destination authority. Its export checkpoint is a verified revision boundary, not a generic success flag. Preserving this distinction prevents a static deployment from looking service-backed while silently losing tab-local work or claiming concurrent edits were exported.

The Mac host shows the inverse case: a richer native shell still must not acquire review authority merely because it owns more presentation. Canonical review state survives native-window and WebContent failure because it remains in the service. Each window's helper and attempt contain failure locally. Shared review behavior does not drift because AppKit consumes the production client and semantic command surface, while native behavior stays native because AppKit owns windows, menus, the responder chain, traffic lights, drag, zoom, recent documents, and restoration.

"Rendered something," "visible with final geometry," and "usable PDF" are independent facts. Requiring all current evidence before provisional state becomes an active presentation prevents invisible or obsolete attempts from acquiring durable ownership. The same rule applies to packaging: only the staged bundle running its own contained dependencies and private state can prove that release resources close over the artifact.

These failures share one root: collapsing states that look equivalent in the UI but have different authority or lifecycle meaning. "Opened" is not "newly disposable"; "same URL" is not "same bytes"; "same revision" is not "same save freshness"; and "timer fired" is not always "peer was idle" (session history). Model those distinctions directly and test every transition where ownership changes.

## When to Apply

- Two or more hosts should present the same stateful workflow but acquire state and capabilities differently.
- A webview or browser extension document is less trusted than its native host or service.
- A presentation may reload, duplicate, restore, suspend, or reconnect independently of durable application state.
- Identical locators can return changed bytes, or dropped responses can hide already-committed side effects.
- Protocol additions must fail visibly until routing, validation, redaction, and resource decisions are complete.
- A static or offline-capable surface should reuse a service-backed production client but intentionally offers only explicit export.
- A native document shell should add OS windows, menus, titlebar behavior, restoration, or app residency without duplicating review and persistence logic.
- WebContent, per-window helpers, and service connections can fail and restart independently of the native application or other document windows.
- Native hit testing depends on responsive web layout and becomes stale across resize, display, backing-scale, or full-screen transitions.
- Restored windows should feel persistent even though credentials, presentation leases, helpers, runtimes, and attempts must not be persisted.
- Packaging includes native code, an embedded runtime, local services, and generated web assets whose source-tree paths can mask missing bundle dependencies.
- Long-running browser acquisition, parsing, or serialization can outlive cancellation, retry, tab disposal, or the state revision it captured.
- Exported files must be editable when reopened, but only exact portable ownership metadata may authorize replacement.

Do not introduce the full canonical index, activation phase, idempotency journal, and recovery policy for a stateless viewer that only renders immutable bytes. Conversely, do not add a persistence backend merely to satisfy an interface designed for stronger hosts. If explicit export is the intended durability model, represent it as a capability-denying runtime and make the UI consume that posture. A future autosave requirement is a new authority and recovery design, not an implementation detail of the static adapter. Do not move permissive payload interfaces into shared core code merely to reduce line count. Stable names and host-neutral semantics are shared; the boundary receiving untrusted data retains its validation and authority policy.

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

### Opening and exporting in the static host

1. Acquire one local or remote PDF under the launcher's abort signal.
2. Assess rewrite eligibility and inspect portable annotations before exposing authoring; dispose on cancellation, timeout, or failure.
3. Build an export-only runtime in a provisional root and activate it only after document readiness and the current activation epoch agree.
4. Keep Review State in tab memory. Valid owned metadata restores editable Review Items; invalid ownership remains foreign and grants no replacement authority.
5. On export, capture one revision, serialize its projected annotations, and reopen the output to verify page count, exact owned identities, normal appearances, and editable metadata.
6. Ask the browser to download only the checked bytes, then advance the checkpoint through the captured revision. If later edits exist, leave the review dirty and require another export.

This sequence extends the same shared production client without importing service-backed durability claims into a host that cannot uphold them (`apps/web/src/static-entry.tsx:273-323`, `apps/web/src/host/static-runtime.ts:474-584`).

### Activating a native document window

1. Normalize the file URL only to coordinate concurrent launch intents.
2. Mint fresh window, attempt, runtime, and helper identities.
3. Ask the service to admit the source and return a sanitized projection plus verified document identity.
4. Focus an existing window only when the returned Canonical Review ID matches its registry entry; otherwise register a new window.
5. Render the shared toolbar, publish settled drag geometry, and report `shell-ready`.
6. Commit native routing, order the window visible, and independently verify visible paint and a usable PDF page.
7. Activate the service presentation only when both proofs belong to the current attempt and generation.

The source path routes the request, the service result establishes semantic identity, and current readiness proofs authorize activation. No single identifier or callback substitutes for the others (`apps/macos/Sources/PlacekeeperMac/PlacekeeperMac.swift:204-308`, `apps/web/src/app/document-readiness.ts:14-34`, `apps/service/src/macos/macos-runtime.ts:337-359`).

### Updating native titlebar geometry

1. Keep 54px as the shared toolbar height.
2. Inject native traffic-light bounds and insets instead of adding another toolbar.
3. Measure the rendered interactive controls and publish only the gaps as drag candidates.
4. Clear native overlays when a geometry transition starts.
5. Mint a new geometry identity and accept only a strictly newer region revision for it.
6. Let AppKit perform drag and double-click zoom inside accepted gaps.

The web side decides where product controls are. The native side decides how a safe gap behaves as a Mac titlebar.

### Qualifying a native candidate

1. Build release Swift and packaged Mac web assets into a staging bundle.
2. Reject missing dependencies, legacy launch artifacts, external symlinks, checkout references, non-system native dependencies, or invalid signatures.
3. Start the candidate's own daemon and app from a private home and unrelated working directory.
4. Require document-ready and runtime-activated markers from that exact run.
5. Tear down both processes and remove the private state.

This gate proves that authority, executable, and resource paths close over the bundle. It does not substitute for full distribution qualification.

## Related

- [Authority boundaries for reloadable local-review URLs](./reloadable-local-review-url-authority-boundaries.md)
- [Atomic generation transitions for rebuilt PDF reviews](./atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Upgrade-safe lifecycle for a shared per-user daemon](./upgrade-safe-shared-per-user-daemon-lifecycle.md)
- [Task-scoped, prompt-refreshed live PDF context](./task-scoped-prompt-refreshed-live-pdf-context.md)
- [Recoverable autosave for editable PDF annotations](./recoverable-editable-pdf-annotation-autosave.md)
- [Portable PDF annotations that remain visible in external viewers](../integration-issues/portable-pdf-annotations-invisible-in-external-viewers.md)
- [Measured semantic collapse for one-row PDF review toolbars](../design-patterns/measured-one-row-responsive-review-toolbar.md)
- [Unified macOS document shell plan](../../plans/2026-09-04-0118-feat-unified-macos-document-shell-plan.md)
- [Web beta operation and release](../../web-beta.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
- [PR #73: Embedded Chrome PDF review](https://github.com/brad-ross/placekeeper/pull/73)
- [PR #75: Front-end-only static PDF review](https://github.com/brad-ross/placekeeper/pull/75)
- [PR #77: Native AppKit document review shell](https://github.com/brad-ross/placekeeper/pull/77)
