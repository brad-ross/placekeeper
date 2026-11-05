# ChatGPT extension qualification

## Current result

Production extension native-host qualification is **awaiting candidate installation and host actions**, not passed (updated 2026-11-04). The compatibility probe has bounded native evidence recorded below; it does not qualify the production reader.

A standalone candidate is built at `dist/extension-probe`, with instructions in `scripts/extension-probe/README.md`. Local verification passed: three SDK transport/packaged-startup tests; scoped TypeScript checking; simulated-host Chromium checks for PDF resource reading, explicit context attachment, and 375/1440px layouts. The fixture is `dist/extension-probe/disposable-test.pdf`. These checks do not establish real host behavior.

The reviewed implementation plan is `docs/plans/2026-11-02-feat-chatgpt-extension-experience-plan.md`. Subsequent production implementation covers direct entry, admission and reconnect, host resources, background context, live reader tools, editable drafts, sharing preferences and explicit mention snapshots. Those features require qualification against their exact production candidate.

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

The initial preparation used the isolated probe under `scripts/extension-probe/`. Production feature implementation followed the probe observations. Automated service, reader, shell and preference checks are distinct from actual host checks. No production release or complete native-host qualification is asserted.

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

## Production reader qualification preparation

The focused browser suite is `test/acceptance/chatgpt-extension.spec.ts`, registered in the native and Chromium CI suites. It instantiates the actual `ExtensionShell`, canonical production reader, PDF search/navigation and service review backend. The host entry grant, preferences, model-context, mention-catalogue and draft-message APIs are simulated at the boundary. Each evidence attachment explicitly reports `actualHost: false`.

The suite checks preference loading before reader/context publication; accepted annotation identities; exact search and result reveal; stale generation rejection; editable annotation discussion draft with `send: false`; partial context removal followed by another publication; explicit mention include/update/remove controls; compact-to-fullscreen tool navigation; real pointer selection into a captured discussion draft without annotation mutation; external sharing-off while publication is pending; and desktop/narrow screenshots with sharing and discussion controls open. Browser tests do not establish native composer delivery, host resource conditional writes, or native settings event ordering. Existing service/shell and lifecycle tests provide separate coverage for save/conflict/recovery and preference races.

Local browser evidence on 2026-11-04: all five cases passed in the final combined authoritative run (11.8 seconds). The initial failures identified fixture defects: missing production frame CSS/cascade ordering and an omitted daemon installer poll endpoint retired the simulated panel. The harness now preserves the built production HTML frame and models only the installer coordinator's idle response. The pointer-selection check waits for the requested zoom's real page geometry. No production feature source change was needed. Both 1440px and 375px screenshots were inspected: sharing controls and discussion chooser are readable, remain within the viewport, and do not overlap each other. Actual-host checks remain separate evidence.

The narrow open-chooser screenshot covers this short fixture's text with the discussion palette. A follow-up 375px check passed (4.0 seconds), verifying nonwhite ink in the decoded page raster, waiting through animation-frame paint boundaries, and capturing both open-chooser and closed-chooser views. The closed-chooser screenshot visibly contains the PDF text and imported highlights. The white area in the earlier screenshot was the remainder of the short PDF beneath its open palette, not a blank raster.

Run the focused suite after building the current artifacts:

```sh
PLACEKEEPER_BROWSER_TEST_PORT=4179 pnpm exec playwright test --config scripts/testing/config/playwright.config.ts test/acceptance/chatgpt-extension.spec.ts
```

Production artifact preparation is in `scripts/extension-candidate/build.ts`, with instructions in `scripts/extension-candidate/README.md`. It copies the built MCP server/reader, service and web assets, creates a distinct local development marketplace and plugin, copies a disposable fixture, and records SHA256 file and bundle digests. The generated daemon launcher uses development identity, isolated recovery/control storage, and port 48763. It does not launch, install or replace an installed plugin during packaging.

The production candidate packaged successfully after the canonical builds at revision `0e96aca1`. Packaging checks the asset-only production web layout rather than requiring an `index.html`, and the generated launcher sets the native engine's WASM path to the copied web asset. A direct isolated daemon smoke check passed: management identity was `development`; all six web assets were served on port 48763 with SHA256 matching `build.json`; extension open/activate/bootstrap of the disposable PDF returned generation 1 and two imported annotations; worker and WASM resource descriptors matched the copied assets. The grant was revoked and shutdown-if-idle was accepted; the daemon exited successfully. This is direct service/control/HTTP evidence, with no native host or installed-plugin claim. The isolated recovery root retains this disposable smoke review.

The tested bundle SHA256 is `cbe66248ab63712021e6ae05f02dac0f92bec2d3fa5e5a85c0e5507544dffd7e`; individual file digests and build timestamp are in `dist/extension-candidate/build.json`. Repackaging changes the artifact identity; record any later bundle separately.

### Candidate identity and evidence to complete

| Field | Production candidate evidence |
|---|---|
| Marketplace | `placekeeper-extension-candidate-test` |
| Plugin / MCP server | `placekeeper-extension-candidate` |
| Source artifact | `dist/extension-candidate/build.json` |
| Build timestamp / revision / modified status | Record from build metadata after canonical builds |
| Bundle / server / reader / service SHA256 | Record from build metadata and verify installed registration points to that candidate |
| Host / OS / SDK version | Record from actual opened host and pinned lockfile |
| Focused browser result and screenshot inspection | Final combined run: five passed in 11.8 seconds; 1440px/375px screenshots inspected |
| Native production reader result | Pending installation, fresh invocation and host checks |

### Remaining actual-host checklist

- Open only a disposable fixture through the native PDF file-menu entry; verify the production candidate identity and readable PDF. Open the conversation entry independently and verify current-review/chooser/cancel behavior.
- Confirm private activation and explicit fresh reopen. Exercise reconnect with protected annotation/draft identities, and verify old authority cannot mutate after continuation. Do not use browser-page reload as a recovery shortcut.
- Inspect and search the accepted live PDF; reveal an exact search result, navigate to a page, and repeat from a user-collapsed panel. Record visible completion, not merely a successful tool response.
- Select text and prepare a discussion draft; choose a subset of annotations and prepare another. Verify editable native composer text, chosen evidence and no automatic send.
- Remove one context group, then change page/selection and verify it remains absent; remove all groups and verify background sharing stays paused until explicitly resumed.
- Change global sharing settings through native controls while publication is pending; verify off remains effective. Enable mention snapshots, explicitly include/update/remove one review and inspect the captured revision from another chat.
- Exercise resource notification refresh, read-only export, conditional save, conflict and protected recovery using disposable copies only. Verify source bytes and accepted item identities at each boundary.
- Inspect desktop and narrow layouts for horizontal overflow, clipped controls, discussion-palette overlap and keyboard access in the actual host.
- Recheck the existing trusted local-PDF workflow, then stop the isolated daemon and remove the candidate through the supported plugin flow after retaining evidence.

### Combined local verification — 2026-11-04

After the bounded host-save range-read cleanup, the combined service, security, web, PDF viewer, save/export, source rebuild, host integration, source release, native and review unit suites passed: 107 distinct files, 1,807 tests. Production service, web and MCP client/server builds and full TypeScript checking passed.

The combined browser run covered 154 tests: 150 initially passed. The four failures were resolved and passed together in a focused authoritative rerun (22.8 seconds): the resource lifecycle check now waits for the current image across replacement during decoding; the plugin description retains its legacy per-prompt context guarantee; the VS Code build asset-copy step supplied the missing generated distribution; and the viewer selection check targets transient selection paint rather than the permanent rotation wrapper introduced before this branch. No production reader change was needed for these failures. This evidence remains browser/service evidence, not installed-host qualification.

### Review follow-up

The completed code-review receipt is `20261104-212529-aaeeb45c` (`status: complete`, reviewed `3bfb07b0..0e96aca1`, verdict `Ready with fixes`). All four confirmed findings were applied: #1 replays a pending host continuation receipt before revalidating with the returned grant; #2 carries presentation authority to queued mutation and final publication boundaries, including destination/export/finalization paths; #3 preserves native picker deadlines through the extension transport; #4 treats recovery choices as a single fenced intent and retires obsolete replies. No confirmed finding was rejected or deferred.

A separate deterministic regression confirmed the review's cross-source tool concern locally: two PDFs can both have generation 1. Live actions now require the canonical file identity and digest returned by inspection/search, and check source identity before dispatch and after completion. This establishes local stale-source rejection, not native routing behavior.

Post-fix verification: the combined 109-file unit selection passed 1,838 of 1,839 tests initially; the sole failure was an `ENOTEMPTY` temporary-directory teardown in SyncTeX. That entire 32-test file passed on focused rerun. Production builds and full TypeScript checking passed. All new review regressions passed, including actual service-client socket integration in the combined run. Installed production qualification remains pending.

The final post-review rebuilt reader run passed all 36 production-extension and legacy native-reader browser cases in 1.6 minutes, including context/drafts/settings, lifecycle, resource release, and rotated main/reference rendering.

### Installed production candidate — 2026-11-04, 21:55 Eastern

Installed and enabled `placekeeper-extension-candidate@placekeeper-extension-candidate-test` version `0.0.1` through the supported plugin CLI. This is a separate test plugin; the installed release and compatibility probe remain unchanged.

- Build: `2026-11-05T02:54:43.933Z`, clean revision `a0a10c285f86a1eec74e99bbd7dc12ad089df806`.
- Bundle SHA256: `9397833309d2dc4747b25d96539e56558fb302aecc9ccbd0ba502913e357306f`.
- Installed registration and all 13 installed plugin files match the candidate metadata.
- Isolated service: development identity, accepting on port `48763`, private root `/private/tmp/pk-extension-c4e7735a7eab`. All six served web assets match the build hashes.
- Requested opening `dist/extension-candidate/disposable-test.pdf` through the supported panel tool; host returned `queued`. MCP Apps still lists only the prior compatibility probe. No production invocation is observed yet.

Next action requires native host controls unavailable to the automation tools: reload plugins or restart the host, then choose **Placekeeper Extension Candidate** from the disposable PDF's file menu. Do not use the old probe's reload button. Once the production panel is open, continue its actual-host checklist above. The isolated daemon is intentionally running for this qualification session; stop it and remove the test candidate at the end, after retaining evidence.

### Native candidate observations — 2026-11-04, 22:35–22:42 Eastern

The user reported the native file menu contained `open_pdf` and **Placekeeper Extension Probe**. The production entrypoint omitted its tool title; the host displayed the internal tool name rather than the candidate plugin display name. Explicit **Placekeeper** titles have been added to both production entrypoints with a red-then-green registration regression. The already installed artifact still uses `open_pdf` until refreshed.

The first opened candidate showed the legacy missing-invocation message. The isolated service socket returned `ECONNREFUSED` following the host restart; native settings read also returned unavailable. Restarting only the isolated service restored native settings read, and the user reopened `open_pdf` successfully. This was a stopped qualification service, not evidence that private activation delivery is unsupported.

In the freshly opened native production panel, the disposable PDF and its two imported annotations appeared, with Saved status. An annotation-subset discussion action prepared an editable draft; the user confirmed composer text appeared and nothing was sent automatically. Unchecking background context in the panel was reflected by native `settings_read`; native `settings_update` restored the original true preference.

Live reader registration is not qualified: the panel reports unavailable and native WebMCP discovery returns no tools, although the separate probe registered its inspection tool on this host. The current implementation collapses missing API methods and registration exceptions into that status. A bounded DOM diagnostic now records only method availability, known attempted tool name, registration count and allowlisted error class, to distinguish those causes on the next exact candidate. No credentials, source contents or exception messages are recorded. The legacy agent-context badge also remains visible in the app-owned reader and needs reconciliation with the separate app context status.

### Register-only native host confirmed — 2026-11-04, 23:05 Eastern

After restart, the updated panel rendered the disposable PDF. The DOM diagnostic reported apiPresent:true, registerTool:true, unregisterTool:false, successCount:0; WebMCP discovery returned no tools. The independent test service survived the restart. This confirms the strict unregister gate caused the failure.

Commit 96c30b63 supports register-only hosts with API-scoped reusable slots, inert retired readers, replacement ownership and preserved source/generation fences. Four regression cases failed before the fix. Commit 0fe74573 suppresses the legacy task-binding badge only in app-owned readers, including after scope refresh; the separate app context status remains. Root combined verification passed 136 tests; worker typechecking passed. Local socket integration also passed.

Refreshed installed candidate: clean revision 0fe7457352b41f95f8acd470858542356800f76b, build 2026-11-05T04:05:22.135Z, bundle SHA256 fb6bafa98179cb0af9a4d49f3616a3c2c21f700325d2fed1b6425a82fa9e40d1. All 13 installed files match. Independent test service restarted; native settings read verified. Native registration/search/navigation on this exact fixed build still requires a host restart and fresh file-entry invocation; no success claimed yet.
