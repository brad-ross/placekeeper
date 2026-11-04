---
title: Shared production review client with host-specific runtime boundaries
date: 2026-09-02
last_updated: 2026-11-03
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
  - Electron desktop window shell
  - Mac Review Helper
  - Desktop app lifecycle control
  - production desktop packaging
  - Browser Document Session
  - Loopback Review URL
  - shared production web assets
tags: [host-runtime, shared-client, electron-desktop, sandbox, preload, canonical-review, attempt-fencing, capability-safety]
---

# Shared production review client with host-specific runtime boundaries

## Current architecture

Placekeeper has one production review client and one canonical local service. The sole desktop application is Electron on macOS, Windows, and Linux, under the production name **Placekeeper**. The Swift/AppKit host is retired. Browser, VS Code, Chrome, Codex, Electron, and static hosts adapt the same review semantics without acquiring the same authority.

`apps/web/src/host/runtime.ts` defines the host contract. `RuntimeProductionReviewApp` and `ProductionReviewApp` compose the shared interface. Browser HTTP/WebSocket, VS Code webview messages, Chrome native messaging, Codex admission, and Electron preload IPC remain distinct transports. Static mode explicitly supplies export-only persistence and cannot acquire filesystem, durable session, or SyncTeX authority.

## Desktop boundary

Electron main owns OS windows, menus, source-configuration dialogs, lifecycle, and native actions (`apps/electron/src/main.ts`, `menus.ts`). The sandboxed renderer has no Node globals. Its preload exposes a narrow bridge; IPC validates the sending frame, current window, and attempt (`apps/electron/src/preload.ts`, `review-bridge.ts`). A desktop window is a projection of a service review, not a second review authority.

The service owns canonical identity, generation/revision checks, authoring, durable recovery, saves, task bindings, and SyncTeX associations. A cache in a presentation must not veto a valid request merely because it lags the authoritative state. Forward the initiating request's identity and revision, reject known-stale requests, and retain canonical checks at the service. Replies must correlate with the request being settled, even when their payload contains newer state.

Assets and document bytes use separate constrained protocols (`apps/electron/src/resource-protocol.ts`). Require manifest membership and realpath containment for packaged assets. Bound document reads to the admitted role and generation, check length and digest, and adopt the resource before recording its validated generation. Renderer loading alone does not authorize activation: current document readiness and visible paint must agree.

Keep native affordances as projections of shared meaning. The shared command surface defines product operations and enabled state; Electron menus dispatch those operations rather than reimplementing annotation or save logic. Window controls and titlebar drag regions must leave interactive web controls usable. Browser layout tests alone cannot qualify native dragging, dialogs, fullscreen, accessibility, or OS integration.

## Packaging and runtime identity

`packaging/desktop/build.ts` stages the production app's independent pinned Node executable, service entry, shared web assets, launchers, and manifest. The service does not run through Electron's embedded Node. `packaging/desktop/launcher.mjs` verifies the installation before invoking that runtime; it must not fall back to system Node or a checkout.

Build distributions with `pnpm package:desktop`. Install source with `install.sh` on macOS/Linux or `install.ps1` on Windows. All platforms package the CLI under `resources/desktop/bin`; macOS uses `Contents/Resources/desktop/bin` and retains the external `Contents/MacOS/placekeeper` compatibility path. Product identity is Placekeeper; an internal GUI binary name does not change that identity.

The daemon is shared per user. Exact identity permits reuse; incompatible or uninspectable listeners require the lifecycle protocol rather than an alternate writer root or automatic kill. Replacement must defer for active work, back up compatible recovery, prove retirement, and require exact candidate readiness. See [shared-daemon lifecycle](upgrade-safe-shared-per-user-daemon-lifecycle.md).

## Cross-platform source navigation

Editor profiles and registrations belong to the service. The installed `editor add`, `editor register`, and `forward-search` commands establish an explicit return editor and approved source root. Electron presents forward navigation and returns inverse requests through that association. Direct PDF opens may choose an editor and source folder through **Review → Configure Source Navigation…**. Command-click on macOS or Ctrl-click on Windows/Linux requests the corresponding source location; **Review → Go to Source** supplies a menu/keyboard route.

Mapping requires a native TeX `synctex` query executable and matching PDF/mapping generation. Neither a renderer nor an editor can substitute a guessed source root or take over another association through background refresh. See the [editor guide](../../guides/editor-synctex.md).

## Evidence and historical lessons

The final native run passed all 12 installed checks on macOS arm64, macOS Intel, Linux, and Windows. The canonical unit/integration suite passed all 2,184 tests and typechecking. These automated checks qualify their recorded CI hosts; interactive OS workflows remain separately bounded. A complete browser rerun has not passed, and the compact Reference action remains unresolved. See the [qualification record](../../testing/electron-migration-qualification.md) for exact artifacts, retries, baseline comparisons, and remaining limits. Installed SyncTeX acceptance uses genuine compiler output and a real recording-editor child process. Process delivery does not prove named-editor UI placement, and CDP cannot qualify native source dialogs.

The historical Electron spike measured a 275 MB bundle and roughly 474–551 MB aggregate working set while still requiring a daemon (`apps/electron-spike/RESULTS.md`). Those measurements describe the spike, not the current production app. The former AppKit implementation then demonstrated a shared React client with a native window shell. Its Swift bridges, WKWebView resource handlers, native candidate builders, and titlebar geometry tests are retired implementation evidence, not current build instructions.

Two lessons survive that implementation change. First, canonical state must outlive disposable tabs, windows, helpers, and transport connections; replay journals, generation fences, and recovery belong with the service. Second, an asynchronous presentation cache must not replace request correlation or canonical revision checks. Historical AppKit tests reproduced a successful mutation followed by a rejected request when the bridge cache lagged; forwarding the initiating revision while retaining service checks resolved that race.

Chrome supplied a related identity lesson: navigation-entry IDs and handler attachment tokens change on reload, so they cannot establish canonical continuity. Service identity and authenticated presentation leases must make that decision. Local interactive leases also need sleep-aware timer handling; a delayed callback after laptop sleep must not falsely retire an active connection.

Evidence belongs to the artifact and platform tested. Preserve prior candidate reports and numeric results, but do not reuse a historical pass to approve changed production installation, source navigation, or host registrations. Installation does not itself select an OS default PDF handler.

## Related

- [Reloadable local-review URL authority](reloadable-local-review-url-authority-boundaries.md)
- [Atomic rebuilt-PDF transitions](atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Recoverable annotation autosave](recoverable-editable-pdf-annotation-autosave.md)
- [Task-scoped live PDF context](task-scoped-prompt-refreshed-live-pdf-context.md)
- [Current installation](../../installation.md)
- [Historical unified macOS shell plan](../../plans/2026-09-04-0118-feat-unified-macos-document-shell-plan.md)
