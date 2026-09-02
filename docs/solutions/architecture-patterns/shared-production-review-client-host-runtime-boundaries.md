---
title: Shared production review client with host-specific runtime boundaries
date: 2026-09-02
category: architecture-patterns
module: Embedded review runtime
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - The same interactive product client must run in both a browser and an editor webview
  - Hosts differ in transport, resource URLs, lifecycle, presentation persistence, or privileged actions
  - An embedded frame must remain untrusted relative to its extension or local service host
  - Document generations and review revisions can invalidate asynchronous requests and events
  - Adding a host operation should require every route and sanitization decision to remain exhaustive
resolution_type: code_fix
related_components:
  - Review Host Runtime
  - VS Code webview bridge
  - Loopback Review URL
  - Review Runtime Protocol
  - shared production web assets
tags: [host-runtime, vscode-webview, shared-client, typed-rpc, trust-boundaries, transport-adapters, capability-safety, cross-surface-parity]
---

# Shared production review client with host-specific runtime boundaries

## Context

The embedded-review work needed Placekeeper's complete production experience to run both in an ordinary browser and directly inside a VS Code webview. A nested loopback page was not reliable inside VS Code's Electron security model, while opening an external browser broke the source-centered workflow. Building a second VS Code review interface would have duplicated annotations, navigation, reconciliation, save, and export behavior and invited the two products to drift (session history).

The durable seam is the Review Host Runtime. The application depends on one host-neutral bootstrap, command, save, export, SyncTeX, invalidation, and disposal interface, while the runtime identifies whether it is running in a browser or VS Code (`apps/web/src/host/runtime.ts:12`, `apps/web/src/host/runtime.ts:37`). Both entry points converge on `startRuntime`, which renders the same `RuntimeProductionReviewApp` and `ProductionReviewApp` component tree (`apps/web/src/production-entry.tsx:376`, `apps/web/src/production-entry.tsx:388`, `apps/web/src/production-entry.tsx:392`).

The hosts still retain different authority models. The browser runtime uses authenticated HTTP and WebSocket behavior (`apps/web/src/app/session-api.ts:138`, `apps/web/src/host/browser-runtime.ts:24`). The VS Code runtime uses a versioned message bridge and leaves credentials, filesystem paths, source navigation, and resource issuance in the trusted extension host, while the shared client admits only exact host-issued viewer resources (`apps/web/src/host/vscode-runtime.ts:220`, `apps/vscode/src/webview-bridge.ts:91`, `apps/vscode/src/webview-bridge.ts:238`, `apps/web/src/pdf/embedpdf-viewer.ts:32`).

## Guidance

### Share product semantics, not host authority

Keep one production component tree and semantic review model. Hide transport, bootstrap, invalidation delivery, privileged actions, and disposal behind the Review Host Runtime (`apps/web/src/host/runtime.ts:37`). A host can then use its natural transport without creating host-specific product logic.

The browser adapter should remain a direct session client, including its browser-origin resource policy and authenticated control socket (`apps/web/src/host/browser-runtime.ts:21`, `apps/web/src/host/browser-runtime.ts:24`, `apps/web/src/host/browser-runtime.ts:74`). The VS Code adapter should translate the same semantic operations into webview messages and materialize only extension-issued viewer resources (`apps/web/src/host/vscode-runtime.ts:209`, `apps/web/src/host/vscode-runtime.ts:286`). Each adapter exposes only the privileged operations its host supplies; for example, the browser adapter rejects SyncTeX because it has no trusted editor host (`apps/web/src/host/browser-runtime.ts:126`).

### Centralize stable protocol vocabulary

Keep the protocol identity, version, operation names, and shared opaque-identifier guards in one platform-neutral module. The Review Runtime Protocol declares the complete method tuple and derives invoke and broker subsets from it (`packages/core/src/review-runtime-protocol.ts:1`, `packages/core/src/review-runtime-protocol.ts:4`, `packages/core/src/review-runtime-protocol.ts:22`). Both the webview client and the extension bridge consume those constants and types, so a rename or addition becomes a visible contract change instead of two unrelated string edits (`apps/web/src/host/vscode-runtime.ts:3`, `apps/vscode/src/webview-bridge.ts:3`).

Do not interpret membership in the shared method vocabulary as permission to accept an arbitrary payload. The receiving boundary still checks message size, capability-bearing field names, method-specific shapes, numeric bounds, replayed IDs, and the exact panel, session, generation, and revision identity (`apps/vscode/src/webview-bridge.ts:86`, `apps/vscode/src/webview-bridge.ts:91`, `apps/vscode/src/webview-bridge.ts:101`, `apps/vscode/src/webview-bridge.ts:125`). This preserves reuse without weakening the boundary that owns the threat model.

### Make routing and output policy exhaustive

Define broker routing as a record over the derived broker-method union. The exhaustive record forces every brokered operation to receive a deliberate service route (`apps/vscode/src/webview-bridge.ts:359`, `apps/vscode/src/webview-bridge.ts:372`). Sanitize results with an exhaustive switch over the same union so newly added operations also require an explicit output policy (`apps/vscode/src/webview-bridge.ts:287`, `apps/vscode/src/webview-bridge.ts:310`).

This is where privileged data stays out of the webview. The extension removes source roots, local save paths and capabilities, selected folders, and exported paths before returning results (`apps/vscode/src/webview-bridge.ts:270`, `apps/vscode/src/webview-bridge.ts:275`, `apps/vscode/src/webview-bridge.ts:281`, `apps/vscode/src/webview-bridge.ts:304`). Sensitive SyncTeX operations use host-created tokens rather than webview-supplied paths or capabilities (`apps/vscode/src/webview-bridge.ts:91`, `apps/vscode/src/webview-bridge.ts:428`, `apps/vscode/src/webview-bridge.ts:435`).

### Split restoration by ownership

Share only the syntax of the opaque panel key because it crosses the extension, webview shell, and shared client (`packages/core/src/review-runtime-protocol.ts:30`, `packages/core/src/review-runtime-protocol.ts:36`). The extension controller uses that key to recover the PDF binding and ignores presentation fields (`apps/vscode/src/review-panel-controller.ts:60`, `apps/vscode/src/review-panel-controller.ts:94`). The shared client separately validates and restores bounded page and zoom state (`apps/web/src/production-entry.tsx:359`, `apps/web/src/production-entry.tsx:364`, `apps/web/src/production-entry.tsx:469`).

Persist a newly issued panel key before importing the shared application. If the bundle fails during startup, the extension can still restore the panel identity on reload (`apps/vscode/src/review-panel.ts:141`, `apps/vscode/src/review-panel.ts:147`, `apps/vscode/src/review-panel.ts:148`).

### Test agreement and rejection

Pin the protocol identity, version, full method list, method guard, and panel-key syntax in a core contract test (`packages/core/test/review-runtime-protocol.test.ts:11`, `packages/core/test/review-runtime-protocol.test.ts:34`, `packages/core/test/review-runtime-protocol.test.ts:40`). Then test each boundary's distinct responsibilities. The extension suite rejects capability primitives, oversized messages, and replayed IDs (`apps/vscode/test/extension.test.ts:454`, `apps/vscode/test/extension.test.ts:457`, `apps/vscode/test/extension.test.ts:480`), while restoration tests prove opaque-key reattachment and fail-closed handling of malformed or unavailable state (`apps/vscode/test/review-panel-controller.test.ts:69`, `apps/vscode/test/review-panel-controller.test.ts:83`).

Installed-extension verification is also part of the boundary. During implementation, stale bundled web assets repeatedly looked like product regressions even when source tests passed; comparing build and installed hashes and opening a fresh extension window distinguished code defects from stale installation state (session history).

## Why This Matters

One shared client prevents cross-surface drift: annotation, navigation, toolbar, and reconciliation changes flow through the same component tree in both hosts (`apps/web/src/production-entry.tsx:388`, `apps/web/src/production-entry.tsx:392`). At the same time, keeping transport and validation local prevents a superficially elegant abstraction from exposing paths, credentials, or privileged operations to an untrusted frame.

This division was not merely architectural cleanup. The earlier iframe and external-browser approaches each solved only half the workflow, while stale installed assets obscured whether the embedded implementation was actually current. The resulting rule is practical as well as structural: share behavior and the semantic contract, preserve authority at the host boundary, and verify the artifact that users actually run (session history).

Derived method subsets and exhaustive routing make future protocol changes compiler-guided. A new brokered operation is incomplete until it has a canonical name, a boundary-local payload rule, a host route, a result-sanitization decision, and contract and rejection tests.

## When to Apply

- Two hosts should present the same workflow but acquire state and capabilities differently.
- A webview or embedded client is less trusted than its host.
- Protocol additions must fail visibly until routing and redaction decisions are complete.
- Reload restoration spans host identity and UI presentation state with different owners.

Do not apply this pattern by forcing every host through the same physical transport. Also do not move permissive payload interfaces into shared core code merely to reduce line count; stable names and host-neutral semantics are shared, while the boundary that receives untrusted data retains its validation.

## Examples

### Adding a brokered operation

1. Add the operation once to the Review Runtime Protocol method tuple so the invoke and broker unions update (`packages/core/src/review-runtime-protocol.ts:4`, `packages/core/src/review-runtime-protocol.ts:22`).
2. Add an exact payload rule at the receiving trust boundary (`apps/vscode/src/webview-bridge.ts:101`).
3. Add its broker route; the exhaustive record exposes an omission (`apps/vscode/src/webview-bridge.ts:359`).
4. Add a safe-result branch that explicitly decides which fields the webview may observe (`apps/vscode/src/webview-bridge.ts:287`).
5. Extend the canonical contract test and the relevant rejection tests (`packages/core/test/review-runtime-protocol.test.ts:11`, `apps/vscode/test/extension.test.ts:454`).

### Restoring an embedded panel

The host writes an opaque panel key into webview state before importing the application (`apps/vscode/src/review-panel.ts:141`, `apps/vscode/src/review-panel.ts:147`). On reload, the controller validates only that key and resolves it back to a PDF binding (`apps/vscode/src/review-panel-controller.ts:60`, `apps/vscode/src/review-panel-controller.ts:94`). Independently, the shared client validates and restores presentation values and preserves the panel key in later state writes (`apps/web/src/production-entry.tsx:364`, `apps/web/src/production-entry.tsx:468`, `apps/web/src/production-entry.tsx:471`). Authority recovery and visual-position recovery therefore remain separate even though both participate in one reload.

## Related

- [Authority boundaries for reloadable local-review URLs](./reloadable-local-review-url-authority-boundaries.md)
- [Upgrade-safe lifecycle for a shared per-user daemon](./upgrade-safe-shared-per-user-daemon-lifecycle.md)
- [Clean-break application identity migration](./clean-break-application-identity-migration.md)
- [Adaptive annotation tray framing without resizing the PDF viewer](./adaptive-annotation-tray-framing.md)
- [PR #68: Fully embedded VS Code LaTeX review](https://github.com/brad-ross/placekeeper/pull/68)
