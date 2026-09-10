---
title: Upgrade-safe lifecycle for a shared per-user daemon
date: 2026-08-12
last_updated: 2026-09-10
category: architecture-patterns
module: Shared daemon lifecycle
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - One per-user daemon owns multiple documents, browser sessions, background writes, or agent bindings
  - An installer must replace an app bundle without interrupting unrelated active work
  - Socket reachability cannot prove protocol compatibility, build identity, or safe idleness
  - Accepted durable work may drain while new activity must cancel retirement
  - A candidate process must prove exact readiness before installation becomes final
related_components:
  - daemon management protocol
  - activity and presence leases
  - lifecycle lock
  - upgrade coordinator
  - transactional installer
  - packaged smoke
tags:
  - shared-daemon
  - upgrade-safety
  - conditional-shutdown
  - compare-and-drain
  - activity-leases
  - lifecycle-lock
  - candidate-readiness
  - transactional-rollback
  - stable-loopback-origin
---

# Upgrade-safe lifecycle for a shared per-user daemon

## Context

A desktop app may use one long-lived daemon for several PDF windows and agent tasks. Replacing the application bundle while that daemon is running is not equivalent to restarting a stateless helper: the process owns review sessions, browser credentials, pending saves, task leases, a fixed-origin HTTP server, and a Unix control socket. Killing it for one upgrade can interrupt unrelated PDFs; replacing files beneath it can mix old process code with new installed assets.

The triggering failure was an installed launcher reaching an older daemon that still owned the shared socket and receiving “Launch service returned an invalid response” (session history). The safe response is neither to trust reachability nor to stop the process blindly. Upgrade must inspect compatibility and aggregate activity, defer while any review remains active, cooperatively drain an idle daemon, replace transactionally, and commit only after the exact candidate proves readiness.

## Guidance

### Classify the daemon before touching the bundle

Expose a versioned management status containing stable daemon identity, lifecycle, readiness evidence, and privacy-safe aggregate counts (`apps/service/src/host/launch-control.ts`). Parse it strictly and classify the listener as:

- `exact` when its protocol and daemon identity match;
- `incompatible` when management is valid but identity differs;
- `uninspectable` for legacy, malformed, oversized, timed-out, or early-closed responses.

Unknown does not mean idle. An uninspectable listener blocks automatic replacement (`apps/service/src/host/launch-control.ts`, `apps/service/src/host/upgrade-coordinator.ts`).

Keep daemon compatibility identity separate from complete install-artifact identity. An exact daemon plus an identical complete artifact justifies a no-op; matching service identity alone does not prove that every bundled asset is identical (`apps/service/src/host/upgrade-coordinator.ts`).

### Measure process-wide activity

The unit of safety is the shared process, not the PDF that initiated installation. Aggregate:

- authenticated review presence plus bounded reconnect/bootstrap grace;
- pending and active agent-task bindings;
- Chrome connections, Mac review helpers, and registered Mac app instances, including a resident app with no open windows;
- in-flight saves, broker writes, pickers, source workflows, launches, and HTTP/control routes.

The broker combines browser presence and task activity; the host adds Chrome/native presence, saving, and transient work; the lifecycle coordinator includes active route leases (`apps/service/src/sessions/session-broker.ts`, `apps/service/src/host/placekeeper-host.ts`, `apps/service/src/host/daemon-lifecycle.ts`).

Presence must not depend on a retained session record or browser unload. Connected authenticated control sockets are authoritative while present, and a bounded grace prevents a short navigation or disconnect gap from making an active review appear idle (`apps/service/src/sessions/control-socket.ts`).

Map aggregate blockers to actionable reasons: visible review presence first, agent tasks next, then transient work (`apps/service/src/host/upgrade-coordinator.ts`). Deferral is a correct safety result.

### Use a reversible compare-and-drain gate

Conditional shutdown is a state machine:

```text
accepting -> draining -> shutdown-committed
             | new activity
             v
          accepting
```

Refuse draining when non-drainable review, task, or route activity exists. Otherwise enter `draining`, await accepted saves and broker writes, then re-read all aggregate activity. Any activity entering during the drain cancels the attempt and restores accepting; only a stable empty recheck commits shutdown (`apps/service/src/host/daemon-lifecycle.ts`).

Route all meaningful work through the same activity authority. Work arriving during drain cancels retirement, while requests after commit are rejected (`apps/service/src/host/launch-control.ts`, `apps/service/src/server/http-server.ts`). This closes the race between “idle” inspection and exit.

### Flush acknowledgement before socket retirement

When conditional shutdown succeeds, serialize and flush the accepted management response before closing the host, control server, and socket (`apps/service/src/host/launch-control.ts`). The installer then waits for socket disappearance before replacing the bundle (`apps/service/src/host/upgrade-coordinator.ts`).

Without response-first closure, a successful shutdown can look like an invalid or truncated protocol exchange—the same class of symptom that motivated the work.

### Linearize install, launch, and startup

Use one per-user filesystem lifecycle lock across installer coordination, ordinary launch, daemon retirement, replacement, and candidate startup. The lock has a private owner record containing a PID and random token; a child may borrow only the exact inherited token already recorded on disk (`apps/service/src/host/lifecycle-lock.ts`).

Reclaim stale locks conservatively. Never let an earlier reclaimer delete a newer owner's lock (`apps/service/src/host/lifecycle-lock.ts`). Launch and candidate startup share the inherited token, while installation holds the same transaction across inspection and readiness (`apps/service/src/host/service-daemon.ts`, `apps/service/src/cli/daemon-command.ts`).

### Make each installer outcome explicit

Four common coordinator paths are:

1. exact daemon and identical artifact → no-op;
2. active reviews or tasks → defer and preserve every session;
3. idle inspectable daemon → cooperative drain, retirement, and replacement;
4. uninspectable or malformed daemon → refuse automatic termination and require the operator to close active Placekeeper work before retrying.

Transient work may receive a bounded opportunity to drain, but the bundle is never replaced while old code still owns unfinished work (`apps/service/src/host/upgrade-coordinator.ts`).

An uninspectable daemon cannot prove absence of work, so the installer leaves the bundle untouched and reports a close-and-retry recovery action (`apps/service/src/host/upgrade-coordinator.ts`, `apps/service/src/host/launch-control.ts`). There is no legacy-stop command or automatic signal fallback; process-wide kill commands are not an installer strategy.

### Prove candidate readiness before commit

Stage replacement privately, retain the prior app, and do not finalize until the installed candidate starts its exact daemon and reports the expected identity, accepting lifecycle, and unique readiness token (`packaging/macos/install-built-app.sh`, `apps/service/src/host/service-daemon.ts`).

If readiness fails, retire the exact candidate before restoring the previous bundle. If retirement cannot be proven, preserve the transaction rather than restoring old files underneath a potentially live new process (`packaging/macos/install-built-app.sh`).

The packaged daemon's numeric-loopback port is part of readiness. Production always binds the fixed Placekeeper port; the isolated installed smoke and an explicitly development-identified runtime may use a private root and port (`apps/service/src/server/http-server.ts`, `apps/service/src/host/service-daemon.ts`). A foreign listener therefore causes candidate startup and installation to fail explicitly. Never fall back to a random port or terminate an unknown process merely to make the candidate ready.

### Preserve reachability without migrating authority

Reusing the fixed loopback origin lets a browser retry the same literal readable URL after replacement, but it does not make the successor daemon the old daemon's security principal. Browser-view records, scoped cookie digests, credentials, launch scopes, and task bindings remain process-local. When the successor receives a syntactically valid old route with no matching live view, it clears the stale cookie and serves inert recovery containing only a canonical Placekeeper Link (`apps/service/src/server/http-server.ts`, `apps/service/src/sessions/session-broker.ts`).

The user must explicitly follow that link through the normal file-confirmation and open flow. The resulting browser view and credential are fresh; they cannot inherit the old credential or infer a task binding from the path. A separately persisted, short-lived two-sided ticket may reattach the new view only when both a path-scoped browser token and the owning task's next prompt match. This remains document/location recovery plus a fresh proof of task ownership, not live-session migration. [Authority boundaries for reloadable local-review URLs](reloadable-local-review-url-authority-boundaries.md) defines that distinction in detail.

### Test the physical installed lifecycle

Unit tests cannot prove cross-process bundle-path behavior. The installed smoke must run real packaged launchers and daemons, open multiple authenticated PDFs, retain an active agent context, attempt an incompatible upgrade, and verify that the installed identity and both sessions remain usable. Only after task revocation and browser-grace expiry should replacement succeed and launch another PDF (`packaging/macos/smoke-installed.ts`). The successful-replacement phase must also prove that the successor owns the same origin while an old readable route becomes inert recovery rather than a resumed session (`packaging/macos/smoke-installed.ts`).

The work progressed from focused lifecycle tests to this installed proof because unit-level checks alone did not validate the upgrade boundary (session history).

## Why This Matters

A shared daemon changes the question from “is this PDF idle?” to “can all activity owned by this process be proven quiescent?” One quiescent review does not make the daemon idle when another PDF or agent task remains active.

The drain/recheck state machine closes the idle-check race. The lifecycle lock closes the process race. Response-first closure closes the protocol race. Candidate readiness closes the filesystem race. Together they turn active-work deferral into a successful, convergent upgrade behavior rather than an error.

Live-session migration is intentionally unnecessary. Safe deferral preserves browser credentials, recovery, and task-bound state in the old daemon until every user-visible owner ends naturally. After replacement, stable-origin reachability can recover only a document path and safe semantic location. An optional reconnect ticket transfers no credential or raw task identity; it merely permits the fresh successor browser and the independently identified owning task to prove they belong together again.

## When to Apply

- One local process serves multiple windows, files, extensions, or tasks.
- Running code resolves assets from an install path that may be replaced.
- Durable writes can remain after visible windows close.
- Installation can race ordinary launch or startup.
- Old protocol versions may not report trustworthy activity.
- Rollback is required when the installed candidate is not ready.

A stop-and-replace flow may be adequate for a truly per-document child process whose state and files are isolated and whose termination is explicitly authorized. Do not assume that model for a shared host merely because one PDF is visible.

## Examples

### Two active PDFs

```text
candidate acquires lifecycle lock
management reports incompatible daemon
activity reports two reviews and one agent task
coordinator returns upgrade-required
old daemon and installed bundle remain unchanged
```

### Idle cooperative replacement

```text
accepting + no non-drainable activity
  -> draining
  -> finish accepted saves and broker writes
  -> recheck empty
  -> shutdown-committed
  -> flush response
  -> close HTTP/control/socket
  -> transactionally replace
  -> exact candidate readiness
  -> commit
```

### New work during drain

If a launch or route enters while draining, its activity lease changes the attempt generation and restores accepting. The upgrade defers instead of racing the new work (`apps/service/src/host/daemon-lifecycle.ts`).

### Candidate failure

When the new daemon cannot prove exact readiness, stop that exact candidate, prove retirement, and restore the retained app. Never restore old bytes while the new process may still resolve installed assets.

## Related

- [Upgrade-safe shared-daemon plan](../../plans/2026-08-12-002-fix-upgrade-safe-shared-daemon-plan.md) records the originating requirements and rejected unconditional-stop approach.
- [Installation and recovery](../../installation.md) provides the user-facing defer, close, and retry workflow.
- [Installed host acceptance](../../../test/acceptance/installed-hosts.md) records packaged multi-PDF evidence.
- [Recoverable autosave for editable PDF annotations](recoverable-editable-pdf-annotation-autosave.md) explains the durable work that shutdown is allowed to drain.
- [Authority boundaries for reloadable local-review URLs](reloadable-local-review-url-authority-boundaries.md) distinguishes same-daemon browser resume from the successor daemon's inert document/location recovery.
