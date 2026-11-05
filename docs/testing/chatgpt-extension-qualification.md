# ChatGPT extension qualification

## Current result

Native-host qualification is **awaiting human-assisted host actions**, not passed (updated 2026-11-04).

A standalone candidate is built at `dist/extension-probe`, with instructions in `scripts/extension-probe/README.md`. Local verification passed: three SDK transport/packaged-startup tests; scoped TypeScript checking; simulated-host Chromium checks for PDF resource reading, explicit context attachment, and 375/1440px layouts. The fixture is `dist/extension-probe/disposable-test.pdf`. These checks do not establish real host behavior.

The reviewed implementation plan is `docs/plans/2026-11-02-feat-chatgpt-extension-experience-plan.md`. Its first implementation gate requires actual host evidence before dependent admission and recovery changes.

The available computer-use tool refused access to `com.openai.codex` with: `Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` No attempt was made to bypass that restriction. The app's dedicated panel tool can open files but does not expose plugin installation/reload, native file-menu extension selection, or host lifecycle controls. The MCP Apps inventory contained no active app panel. The installed Placekeeper tool surface currently exposes `display_review`, the legacy hook-based entry.

These observations do not establish that extension APIs are unsupported. They establish that this session cannot autonomously exercise the necessary native-host controls. No installed-host behavior or new package qualification is claimed. The probe was subsequently installed through the supported CLI on 2026-11-04; no host restart or native UI qualification has been performed.

## Resume prerequisite

Use an environment with supported access to the native host's plugin development and lifecycle controls, or arrange a human-assisted qualification session. Install/reload the prepared standalone probe through the supported plugin flow and identify the exact active build before testing. Keep the existing installed release intact until a candidate is ready. A generated HTML preview or in-memory transport test cannot substitute for this step.

## Required evidence

Record host version, OS, pinned extension SDK version, candidate artifact digest, active MCP server identity, and results for each case:

| Case | Required observation |
|---|---|
| File entrypoint | A disposable PDF opens through its native file-menu action without a chat message; record opaque URI versus trusted-path availability without recording the URI/path itself. |
| Conversation entrypoint | Current review or chooser opens directly; cancel preserves the prior view. |
| Private result delivery | Initial activation and remount deliver the intended private app data without exposing it in model content. |
| Continuation | Lost response retry, remount, and old/new simultaneous instances have defined outcomes; retired authority cannot mutate. |
| Host resources | Read, update subscription, writable metadata, conditional ETag save, and conflict outcomes work on a disposable fixture. |
| Collapsed tools | Record whether live tools remain discoverable, and whether the supported expansion/reopen flow actually restores search/navigation. |
| Context | Initial context and removal notifications arrive; a removed item stays removed after a subsequent app update and remount. |
| Legacy compatibility | Existing trusted-hook opening remains functional. |

Automatic recovery cannot be claimed until continuation delivery and incarnation behavior are established. If the host cannot supply that route, use the plan's explicit reopen fallback while preserving protected work; do not infer chat authority or store bearer credentials in ordinary UI state.

## Local work state

The implementation edits that preceded planning remain uncommitted and unverified. They are inventoried in the plan and must be reassessed before inclusion. The planning pass added documentation only. The subsequent qualification preparation added the isolated probe under `scripts/extension-probe/` and ran the local checks above; it did not resume the production feature changes. No production feature completion or release is asserted.

## Installed candidate — 2026-11-04

- Registered marketplace `placekeeper-extension-test` from this checkout’s `dist/extension-probe`.
- Installed and enabled `extension-probe@placekeeper-extension-test`, version `0.0.1`, using `codex plugin add`.
- Installed cache: `/Users/bross1/.codex/plugins/cache/placekeeper-extension-test/extension-probe/0.0.1`.
- Both installed bundle digests match `dist/extension-probe/build.json` (built 2026-11-04T23:23:52.046Z).
- Verified the installed MCP registration starts from an unrelated working directory, reports `placekeeper-extension-probe` version `0.0.1`, declares PDF and thread entrypoints, and serves private activation data and panel HTML. This is a direct transport check, not a native host test. Its log was isolated in a temporary directory and removed.
- Configuration confirms the probe is enabled. Its registration intentionally points to the candidate directory; keep this checkout and Node executable in place.
- Requested the disposable PDF open in this chat through the supported panel tool; the app reported `queued`, not confirmed open.
- Native observation log does not yet exist. Remaining actions: host reload/restart, direct PDF extension activation, collapse/reopen/reload, explicit context attachment/removal, and live-tool visibility.
- Marketplace enumeration separately reported a stale `placekeeper-installed` source under the older `~/Applications/Placekeeper.app` location. This did not prevent installing the isolated probe; existing production configuration was left unchanged.

## Native observations — 2026-11-04, 18:34–18:36 Eastern

The user confirmed Connected, privateResultReceived: true, and pdf: true on initial activation. Native observations support initial private-result delivery and PDF resource reading: the file invocation logged mount, a 1,331-byte PDF read, writable and ETag metadata, and successful subscription. A prior conversation invocation also logged mount; resource access was not advertised for that invocation. Subscription acceptance does not establish update delivery or write/conflict behavior.

The user reported a blank panel after clicking Reload this probe. The file invocation logged reload-requested at 23:35:47.576Z, with no later authenticated mount in the inspected log. The button calls location.reload() (scripts/extension-probe/app.ts:47). This establishes failure of that reload experiment, not the underlying host cause or lack of private-result replay: observation logging itself requires both a connected app and a private grant. The synthetic browser check did not exercise reload, and its URL-backed iframe does not establish the native host's document-loading behavior.

Next human action: close the blank panel, reopen the disposable PDF through the same extension action, then test explicit context attachment/removal without clicking Reload this probe. Native remount/replay, collapsed live-tool discoverability, and context removal remain unqualified. Do not use browser-page reload as a production recovery mechanism based on these results.

## Expanded native panel qualification — 2026-11-04, 18:42–18:43 Eastern

The MCP Apps browser surface now exposes the expanded probe, so direct panel inspection and WebMCP invocation are available without controlling the prohibited host shell. The DOM reports ChatGPT version 26.1027.61615, fullscreen, Connected, privateResultReceived, and registered live tools.

- Reopening through a fresh file entrypoint succeeded: new invocations and mounts appeared at 23:37:49–50Z and 23:39:34Z. This is fresh activation, not replay of the failed reload invocation.
- Context attachment and removal passed the bounded probe check: context-published and hasContext:true at 23:37:55Z; hasContext:false at 23:38:08Z; subsequent resource-read at 23:38:10Z. User confirmed the removed marker stayed gone. This does not qualify production publication races or same-invocation remount suppression.
- Expanded WebMCP inspection passed: discovered and called the native inspect_placekeeper_probe tool through the panel capability. It returned the current mount, connected:true, and hasFile:true, with tool-invoked logged at 23:42:58Z.
- Resource update delivery passed: changed only dist/extension-probe/disposable-test.pdf using pdf-lib, retaining a pre-change copy at /tmp/placekeeper-disposable-before-update.pdf. Without clicking Read PDF again, the panel automatically reported the revised 1,751-byte PDF instead of 1,331 bytes. This qualifies subscription-triggered rereading of this local fixture, not conditional writes or conflicts.

Next check requires the user to collapse the panel using the host UI (not Reload this probe). Inspect native tool availability in that state, then re-expand and verify the live tool again. Browser-page reload remains failed and must not be treated as a supported recovery route.

## User-reported collapsed panel — 2026-11-04, 18:44 Eastern

After the user confirmed collapsing the panel, the MCP Apps tab remained discoverable. A fresh WebMCP tool discovery returned inspect_placekeeper_probe, and invoking it succeeded with connected:true, hasFile:true, and the same mount ID as the expanded test. The DOM still reported displayMode:fullscreen. Thus the user's collapse action did not remove live inspection access on this host; displayMode alone does not distinguish this state. This does not prove visible navigation succeeds while collapsed, nor generalize to closing/unmounting the panel. Next: user re-expands the panel, then verify continuity and live inspection again.

### Collapse-to-tool expansion confirmed

The user confirmed that the panel automatically expanded during the 23:44:53Z live inspection call. The log records hidden:true before the call, tool-invoked, and hidden:false afterward; the tool returned the original mount ID. On this tested host, a tool call discovered from the collapsed panel restores its visible presentation without a new invocation. This qualifies the probe's collapse-to-inspect workflow, not production search/scroll completion or arbitrary unmount recovery. No further manual expansion is needed.
