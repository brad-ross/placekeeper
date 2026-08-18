---
title: Authority boundaries for reloadable local-review URLs
date: 2026-08-17
category: architecture-patterns
module: Reloadable review link lifecycle
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A local document app serves authenticated browser views from readable loopback routes"
  - "A hard refresh must preserve the exact live view and its still-valid agent-task scope"
  - "A replacement daemon can reuse the old origin but must not inherit old credentials or task authority"
  - "Document continuity should preserve only a path and safe page or portable-item location"
  - "Durable viewer state, session registries, and always-running background services are intentionally out of scope"
related_components:
  - "task binding registry"
  - "shared daemon lifecycle"
  - "browser history"
  - "canonical Placekeeper links"
  - "macOS application bundle"
tags:
  - "reloadable-links"
  - "loopback-review"
  - "live-resume"
  - "successor-daemon"
  - "task-binding"
  - "capability-scope"
  - "fragment-history"
  - "no-durable-state"
---

# Authority boundaries for reloadable local-review URLs

## Context

Placekeeper needs a browser address that behaves like a normal reading surface: human-readable enough to inspect, refreshable without losing the current page, and useful in Back and Forward history. The underlying review is nevertheless a privileged local session. The design becomes unsafe if “reload this live tab” and “reopen this document later” are treated as the same operation. They carry different authority and therefore need different recovery rules.

The **Loopback Review URL** is the browser projection of one live review. Its pathname contains a random view ID followed by the canonically encoded absolute PDF path, and its fragment carries a page or portable-item location. The **Placekeeper Link** is the canonical `placekeeper://` document/location address with no live view ID. The shared codec validates absolute PDF paths, canonical segment encoding, versioned page fragments, and portable item UUIDs; it rejects queries, authorities, traversal, encoded separators, controls, and session-shaped fragment fields (`packages/core/src/placekeeper-link.ts:55-110`, `packages/core/src/placekeeper-link.ts:112-184`). The two forms are deliberately related but not interchangeable:

```text
Loopback Review URL
http://127.0.0.1:43179/r/<view-id>/Users/reader/Paper%20One.pdf#v=1&page=12

canonical Placekeeper Link
placekeeper:///Users/reader/Paper%20One.pdf#v=1&page=12
```

The first can resume the exact in-memory browser view while its daemon, review generation, credential, and original Codex scope remain live. The second can ask Placekeeper to open the current file at the encoded location through the normal launch flow. A stale Loopback Review URL can be projected into the second form after a daemon restart, but it cannot recreate the old live authority.

Earlier iterations first proved same-daemon resume, then clarified that a fixed origin cannot make a successor process the same authority. Persisting old credentials, treating the port as identity, or automatically launching the external protocol from an unauthenticated page load were rejected because each would turn descriptive reachability into authorization (session history).

Several other tempting designs fail the same boundary:

- Keeping `#cap=...` in a readable URL turns copied history into a bearer-capability leak.
- Persisting the old credential, session, task binding, or complete viewer state lets a successor daemon adopt authority it did not establish.
- Automatically opening a filesystem path from an unauthenticated `GET` lets ordinary page loads trigger native UI and file access.
- Encoding scroll, zoom, selection, search, or open panels turns a location link into durable viewer state. The typed location is intentionally limited to page and portable item (`packages/core/src/placekeeper-link.ts:9-16`, `packages/core/test/placekeeper-link.test.ts:125-132`).

## Guidance

### Separate live resume from successor reopen

Implement two explicit paths.

**Live resume** restores the exact live projection. The initial bootstrap consumes a one-time capability, creates a browser credential, random view ID, random view cookie, exact readable pathname, and initial semantic fragment (`apps/service/src/sessions/session-broker.ts:581-634`). The bootstrap response sets the cookie, then `location.replace` scrubs the capability by navigating to the cap-free readable route (`apps/service/src/server/http-server.ts:121-147`, `apps/service/src/server/http-server.ts:323-369`). Reloading that route posts its exact pathname to `/r/<view-id>/resume`; the daemon matches view ID, pathname, cookie hash, active session, document generation, and credential before returning the same in-memory session credential (`apps/service/src/server/http-server.ts:372-390`, `apps/service/src/sessions/session-broker.ts:648-681`). This is resume, not reconstruction.

**Post-restart reopen** restores only document identity and safe semantic location. A successor daemon has no matching view record, so it serves an inert terminal shell derived from strict route parsing, clears the stale cookie, and offers a canonical `placekeeper:` anchor (`apps/service/src/server/http-server.ts:393-425`). Client code preserves a valid `#v=1&page=...` or `&item=...` fragment and falls back to page 1 for malformed or future fragments; it renders an explicit “Reopen this PDF” action but does not invoke it (`apps/web/src/production-entry.tsx:18-57`). Only the user's click enters external-protocol handling.

The successor must never upgrade a stale route into a session on page load. Its recovery parser performs no filesystem access; it only decodes descriptive path data and constructs the canonical app-link base (`apps/service/src/links/placekeeper-link.ts:89-98`). After the click, the native launcher shows the unfamiliar path and requires an explicit Open choice (`packaging/macos/launcher.mjs:117-148`). The host rechecks confirmation immediately before its first linked-file operation, canonicalizes the path, verifies a readable regular `.pdf` whose header contains `%PDF-`, and opens it with `surface: "browser"` (`apps/service/src/host/placekeeper-host.ts:232-247`, `apps/service/src/links/placekeeper-link.ts:44-75`).

Consequently, a successor reopen creates a fresh non-Codex browser view. The stale URL itself recovers no prior browser credential, task binding, document generation, or unsaved viewer state; it contributes only path and location. If Placekeeper separately finds a durable review draft for that PDF, the normal open flow may offer an explicit recovery choice that restores the draft's persisted session identity and review state.

### Make refresh authority projection-scoped

Treat the view ID as a non-secret selector and the cookie plus daemon record as the refresh authority for that one projection. The cookie is host-only, `HttpOnly`, `SameSite=Strict`, and path-scoped to `/r/<view-id>/`; the server stores only its digest alongside the exact pathname, session, generation, and browser credential (`apps/service/src/server/http-server.ts:348-355`, `apps/service/src/sessions/session-broker.ts:111-127`, `apps/service/src/sessions/session-broker.ts:611-625`). The readable pathname itself contains no capability or credential. Public shell and application assets may be served without review authority, but document, state, scope, mutation, and control requests still require the resumed bearer credential (`apps/web/src/app/session-api.ts:29-47`, `apps/service/test/session-security.test.ts:425-467`).

Keep the authority in memory. `SessionCredentialStore` holds bootstrap and credential records in process-local maps, consumes bootstrap capabilities once, and supports session-wide revocation (`packages/core/src/session-security.ts:120-178`, `packages/core/src/session-security.ts:180-217`). Revoking a view deletes its record, revokes its credential, and removes its launch scope (`apps/service/src/sessions/session-broker.ts:684-689`). Daemon exit therefore destroys live-resume authority by construction; no state migration is needed or wanted.

Apply loopback request protections independently of the view cookie. The server accepts only loopback peers, the exact numeric-loopback Host, no forwarding headers, and same-origin mutation requests (`packages/core/src/session-security.ts:58-117`). Numeric `127.0.0.1` is intentional: `localhost` aliases are rejected even with an otherwise valid cookie (`apps/service/test/session-security.test.ts:451-464`).

The fixed production port is only a reachability contract. The packaged daemon binds `127.0.0.1:43179`, and production configuration does not accept an environment-selected port (`apps/service/src/server/http-server.ts:22`, `apps/service/src/server/http-server.ts:644-656`, `apps/service/src/host/service-daemon.ts:55-78`). A replacement daemon can therefore answer the same literal URL, but the old URL remains unauthorized unless that same live daemon still owns its exact view record. If no daemon is listening, refresh can fail normally until Placekeeper is started; stable origin does not imply an always-running or durable session.

### Preserve the original Codex scope only on live resume

Codex binding is part of the initial live launch, not something inferable from a PDF path or open tab. A Codex launch issues a bind proof keyed to the review generation and browser capability; the task hook must claim it before the matching authenticated bootstrap activates the binding (`apps/service/src/sessions/session-broker.ts:249-280`, `apps/service/src/context/task-binding-registry.ts:142-249`). The browser credential retains the original launch scope, and scope polling renews only the active review whose browser-capability discriminator matches that credential (`apps/service/src/sessions/session-broker.ts:955-1008`, `apps/service/src/context/task-binding-registry.ts:268-288`). Because live refresh returns the same credential, the same task binding can remain visible after a hard reload. A later view for another task cannot borrow that projection's scope, and an ordinary browser view has no `codexContext` (`apps/service/test/live-context-service.test.ts:129-188`).

Do not call browser activation “context current.” Activation proves the task/review/browser correlation. The next `UserPromptSubmit` hook requests a fresh projection, emits it into that prompt, and acknowledges its cursor only after output succeeds (`apps/service/src/cli/hook-command.ts:162-175`, `apps/service/src/cli/hook-command.ts:403-424`). Until a prompt-time observation matches the live revision and digests, browser status is `refreshing`; only a verified match is `current` (`apps/service/src/context/task-binding-registry.ts:323-353`, `apps/service/src/context/live-context-service.ts:403-425`). This is why a freshly activated or recently edited Codex view may truthfully show “updating” even though its connection is valid.

A successor reopen must not reproduce this handshake from the path. It launches with `surface: "browser"`, so it is non-Codex unless Codex later performs a new explicit launch and bind flow. Never copy the previous task ID, bind proof, browser capability hash, or credential into restart recovery.

### Use fragments for semantic location, not server state

Keep page and saved portable-item references in `location.hash`. Fragments are client-side, so moving through a document does not expand server routes or disclose credentials in requests. The grammar is versioned and canonical: `#v=1&page=<one-based-page>` with optional `&item=<portable-uuid>` (`packages/core/src/placekeeper-link.ts:88-125`). When an item is unavailable, navigation falls back to its page; malformed fragments converge safely to page 1 (`apps/web/src/review/navigation-coordinator.ts:261-293`).

Use browser history according to semantic intent. Settled ordinary reading—scrolling, sequential page changes, or reflow—updates the current fragment with `history.replaceState`, so it does not create a stop for every viewer signal (`apps/web/src/review/review-location-history.ts:89-105`, `apps/web/src/review/navigation-coordinator.ts:934-953`). A **Meaningful Jump**, such as an explicit outline, annotation, search, or promoted-reference destination, uses `pushState` once through the navigation coordinator (`apps/web/src/review/navigation-coordinator.ts:880-903`, `apps/web/src/review/navigation-coordinator.ts:1191-1205`). Back and Forward then restore semantic locations without pretending that zoom or panel layout is bookmark-worthy state.

### Test each layer of the contract

No one test level proves the whole pattern.

- **Codec and history units:** `Placekeeper link codec` proves special-character and Unicode path round trips, strict readable-route parsing, safe fragment grammar, and rejection of authority-bearing or session-like fields (`packages/core/test/placekeeper-link.test.ts:17-132`). `browser review location history` proves replace-versus-push behavior, Back/Forward restoration, reload in the middle of history, and malformed-fragment convergence (`apps/web/test/review-location-history.test.ts:64-121`).
- **HTTP and security integration:** `resumes a live readable view repeatedly with only its scoped HttpOnly cookie` proves repeated exact resume, missing or wrong cookie denial, path and origin binding, revocation, cookie clearing, inert unknown-view recovery, and the absence of automatic fetch or redirect behavior (`apps/service/test/session-security.test.ts:397-524`). `exchanges the fragment once, scrubs it before protected assets, and scopes all bytes` proves one-time capability exchange and bearer-gated document access (`apps/service/test/session-security.test.ts:346-395`).
- **Real browser acceptance:** `a live readable review survives repeated hard refresh and fails closed after session end` proves the cap-free URL, restoration to page 3 through repeated hard reloads, Meaningful Jump history, canonical copy-link output, and the ended-session terminal screen (`test/acceptance/reloadable-links.spec.ts:31-111`). `a successor daemon keeps the old origin but serves a stale view as inert click-only recovery` proves same-origin reuse without resume, task API calls, external-protocol auto-launch, or stale cookies (`test/acceptance/reloadable-links.spec.ts:113-177`).
- **Codex lifecycle and mounted-browser acceptance:** `binds the exact launch, activates in the browser, refreshes deltas, gates evidence, and revokes at task end` proves the exact claim/bootstrap handshake, repeated readable-view resume with the same credential, Codex scope, prompt-time full/unchanged/delta delivery, and task-end revocation (`apps/service/test/codex-live-context.integration.test.ts:63-244`). `keeps mounted Codex context through refresh, then fails closed on a hung scope poll` proves that a production browser reload preserves the readable path, page 3, and current connected-agent status, then degrades to connecting and unavailable when scope refresh stops succeeding (`test/acceptance/production-flow.spec.ts:279-368`).
- **Installed lifecycle smoke:** the packaged smoke proves the canonical-link confirmation gate, stable-origin and page-location propagation, and absence of Codex authority in an ordinary link-opened view (`packaging/macos/smoke-installed.ts:349-399`). After a real replacement it proves that the origin remains stable while the old readable URL becomes inert recovery rather than a resurrected session (`packaging/macos/smoke-installed.ts:560-597`).

## Why This Matters

This separation gives users familiar browser behavior without making a local URL a durable bearer token. A reader can refresh an active tab, bookmark or copy a human-readable PDF location, jump to a page or saved annotation, use Back and Forward for deliberate navigation, and recover a stale tab after an application restart. At the same time, every stronger claim remains explicit:

- the Loopback Review URL identifies a projection, not a durable document or task;
- the view cookie authorizes refresh only for the exact live projection;
- the in-memory browser credential authorizes review APIs only while the owning daemon and session remain live;
- the original Codex binding survives only because live resume recovers the exact credential and launch scope;
- the Placekeeper Link carries only a local path and semantic location;
- successor recovery requires a user gesture and normal file confirmation, and creates a fresh non-Codex view.

Without this model, convenience features quietly widen authority. A copied URL could leak a capability; a replacement daemon could impersonate an old task; a public `GET` could touch the filesystem or launch native UI; or a fixed port could be mistaken for a trusted process identity. Conversely, refusing every reload would discard useful browser affordances even though exact, view-scoped in-memory authorization makes live resume safe.

The model also keeps durability honest. The absolute path and semantic fragment are durable references only in the limited sense that they can be parsed later. They do not guarantee that the file still exists, that it is unchanged, that the portable item still exists, or that unsaved viewer state survives. Those questions are resolved by the normal open, PDF validation, item fallback, and separate review-draft recovery systems—not by the URL.

## When to Apply

Apply this pattern when a local desktop application:

- serves privileged live state through a browser on loopback;
- wants refreshable, inspectable URLs without exposing bearer material;
- needs copied document locations to outlive one browser bootstrap but not to carry session authority;
- can restart or upgrade its local daemon while old tabs remain open;
- binds some live views to an agent task or another external owner;
- has a small semantic location model that can be restored independently of full viewer state.

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
  -> show inert Reopen this PDF screen
  -> preserve safe page/item fragment

user clicks placekeeper:///.../Paper.pdf#v=1&page=12
  -> native unfamiliar-path confirmation
  -> canonicalize and verify current PDF
  -> normal browser launch
  -> fresh view ID, cookie, session credential
  -> non-Codex review at page 12
```

The new daemon reuses the origin so the literal tab becomes reachable; it does not reuse the old authority. If Placekeeper is stopped, the first refresh may still show the browser's connection error. Starting Placekeeper and refreshing again reaches the inert recovery screen.

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

## Related

- [Task-scoped, prompt-refreshed live PDF context](task-scoped-prompt-refreshed-live-pdf-context.md) defines the exact task/browser-capability binding that a same-daemon live resume may preserve and a successor reopen must not recreate.
- [Upgrade-safe lifecycle for a shared per-user daemon](upgrade-safe-shared-per-user-daemon-lifecycle.md) explains why review sessions, credentials, and task leases remain process-local through replacement.
- [Truthful compact status for live agent context](../design-patterns/truthful-compact-agent-context-status.md) projects the same fail-closed ownership distinction into browser chrome.
- [Preserve document history for Annotation Tray navigation](../ui-bugs/preserve-document-history-for-annotation-tray-navigation.md) covers the in-view Meaningful Jump transaction semantics that browser fragment history projects into the address bar.
