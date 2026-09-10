---
title: Authority boundaries for reloadable local-review URLs
date: 2026-08-17
last_updated: 2026-09-10
category: architecture-patterns
module: Reloadable review link lifecycle
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A local document app serves authenticated browser views from readable loopback routes"
  - "A hard refresh must preserve the exact live view and its still-valid agent-task scope"
  - "A replacement daemon can reuse the old origin but must not infer old credentials or task authority from reachability"
  - "Document continuity should preserve only a path and a safe page, portable-item, or normalized author destination"
  - "Copy Link actions sit beside navigation controls and must not change selection, focus correspondence, or reading position"
  - "An extension-hosted review must remain separate from loopback URL authority while sharing the production client"
related_components:
  - "task binding registry"
  - "shared daemon lifecycle"
  - "browser history"
  - "canonical Placekeeper links"
  - "PDF navigation targets"
  - "Copy Link controls"
  - "macOS application bundle"
  - "Chrome MIME handler"
  - "Review Host Runtime"
  - "Chrome native runtime"
  - "Fetch Metadata"
tags:
  - "reloadable-links"
  - "live-resume"
  - "successor-daemon"
  - "task-binding"
  - "capability-scope"
  - "no-durable-state"
  - "pdf-destinations"
  - "non-navigating-actions"
---

# Authority boundaries for reloadable local-review URLs

## Context

Placekeeper needs a browser address that behaves like a normal reading surface: human-readable enough to inspect, refreshable without losing the current page, and useful in Back and Forward history. The underlying review is nevertheless a privileged local session. The design becomes unsafe if “reload this live tab” and “reopen this document later” are treated as the same operation. They carry different authority and therefore need different recovery rules.

The **Loopback Review URL** is the browser projection of one live review. Its pathname contains a random view ID followed by the canonically encoded absolute PDF path, and its fragment carries a page, portable-item, or normalized author destination. The **Placekeeper Link** is the canonical `placekeeper://` document/location address with no live view ID. The shared codec validates absolute PDF paths, canonical segment encoding, versioned fragments, portable item UUIDs, and the fixed arity of supported PDF destination modes; it rejects queries, authorities, traversal, encoded separators, controls, non-canonical numbers, and session-shaped fragment fields (`packages/core/src/placekeeper-link.ts`). The two forms are deliberately related but not interchangeable:

```text
Loopback Review URL
http://127.0.0.1:43179/r/<view-id>/Users/reader/Paper%20One.pdf#v=1&page=12

canonical Placekeeper Link
placekeeper:///Users/reader/Paper%20One.pdf#v=1&page=12
```

The first can resume the exact in-memory browser view while its daemon, review generation, credential, and original Codex scope remain live. The second can ask Placekeeper to open the current file at the encoded semantic location through the normal launch flow. Its exact destination, when present, contains only a one-based fallback page, a supported author view mode, and canonical finite parameters; document generation and live target identity are rebuilt from the newly opened PDF. A stale Loopback Review URL can be projected into the second form after a daemon restart, but it cannot recreate the old live authority by itself. A separately persisted, short-lived two-sided reconnect ticket may restore the task association only after both the path-scoped browser token and the owning Codex task's next prompt independently prove their halves of the relationship.

Earlier iterations first proved same-daemon resume, then clarified that a fixed origin cannot make a successor process the same authority. Persisting old credentials, treating the port as identity, or automatically launching the external protocol from an unauthenticated page load were rejected because each would turn descriptive reachability into authorization (session history).

The user-visible failure also clarified which surface owns recovery. Pasting a canonical `placekeeper:///` URI into Codex's browser address field was treated as navigation or search input, not as an authenticated task launch. A stale same-tab reopen could therefore recover the PDF while still showing no agent-context status. The settled flow keeps recovery on the explicit in-page reopen control and lets the owning task's next prompt provide the independent task-side proof (session history).

Later exact-destination work exposed the same boundary in the interface. Treating every target as exact was not truthful, because Search Results are derived runtime occurrences rather than author metadata. Letting nested Copy Link controls participate in row activation or focus-derived selection styling also made an inactive Outline entry or annotation look selected without moving the document. The settled contract uses exact links only for metadata-backed targets, uses page links otherwise, and keeps successful copying visually quiet and non-navigating (session history).

Several other tempting designs fail the same boundary:

- Keeping `#cap=...` in a readable URL turns copied history into a bearer-capability leak.
- Persisting the old credential, session, task binding, or complete viewer state lets a successor daemon adopt authority it did not establish.
- Automatically opening a filesystem path from an unauthenticated `GET` lets ordinary page loads trigger native UI and file access.
- Encoding selection, search state, open panels, live target identity, or document generation turns a location link into durable viewer state. The typed location is intentionally limited to a coarse page, a portable item with page fallback, or normalized PDF-authored destination semantics with page fallback (`packages/core/src/placekeeper-link.ts`).

An earlier Chrome PDF handoff exposed two more forms of the same mistake. Navigating with `window.location.replace` from a MIME-handler child frame targeted the frame rather than the tab that owned the PDF, producing Chrome's blocked-page outcome. Moving that navigation to the owning tab then reached the loopback bootstrap as `Sec-Fetch-Site: cross-site`, so the otherwise-correct generic Fetch Metadata guard rejected it before routing (session history). That redirect architecture is now historical: the production handler preserves the original PDF URL, mounts the shared client inside the extension document, and reaches service-owned review state through a separate native runtime. The extension contract explicitly prevents both `chrome.tabs.update` and `window.location.replace` from returning to the production path (`apps/chrome-extension/test/extension-contract.test.ts`).

Current ownership: `apps/service/src/sessions/presentation-records.ts` stores process-local view and launch metadata. `SessionBroker` authorizes resume and reconnection and owns credentials, task bindings, and ticket persistence. `recovery-decisions.ts` stores bounded offers and decision records; the broker applies them.

## Guidance

### Separate live resume from successor reopen

Implement two explicit paths.

**Live resume** restores the exact live projection. The initial bootstrap consumes a one-time capability, creates a browser credential, random view ID, random view cookie, exact readable pathname, and initial semantic fragment (`apps/service/src/sessions/session-broker.ts`). The bootstrap response sets the cookie, then `location.replace` scrubs the capability by navigating to the cap-free readable route (`apps/service/src/server/http-server.ts`). Reloading that route posts its exact pathname to `/r/<view-id>/resume`; the daemon matches view ID, pathname, cookie hash, active session, document generation, and credential before returning the same in-memory session credential (`apps/service/src/server/http-server.ts`, `apps/service/src/sessions/session-broker.ts`). This is resume, not reconstruction.

**Post-restart reopen** restores only document identity and safe semantic location. A successor daemon has no matching view record, so it serves an inert terminal shell derived from strict route parsing, clears the stale cookie, and offers a canonical `placekeeper:` fallback anchor (`apps/service/src/server/http-server.ts`). Client code preserves any fragment accepted by the shared page/item/destination codec and falls back to page 1 for malformed or future fragments; it renders a filename-led `Reopen <filename>` page with **Copy Link** and one primary **Reopen** action, but invokes nothing on load (`apps/web/src/production-entry.tsx`). Only the user's click initiates recovery.

The successor must never upgrade a stale route into a session on page load. Its recovery parser performs no filesystem access; it only decodes descriptive path data and constructs the canonical app-link base (`apps/service/src/links/placekeeper-link.ts`). In the normal JavaScript-enabled same-tab flow, **Reopen** is itself the user confirmation boundary: the click sends `confirmed: true` through the same-origin `POST /r/<view-id>/reopen`, and the ordinary no-draft response navigates directly to the fresh session without a second open button (`apps/web/src/production-entry.tsx`, `apps/web/src/app/session-api.ts`). Direct use of the fallback `placekeeper:` anchor instead goes through the native launcher's confirmation (`packaging/macos/launcher.mjs`). In either path, confirmation is rechecked immediately before the first linked-file operation, the path is canonicalized, a readable regular `.pdf` with a `%PDF-` header is verified, and the successor opens it with `surface: "browser"` (`apps/service/src/server/http-server.ts`, `apps/service/src/links/placekeeper-link.ts`).

Consequently, a successor reopen always creates a fresh browser view and credential. The stale URL itself recovers no prior browser credential, task ID, document generation, or unsaved viewer state; it contributes only path and location. If the old view was Codex-bound, an additional opaque `HttpOnly` token scoped to that exact `/r/<view-id>/` path can match a private restart ticket containing only hashes. The successor stages that browser half after the explicit reopen and normal file confirmation, but keeps it browser-scoped until the owning task's next `UserPromptSubmit` supplies the other half. A foreign task, copied URL, missing cookie, expired ticket, different path, or changed source digest cannot attach it. If Placekeeper separately finds a durable review draft for that PDF, the normal open flow may offer an explicit recovery choice that restores the draft's persisted session identity and review state.

Keep the recovery page's presentation subordinate to this lifecycle. The ordinary state uses the app's Compact Editorial header/body/footer and icon-button grammar, hides empty status and action regions, and fits its explanation content; a real protected-draft offer expands the same body into **Resume draft**, **Discard draft**, and **Open separate copy** (`apps/web/src/app/review-layout.css`, `apps/web/src/production-entry.tsx`). Appearance never creates authority: the service issues the exact offer, and the browser reuses one operation ID only for retries of the same choice (`apps/web/src/production-entry.tsx`, `test/acceptance/reloadable-links.spec.ts`). [Compact Editorial language for modal and recovery surfaces](../design-patterns/compact-editorial-language-for-annotation-modals.md) owns the presentation grammar.

### Make refresh authority projection-scoped

Treat the view ID as a non-secret selector and the cookie plus daemon record as the refresh authority for that one projection. The cookie is host-only, `HttpOnly`, `SameSite=Strict`, and path-scoped to `/r/<view-id>/`; the server stores only its digest alongside the exact pathname, session, generation, and browser credential (`apps/service/src/server/http-server.ts`, `apps/service/src/sessions/session-broker.ts`). The readable pathname itself contains no capability or credential. Public shell and application assets may be served without review authority, but document, state, scope, mutation, and control requests still require the resumed bearer credential (`apps/web/src/app/session-api.ts`, `apps/service/test/session-security.test.ts`).

Keep the authority in memory. `SessionCredentialStore` holds bootstrap and credential records in process-local maps, consumes bootstrap capabilities once, and supports session-wide revocation (`packages/core/src/session-security.ts`). Revoking a view deletes its record, revokes its credential, and removes its launch scope (`apps/service/src/sessions/session-broker.ts`). Daemon exit therefore destroys live-resume authority by construction; no state migration is needed or wanted.

Apply loopback request protections independently of the view cookie. The server accepts only loopback peers, the exact numeric-loopback Host, no forwarding headers, and same-origin mutation requests (`packages/core/src/session-security.ts`). Numeric `127.0.0.1` is intentional: `localhost` aliases are rejected even with an otherwise valid cookie (`apps/service/test/session-security.test.ts`).

The fixed production port is only a reachability contract. The packaged daemon binds `127.0.0.1:43179`, and production configuration does not accept an environment-selected port (`apps/service/src/server/http-server.ts`, `apps/service/src/host/service-daemon.ts`). A replacement daemon can therefore answer the same literal URL, but the old URL remains unauthorized unless that same live daemon still owns its exact view record. If no daemon is listening, refresh can fail normally until Placekeeper is started; stable origin does not imply an always-running or durable session.

### Keep extension-owned presentations outside loopback URL authority

The Chrome MIME handler is a different presentation host, not another way to enter a Loopback Review URL. Treat `chrome.mimeHandler.getStreamInfo()` as runtime-untrusted input. Require non-empty stream and original URLs, a safe non-negative integer `tabId`, and the literal `embedded === false` before claiming the top-level PDF response (`apps/chrome-extension/src/handler-controller.ts`). Invalid, embedded, opted-out, or pre-activation failure states fall back to Chrome's viewer exactly once (`apps/chrome-extension/src/handler-controller.ts`). The validated `tabId` proves presentation scope; it is no longer tab-navigation authority.

Keep the original tab URL and mount the packaged shared client directly in the handler document. The handler opens a versioned native runtime, transfers or requests the PDF bytes, validates the projected length, digest, and PDF signature, creates an extension-owned Blob, and supplies packaged PDFium resources before the shared client sees the document (`apps/chrome-extension/src/chrome-runtime.ts`). It waits for the shared viewer's document-ready signal before activating the service-owned presentation (`apps/chrome-extension/src/handler-entry.ts`). The manifest grants no host permissions, and its content policy keeps scripts, workers, and connections on the extension origin (`apps/chrome-extension/manifest.json`).

The safe sequence is therefore:

```text
MIME handler receives stream context
  -> validate that it owns a top-level PDF response
  -> negotiate the constrained native runtime
  -> acquire and verify the exact PDF bytes
  -> compose an extension Blob plus packaged viewer resources
  -> mount the shared production client in the original tab
  -> activate only after document readiness
```

Before activation, release provisional state and fall back to Chrome once. After activation, never navigate into the loopback bootstrap or silently abandon protected work; disconnect and version-skew states remain inside Placekeeper for explicit reconnection or recovery (`apps/chrome-extension/src/handler-controller.ts`). The native host still recognizes the older one-shot handoff protocol for installed-version compatibility, but negotiated protocol v2 is the current long-lived runtime (`apps/service/src/browser/chrome-native-host.ts`). Compatibility code is not the presentation contract.

The narrow cross-site exception on `/s/<UUID>/bootstrap` remains part of the Loopback Review URL path, not a grant to the extension host. The HTTP server opts in only that exact read-only bootstrap `GET`; mutations and exchanges retain same-origin enforcement (`apps/service/src/server/http-server.ts`, `packages/core/src/session-security.ts`). Do not collapse the two host models into one broad “extension is trusted” exception. The extension owns one intercepted response and one presentation lease; it receives neither loopback browser credentials nor ambient authority over task bindings, filesystem paths, or document state. [Shared production review client with host-specific runtime boundaries](shared-production-review-client-host-runtime-boundaries.md) owns the full embedded-host architecture.

### Reattach Codex scope only through two independent proofs

Codex binding is part of the initial live launch, not something inferable from a PDF path or open tab. A Codex launch issues a bind proof keyed to the review generation and browser capability; the task hook must claim it before the matching authenticated bootstrap activates the binding (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/context/task-binding-registry.ts`). The browser credential retains the original launch scope, and scope polling renews only the active review whose browser-capability discriminator matches that credential (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/context/task-binding-registry.ts`). Because live refresh returns the same credential, the same task binding can remain visible after a hard reload. A later view for another task cannot borrow that projection's scope, and an ordinary browser view has no `codexContext` (`apps/service/test/live-context-service.test.ts`).

Do not call browser activation “context current.” Activation proves the task/review/browser correlation. The next `UserPromptSubmit` hook requests a fresh projection, emits it into that prompt, and acknowledges its cursor only after output succeeds (`apps/service/src/cli/hook-command.ts`). Until a prompt-time observation matches the live revision and digests, browser status is `refreshing`; only a verified match is `current` (`apps/service/src/context/task-binding-registry.ts`, `apps/service/src/context/live-context-service.ts`). This is why a freshly activated or recently edited Codex view may truthfully show “updating” even though its connection is valid.

A successor reopen must not reproduce this handshake from the path. It launches with `surface: "browser"` and stays there until the successor matches a short-lived browser reconnect token against the same canonical path and source digest, then independently receives the owning task ID from the next prompt hook. Only that exact two-sided match creates a new task binding for the new review generation and promotes the authenticated successor credential to Codex scope. The ticket is consumed and rotated after success; task/session revocation removes it. Never persist or copy the previous task ID, bind proof, browser capability hash, credential, session ID, or viewer state into restart recovery.

Treat browser staging as advisory, not as final authorization. Immediately before attachment, atomically re-read and consume the exact current ticket so revocation, replacement, expiry, or a duplicate attempt wins over a stale in-memory copy (`apps/service/src/context/restart-reconnect-store.ts`, `apps/service/src/sessions/session-broker.ts`). If the owning prompt arrives just before the successor browser finishes exchanging its bootstrap capability, wait only for that exact capability's authenticated exchange; do not report unavailable prematurely or accept a different browser (`apps/service/src/sessions/session-broker.ts`). While this handshake is pending, the scope response reveals only `reconnectPending: true`, never a task identity, and the mounted page polls until the fresh credential is promoted in place (`apps/service/src/sessions/session-broker.ts`, `apps/web/src/app/ProductionReviewApp.tsx`).

### Use fragments for semantic location, not server state

Keep page, saved portable-item, and normalized PDF-author destinations in `location.hash`. Fragments are client-side, so moving through a document does not expand server routes or disclose credentials in requests. The additive grammar keeps `#v=1&page=<one-based-page>` with optional `&item=<portable-uuid>` byte-compatible, and reserves `#v=2&page=<one-based-page>&mode=<supported-mode>` with mode-specific canonical `params` for exact author destinations (`packages/core/src/placekeeper-link.ts`). The v2 page is always a coarse fallback, not a second competing destination.

Project only generation-free semantics into the fragment. A live `PdfNavigationTarget` is accepted only when its document generation, page bounds, normalized zoom, and target identity match the active PDF. Supported author modes become exact destinations; unknown author views truthfully become page links. Reopening reverses that projection by rebuilding a fresh target under the current document generation (`apps/web/src/pdf/pdf-navigation-target.ts`). Outline entries and embedded PDF links use this shared target projection, while Search Results intentionally remain page-only because they do not carry durable author identity (`apps/web/src/review/row-link-actions.ts`).

Restore through the navigation coordinator, not directly from a surface. It first attempts the current-generation exact target; if exact restoration is unavailable, it replaces the fragment with a verified page fallback and announces the loss of precision (`apps/web/src/review/navigation-coordinator.ts`). When a portable item is unavailable, navigation similarly falls back to its page. Malformed fragments converge safely to page 1.

Use browser history according to semantic intent. Settled ordinary reading—scrolling, sequential page changes, or reflow—updates the current fragment with `history.replaceState`, so it does not create a stop for every viewer signal (`apps/web/src/review/review-location-history.ts`, `apps/web/src/review/navigation-coordinator.ts`). A **Meaningful Jump**, such as an explicit outline, annotation, search, or promoted-reference destination, uses `pushState` once through the navigation coordinator (`apps/web/src/review/navigation-coordinator.ts`). Back and Forward then restore semantic locations without pretending that zoom or panel layout is bookmark-worthy state.

### Make Copy Link a quiet projection, not row activation

Expose one shared Copy Link command, but keep target derivation and surface navigation separate. Outline and Search render the navigable content and its adjacent copy action as sibling controls; annotations likewise keep navigation on the content button. Copying therefore does not scroll, select the row, update correspondence, or create a Meaningful Jump. The shared command deduplicates pending clipboard writes and owns the success/failure lifecycle (`apps/web/src/review/CopyLinkControl.tsx`).

Use the same chain-link icon and target-specific Copy Link accessible names across shared viewer surfaces, but do not turn success into a visible tooltip or popup. Enabled Copy Link controls intentionally omit `title`; success is exposed through a screen-reader-only status, while clipboard failure remains visible and retryable (`apps/web/src/review/CopyLinkControl.tsx`). After successful pointer activation in row or annotation contexts, release transient focus so inactive contextual actions disappear again; keyboard activation retains focus for predictable keyboard operation (`apps/web/src/review/CopyLinkControl.tsx`). In an embedded-link action popover, successful copy dismisses the popover; failure leaves it available (`apps/web/src/review/LinkActionPopover.tsx`).

Selection styling must represent navigation state, not nested-action focus. Active Outline and annotation rows remain blue on hover, while inactive rows may use neutral hover feedback. A Copy Link press on an inactive row must not flash the active border or leave its action group disclosed. Browser acceptance should assert pointer and keyboard behavior separately because their intended focus outcomes differ (session history).

### Test each layer of the contract

No one test level proves the whole pattern.

- **Chrome embedded-host units and installed proof:** controller tests require document readiness before activation, release provisional state before one-shot fallback, preserve protected work after activation, and reject malformed or embedded stream contexts (`apps/chrome-extension/test/handler-controller.test.ts`). Static contracts require the packaged shared client and forbid both tab replacement and frame-local navigation on the production path (`apps/chrome-extension/test/extension-contract.test.ts`). Runtime tests cover single-use stream consumption, byte and projection validation, recovery choice, lifecycle ordering, protocol skew, native-host absence, and sleep-aware deadlines (`apps/chrome-extension/test/chrome-runtime.test.ts`). Installed Chrome must additionally prove that the original URL survives, the document title is applied, the packaged PDFium worker starts without forbidden authority, and navigation lifecycle cases join the expected review (`test/acceptance/installed-chrome.ts`).

- **Codec and history units:** `Placekeeper link codec` proves special-character and Unicode path round trips, strict readable-route parsing, byte-compatible v1 fragments, canonical fixed-arity v2 destinations, and rejection of authority-bearing or session-like fields (`packages/core/test/placekeeper-link.test.ts`). `browser review location history` proves replace-versus-push behavior, Back/Forward restoration, reload in the middle of history, and malformed-fragment convergence (`apps/web/test/review-location-history.test.ts`).
- **HTTP and security integration:** `resumes a live readable view repeatedly with only its scoped HttpOnly cookie` proves repeated exact resume, missing or wrong cookie denial, path and origin binding, revocation, cookie clearing, inert unknown-view recovery, and the absence of automatic fetch or redirect behavior (`apps/service/test/session-security.test.ts`). `exchanges the fragment once, scrubs it before protected assets, and scopes all bytes` proves one-time capability exchange and bearer-gated document access (`apps/service/test/session-security.test.ts`).
- **Real browser acceptance:** `a live Codex review copies a browser-safe URL, survives refresh, and reopens in place` proves the cap-free URL, repeated hard reload, Meaningful Jump history, canonical copy-link output, and the ended-session terminal screen (`test/acceptance/reloadable-links.spec.ts`). `copies canonical PDF destinations and reopens them without source UI state` proves exact Outline and embedded-link equivalence, page-only Outline and Search fallback, canonical reopen, Back/Forward replay, and truthful exact-to-page downgrade (`test/acceptance/reloadable-links.spec.ts`). `a successor daemon keeps the old origin but serves a stale view as inert click-only recovery` proves same-origin reuse without resume, task API calls, automatic external-protocol launch, or stale cookies; it also measures the content-fitting ordinary body and footer and proves the one-click no-draft path (`test/acceptance/reloadable-links.spec.ts`). The protected-draft successor flow proves conditional growth, exact choice consequences, retry-stable operation IDs, stale-offer rediscovery, and draft preservation (`test/acceptance/reloadable-links.spec.ts`); the touch flow proves narrow/short containment and controls of at least 44 pixels (`test/acceptance/reloadable-links.spec.ts`).
- **Interaction acceptance:** `settles tray copy actions without selection or tooltip flashes` proves that enabled Copy Link controls have no native tooltip, pointer copy neither selects nor outlines an inactive annotation or Outline row, pointer success releases the action focus, active rows keep their selection color on hover, and keyboard activation retains focus (`test/acceptance/production-flow.spec.ts`). The real embedded-link flow proves pending-write deduplication, successful dismissal with focus return, visible clipboard failure, and successful Retry (`test/acceptance/production-flow.spec.ts`).
- **Codex lifecycle and mounted-browser acceptance:** `binds the exact launch, activates in the browser, refreshes deltas, gates evidence, and revokes at task end` proves the exact claim/bootstrap handshake, repeated readable-view resume with the same credential, Codex scope, prompt-time full/unchanged/delta delivery, and task-end revocation (`apps/service/test/codex-live-context.integration.test.ts`). `keeps mounted Codex context through refresh, then fails closed on a hung scope poll` proves that a production browser reload preserves the readable path, page 3, and current connected-agent status, then degrades to connecting and unavailable when scope refresh stops succeeding (`test/acceptance/production-flow.spec.ts`).
- **Restart reattachment acceptance:** the live-context integration flow proves missing-token and foreign-task denial, browser-only pending scope, prompt-before-bootstrap ordering, fresh-credential promotion, and current context delivery in the owning prompt (`apps/service/test/codex-live-context.integration.test.ts`). Restart-store units separately prove exact-ticket one-time consumption and stale-copy rejection (`apps/service/test/restart-reconnect-store.test.ts`). `a pending restarted browser is promoted to Codex without remounting` proves that the same mounted successor page begins without agent context, then observes the promoted scope in place (`test/acceptance/reloadable-links.spec.ts`).
- **Installed lifecycle smoke:** the packaged smoke proves the canonical-link confirmation gate, stable-origin and page-location propagation, and absence of Codex authority in an ordinary link-opened view (`packaging/macos/smoke-installed.ts`). After a real replacement it proves that the origin remains stable while the old readable URL becomes inert recovery rather than a resurrected session (`packaging/macos/smoke-installed.ts`).

## Why This Matters

This separation gives users familiar browser behavior without making a local URL a durable bearer token. A reader can refresh an active tab, bookmark or copy a human-readable PDF location, reopen an author-defined destination at its supported precision, jump to a page or saved annotation, use Back and Forward for deliberate navigation, and recover a stale tab after an application restart. At the same time, every stronger claim remains explicit:

- the Loopback Review URL identifies a projection, not a durable document or task;
- the view cookie authorizes refresh only for the exact live projection;
- the in-memory browser credential authorizes review APIs only while the owning daemon and session remain live;
- the original Codex binding survives only because live resume recovers the exact credential and launch scope;
- the Placekeeper Link carries only a local path and generation-free semantic location;
- an exact destination retains a truthful page fallback and is rehydrated only against the current PDF generation;
- copying that destination is a utility action and does not imply that the source row was selected or opened;
- successor recovery requires a user gesture and normal file confirmation, creates a fresh browser credential, and can regain Codex scope only through the separate browser-token-plus-next-prompt handshake.
- an extension-hosted PDF preserves its original URL and reaches the same review semantics through a separate, capability-scoped host runtime rather than inheriting loopback credentials.

Without this model, convenience features quietly widen authority. A copied URL could leak a capability; a replacement daemon could impersonate an old task; a public `GET` could touch the filesystem or launch native UI; or a fixed port could be mistaken for a trusted process identity. Conversely, refusing every reload would discard useful browser affordances even though exact, view-scoped in-memory authorization makes live resume safe.

The model also keeps durability honest. The absolute path and semantic fragment are durable references only in the limited sense that they can be parsed later. They do not guarantee that the file still exists, that it is unchanged, that the portable item still exists, or that unsaved viewer state survives. Those questions are resolved by the normal open, PDF validation, item fallback, and separate review-draft recovery systems—not by the URL.

## When to Apply

Apply this pattern when a local desktop application:

- serves privileged live state through a browser on loopback;
- wants refreshable, inspectable URLs without exposing bearer material;
- needs copied document locations to outlive one browser bootstrap but not to carry session authority;
- exposes authored Outline or embedded-link destinations alongside derived Search Results or portable annotations;
- places Copy Link beside controls whose primary action navigates or selects;
- can restart or upgrade its local daemon while old tabs remain open;
- binds some live views to an agent task or another external owner;
- has a small semantic location model that can be restored independently of full viewer state.
- embeds the same product client in another host without treating that presentation as a loopback browser view.

Do not use successor reopen as transparent session migration. If exact unsaved UI restoration across process replacement is a product requirement, it needs a separate durable-state design, versioning, migration, confidentiality, and authority model. Do not reuse this pattern for remotely reachable hosts: an absolute local path in a readable URL is sensitive, and loopback Host/Origin enforcement is part of the trust boundary. A Placekeeper Link is capability-free, but it still reveals the local filename and directory structure to anyone who receives it.

## Examples

### Live hard refresh of a Codex-connected review

```text
Codex launch
  -> one-time bootstrap capability + bind proof
task hook claims bind proof
browser exchanges matching capability
  -> random view ID
  -> HttpOnly /r/<view-id>/ cookie
  -> browser credential and original Codex launch scope in daemon memory
  -> location.replace(cap-free readable route)

hard refresh on #v=1&page=12
  -> GET exact readable route
  -> POST /r/<view-id>/resume with scoped cookie and exact pathname
  -> same session credential returned
  -> same PDF opens at page 12
  -> same Codex scope polls as refreshing/current

next Codex prompt
  -> fresh atomic context projected and emitted
  -> delivery cursor acknowledged
  -> matching browser status is current
```

The reload preserves the live binding because it resumes the same projection. The URL alone is insufficient; copying it to a context without the scoped cookie cannot authenticate the view.

### Refresh after daemon replacement

```text
old tab still contains
  http://127.0.0.1:43179/r/<old-view>/.../Paper.pdf#v=1&page=12

replacement daemon answers the fixed origin
  -> strict pathname parse only
  -> no matching in-memory view
  -> clear stale /r/<old-view>/ cookie
  -> show inert Reopen Paper.pdf page
  -> preserve safe page/item fragment

user clicks Reopen
  -> that explicit POST is the unfamiliar-path confirmation boundary
  -> canonicalize and verify current PDF
  -> if protected work exists, offer Resume draft / Discard draft / Open separate copy
  -> require the exact bounded offer plus an idempotent operation ID for that choice
  -> normal browser launch
  -> fresh view ID, cookie, session credential
  -> browser-scoped review at page 12

if the old review carried a valid restart ticket
  -> path-scoped opaque browser token matches path + source digest
  -> successor stages a pending reconnect without a task ID

next prompt in the owning Codex task
  -> hook supplies the real task session ID
  -> both halves match, ticket is consumed and rotated
  -> fresh credential is promoted to Codex scope
  -> current PDF context is emitted in that same prompt
```

The new daemon reuses the origin so the literal tab becomes reachable; it does not reuse the old credential or infer ownership from the route. If Placekeeper is stopped, the first refresh may still show the browser's connection error. Starting Placekeeper and refreshing again reaches the inert recovery screen.

### Meaningful Jump versus ordinary reading

```text
scroll from page 4 into page 5
  -> replace current fragment with #v=1&page=5
  -> no new Back stop

activate saved annotation on page 12
  -> push #v=1&page=12&item=<portable-id>
  -> Back returns to page 5

restart and reopen from that link
  -> restore the portable item when present
  -> otherwise restore page 12
  -> never restore zoom, selection, search, trays, or old task scope
```

### Exact author destination without session authority

```text
Outline or embedded PDF link resolves to an author destination
  -> classify it without navigation
  -> verify active document generation, page bounds, mode, and parameters
  -> project only the generation-free destination
  -> copy placekeeper:///.../Paper.pdf#v=2&page=3&mode=xyz&params=72,144,1.5

open the copied link later
  -> run the normal path confirmation and PDF-open flow
  -> create a fresh browser view and credential
  -> rebuild the target under the current document generation
  -> apply the exact destination when available
  -> otherwise replace it with the verified page 3 fallback
  -> never inherit the source task binding, selected row, tray, or popover
```

Search does not manufacture a v2 destination from its transient match geometry. It copies a v1 page link because page is the highest durable precision available from that source.

### Copy from an inactive Outline or annotation row

```text
pointer presses the adjacent chain-link action
  -> copy the row's already-derived Placekeeper Link
  -> do not invoke the row's navigation callback
  -> do not mark the row current or corresponding
  -> announce success only to assistive technology
  -> release transient pointer focus so inactive actions hide again

keyboard activates the same action
  -> perform the same non-navigating copy
  -> retain focus for continued keyboard operation

embedded-link popover copy succeeds
  -> dismiss the popover and restore focus to its opener
clipboard write fails
  -> keep the fallback link and Retry available
```

## Related

- [PR #41: durable links and compact action controls](https://github.com/brad-ross/placekeeper/pull/41) extended this contract with exact PDF destinations and non-navigating Copy Link interactions.
- [PR #73: embedded Chrome PDF review](https://github.com/brad-ross/placekeeper/pull/73) replaced the normal Chrome-to-loopback redirect with an extension-hosted presentation and capability-scoped native runtime.
- [Shared production review client with host-specific runtime boundaries](shared-production-review-client-host-runtime-boundaries.md) defines the semantic client contract and per-host authority boundaries now used by browser, VS Code, and Chrome.
- [Task-scoped, prompt-refreshed live PDF context](task-scoped-prompt-refreshed-live-pdf-context.md) defines the exact task/browser-capability binding that a same-daemon live resume may preserve and a successor reopen must not infer from the route; verified restart proofs may establish a fresh binding.
- [Upgrade-safe lifecycle for a shared per-user daemon](upgrade-safe-shared-per-user-daemon-lifecycle.md) explains why review sessions, credentials, and task leases remain process-local through replacement.
- [Truthful compact status for live agent context](../design-patterns/truthful-compact-agent-context-status.md) projects the same fail-closed ownership distinction into browser chrome.
- [Content-aware annotation workspace presentation](../design-patterns/outline-aware-annotation-workspace-presentation.md) defines the neighboring active-row, workspace projection, and responsive presentation rules that Copy Link must not disturb.
- [Native control tooltip contract for the PDF review interface](../conventions/native-control-tooltip-contract.md) documents the broader compact-control tooltip convention; enabled Copy Link controls are a deliberate exception because their visible success tooltip was misleading.
- [Preserve document history for Annotation Tray navigation](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) covers the in-view Meaningful Jump transaction semantics that browser fragment history projects into the address bar.
