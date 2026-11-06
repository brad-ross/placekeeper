# ChatGPT extension qualification

## Current result

Production implementation and automated verification are complete; native qualification is in progress (updated November 5, 2026). The latest packaged candidates are revision `15409216009322f89803e43c4329d3fd85cadca7`: ordinary bundle SHA256 `0e08235c6d5cd63a94fc046da96a07b1028bc49f6586a49a50b1cb65aae18922`, opaque bundle `c5b2eeddc3e388c967c0ddf23f421269d94bf588a16fa84f897d3a599e01b76b`. Native writable-source autosave to a chosen local copy and explicit saved-copy recovery passed; the chronological evidence below distinguishes older artifacts and outstanding checks.

Verified in the actual production panel: native file entry, all five live tools, exact search and destination navigation, automatic expansion from collapse, annotation and selection editable drafts without automatic send, saved PDF annotation changes, protected review recovery with stable item identities, clean external source refresh, stale source/generation rejection, context removal remaining paused, and explicit mention snapshot include/remove plus native preference reads. These observations are detailed chronologically below.

**Route qualification matters:** this native file-menu invocation supplies trusted local-path metadata. The production server therefore selects local persistence, and the panel has no opaque-route Refresh PDF / Save now controls. Its saves and source refreshes qualify the trusted local-path route, not HostResourceAdapter reads, subscriptions, ETag writes or conflicts. Earlier chronological descriptions of these checks as host-backed/resource-notification evidence must be read with this correction. The separately identified Opaque Test candidate discards only the optional path hint while retaining the real host file URI and unchanged production reader/service, so the opaque branch can be exercised without mocked host APIs.

Still pending: independent conversation chooser/cancel, actual sleep beyond the presentation lease, fresh peer-chat ownership/fork, the exact installed legacy launch, and the remaining named-group/remount interactions. Native composer mention discovery is unavailable on the tested host; catalogue verification alone does not qualify it. Opaque conditional write/conflict and consecutive autosaves from a filesystem-read-only source have passed. Recovery after restarting Codex and a third autosave to the same copy passed. Close/reopen without restarting previously exposed retained ownership; the teardown correction failed that separate native requalification. Host logs show outgoing tool requests are cancelled during native panel removal; an explicit in-reader close action is being qualified. Host download is optional and unsupported on this host.

The available computer-use tool refused access to the native Codex shell. No bypass was attempted. Supported plugin CLI operations and MCP Apps panel inspection work; file/conversation menus, OS sleep and peer-chat composer controls need human assistance. The earlier standalone compatibility probe is historical evidence, not the production reader, and has been removed.

## Active qualification setup

Use the existing human-assisted session and the production packaging instructions in `scripts/extension-candidate/README.md`. Keep the installed release intact. Record the exact route and candidate artifact for each test. Fresh file-entry invocation is the supported reopening path; the earlier browser reload experiment is not a qualified recovery mechanism.

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
| Build timestamp / revision / modified status | `2026-11-05T04:05:22.135Z`, `0fe7457352b41f95f8acd470858542356800f76b`, clean |
| Bundle / server / reader / service SHA256 | Bundle `fb6bafa98179cb0af9a4d49f3616a3c2c21f700325d2fed1b6425a82fa9e40d1`; all 13 installed hashes verified against build.json |
| Host / OS / SDK version | Native host last observed `26.1027.61615` on macOS; pinned extension SDK `0.2.1`, ext-apps `1.7.5` |
| Focused browser result and screenshot inspection | Final combined run: five passed in 11.8 seconds; 1440px/375px screenshots inspected |
| Native production reader result | Core trusted-path workflows passed; opaque and remaining lifecycle/peer cases tracked separately below |

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

### Fixed build native tools — 2026-11-04, 23:11 Eastern

Following the next restart and fresh file invocation, the exact fixed build exposes all five live WebMCP tools. Inspection returned the disposable fixture at generation 1/revision 0 with its two imported annotations. Searching for text returned two exact hits with complete one-page coverage. Revealing the first result returned navigated and the DOM reported Main document destination opened; revealing the supported highlight returned navigated and the DOM reported Annotation destination opened. The legacy unavailable badge is absent. App-local background context remains paused through these actions. Production collapsed-panel navigation is the next check.

The user collapsed the production panel, then native navigate_page returned navigated for the same source/generation and the DOM reported Main document destination opened. The user confirmed that the panel automatically reopened. This qualifies the production collapse-to-navigation path on the tested host.

Native save check: edited the existing supported highlight comment to append “— native save check.” The editor completed, the annotation list showed the new comment, and the toolbar returned Saved. The actual disposable-test.pdf digest changed to d771afb8c111983e8704ee537bd17bf5b58120ca4a9e36698b95b04f150bfdc7. Its bytes contain the exact updated comment as UTF-16 hexadecimal and preserve the original unsupported stamp text. This is actual host-backed PDF persistence evidence, not only accepted service state. Reopening is the next check.

Closing and reopening offered protected work; Resume completed. Live inspection returned the edited comment with both original annotation IDs preserved, and Saved status. A page-navigation call using the previous reader source identity was rejected with stale-source, despite both generations initially being 1.

Appended a harmless PDF comment to the disposable source externally. The native resource notification refreshed the live reader automatically to generation 2/revision 5 and digest 5468d66c6886941add8c2111d9f774d7468a57713d4a6bb9e0c83476880da54b. Both annotation IDs and contents were preserved. This qualifies the clean external-resource refresh path; no save conflict race was induced.

The user removed the current context attachment; the panel changed to Background context is paused for this app. A successful generation-2 navigation left that state paused. Mention opt-in controls were exercised with only the disposable review: global enable appeared in native settings_read, explicit include displayed revision 5 and its capture time, and explicit remove returned the review to excluded. Restored global mentions=false and verified via settings_read. Cross-chat mention lookup itself remains untested.

### Completion work and route correction — 2026-11-04, 23:25 Eastern

The user confirmed the selection action prepared an editable, page-referenced composer draft without sending it. A later native source refresh rejected a generation-1 result with stale-generation at generation 3. The pending replacement draft was retained through local-path source reconciliation and saved as a review annotation; this was not an opaque ETag conflict test.

The trusted-path route was confirmed from the production active panel lacking the Refresh PDF / Save now controls that ExtensionShell adds unconditionally for HostResourceAdapter. The file entrypoint prefers the host-provided trusted path when present. Therefore all preceding production save/refresh observations qualify local persistence only; opaque resource behavior requires a separate native test. No mock API evidence is relabeled as native.

The obsolete compatibility probe was uninstalled through the supported plugin tool, its marketplace was removed through the supported CLI, and its eight source files were removed after checking for surviving code references. Its build identity and 426 allowlisted observations are retained under evidence/extension-probe-2026-11-04. Generated probe files were moved out of the checkout to a temporary archive. Reusable production-candidate packaging remains.

### Requirement evidence matrix — completion audit

All requirements have implementation and focused automated coverage. This matrix records the November 4 checkpoint; later native results and corrections below supersede its pending entries. “Pending” means native evidence was not yet established, not that a mocked result was substituted.

| Requirement | Native observations established | Outstanding native boundary |
|---|---|---|
| R1 | File-menu activation with trusted local path, readable PDF, no chat message | Conversation chooser/cancel; opaque route candidate |
| R2 | Collapse continuity, fresh protected reopen retaining item IDs | Actual sleep beyond lease; same-invocation remount |
| R3 | Expanded production reader; collapsed navigation reopens and completes | Keyboard/narrow-host inspection beyond existing browser tests |
| R4 | Local saved bytes, unsupported stamp preservation, protected reopen and external generation refresh | Opaque conditional save/conflict/read-only export |
| R5 | Whole-context removal pauses sharing through successful navigation | Named-group removal and remount/racing-publication host observations |
| R6 | All five tools; exact search; visible result/page/annotation destinations; stale source and stale generation rejected | None for the tested trusted-path reader workflow |
| R7 | Selection and annotation-subset editable drafts; user confirms no automatic send | Selection/source-switch and named-group persistence at native boundary |
| R8 | Explicit snapshot include/remove, revision labels, default exclusion | Peer-chat composer retrieval and known-URI opt-out |
| R9 | Native settings read/update plus equivalent panel controls; original settings restored after first test | Pending-publication native race |
| R10 | Separate app context without legacy binding claims; stale source rejection | Peer ownership/fork and exact installed legacy hook launch |

AE1 and AE6 have native production evidence. AE4 now has native stale-generation rejection after source refresh. AE2, AE3, AE5, AE7, AE8 and AE9 retain their deterministic automated coverage and still need their listed native boundary observations.

### Isolated opaque-route candidate ready

The separate qualification wrapper drops optional file-entry metadata only for open_pdf, retaining the actual host-selected resource URI and all production admission, private grant, resource, reader and persistence behavior. It does not fabricate resource metadata or mock the host. Other operations pass through unchanged. The importer-specific alias affects only the isolated candidate build; normal production builds retain their original route selection.

- Source revision: b996943e79bf37ac8fb908e9ac46b7479e9bc0e4; built 2026-11-05T04:30:23.550Z.
- Route: opaque-resource; bundle SHA256 c4815c290b99968fd516ea82539e2fad73dd6e0c2c44e191c43ffe995f07e5b7.
- Plugin/marketplace: placekeeper-extension-candidate-opaque@placekeeper-extension-candidate-opaque-test.
- Isolated port: 48764; the existing trusted-path candidate remains on 48763.
- All 13 installed files and all six served web assets match their build hashes. Reader HTML, service and web app bytes match the normal production candidate exactly.
- The wrapper, packaging/default-route preservation and suite registration checks passed 21 tests; full TypeScript checking passed.
- A separate read-only-test.pdf fixture has actual filesystem mode 0444.
- Native invocation is pending. Installation and direct asset checks alone do not qualify host-resource behavior.

### Delayed recovery choice regression

The native peer-chat check exposed an expired ownership offer: selecting an independent review after the one-minute offer lifetime ended the panel. The shell now explains that the choice expired and offers fresh PDF selection or cancel. It never renews the expired capability implicitly. Regression coverage checks the 95-second delay, stale button callbacks, canceled picker responses, and transition from a host resource to a newly selected local source. Service coverage confirms the expired offer cannot allocate authority and a fresh explicit open can issue a new choice.

The combined live-reader, extension-shell, extension-runtime, host-resource adapter and host-resource service tests passed; the full TypeScript check and diff check passed. The throwing-unregister regression also verifies that retained tool names remain inert until assigned to the replacement reader. These changes are locally verified; native retesting requires rebuilding and reopening the candidate.

The completed incremental code review at `b996943e` found no actionable defects (receipt: `20261104-increment-96289e15`). Its verdict covers that code increment, not the outstanding native qualification. The recovery fix above follows the later native failure.

### Native opaque-resource checks after refreshed registration

On November 5, the restarted host exposed a separate **Placekeeper Opaque Test** panel and server. Its reader showed **Refresh PDF** and **Save now**, confirming the host-resource route. The test opened the ordinary candidate’s disposable PDF through that opaque entrypoint; the starting digest was `7f9e2e588113cf469c83337e0fe68f1c365ee2c08cdd65adc7cd5076c274c6ce`. No user PDF was used.

- Host read and admission succeeded with three existing annotations and all five live reader tools.
- Editing the supported highlight to “Existing supported highlight — opaque resource save check” completed through the real host write API. The underlying disposable PDF changed to `2426373caeb48a12f070e1d22c99948b83c7cbbfe125da1488855cf54271d459`; the new comment was verified in its bytes.
- While a second comment edit was open, an external PDF comment changed the source to `7481f1ecf1945d8edcc9e1c1a7ac628fc82c16c0f064e918db615758d627d204`. A host update notification triggered the finish-edit/refresh notice and preserved the editor. Applying “Protected opaque conflict draft” produced the conflict/protected-review notice and **Not saved** status. The external PDF digest remained unchanged and contained no conflicting draft text.
- The conflict notice exposed a missing export control in this native route. Export itself is not yet qualified; the UI wiring is being corrected before retest.
- After restart, the user still found no Placekeeper source in the native composer mention menu. Working server catalogue searches do not qualify native mention discovery.

Both refreshed candidates were packaged from `667ad7e01207f1a24aff368a2c75ca5bbcd2ffd8`. Normal bundle: `69836b652b0bf2d813d224131d07126a0ad05420073340bea17f05dc193037d2`; opaque bundle: `dfe652aaee212f594f74e8ddb8a7e9a16affb0a2de5126c6f1b6e3f2fe3296e1`. All 13 installed plugin-file hashes were checked for each. Disposable fixture edits were preserved across packaging, so the runtime digests identify the candidate while the source digests above identify the tested PDF.

The missing host-resource export menu was traced to presentation gating: automatic-save controls were suppressed for host destinations, while document actions only appeared for generated/export-only reviews. The reader now offers its existing document-actions menu when reviewed export is available without automatic-save options. The menu reuses the existing save-status mapping so a conflicted review still says **Not saved**. Four production-render cases and the existing fenced adapter-route test passed with the relevant layout/adapter suites (190 tests); the full TypeScript check passed. Native export remains pending the refreshed reader.

A restored ordinary panel after restart was found to retain older inline HTML: the fixed expired-choice message was absent from its script. The newly opened opaque panel contained the fixed message. Therefore restored-panel behavior does not qualify the refreshed artifact; fresh file-menu invocation and a loaded-version check are required.

The export-menu candidate was rebuilt and installed from `84ddd317e79e1e044d121bb036f413bda81bb87a` at `2026-11-05T05:18:56.054Z`, bundle `fc9f6afcfb4e86ae84b6010161bdf95f58e1e324a4bd696eb04eeeeb615f0346`; all 13 installed files matched. The isolated opaque service retained its recovery directory. Web/client/server builds passed. The extension browser suite passed four of five checks; collapse-to-navigation returned unavailable once, then its exact isolated rerun passed without a code change. This is recorded as a transient test failure with a successful focused rerun, not an uninterrupted five-test pass.

For native ownership, the peer chat opened the same disposable PDF and reported a working reader with source file ID `f3cf8a4d-aff5-4979-8e2f-16f9481aaf98`, generation 1/revision 0, external-change digest `7481f1ecf1945d8edcc9e1c1a7ac628fc82c16c0f064e918db615758d627d204`, and new-copy persistence selected. A fresh ordinary panel in the main chat then correctly offered only independent review or cancel, with no takeover option. Independent review was selected, but the UI inspection connection timed out before its result could be verified. Successful independent opening remains pending.

The two native-driven fixes received a completed full-depth incremental review (`20261105-native-fixes-84ddd317`, base `b996943e` through `84ddd317`) with no actionable findings. Its ready-to-merge verdict covers code only; native export and fork completion remain unverified. Original normal-candidate mention preferences were restored to `backgroundContext=true`, `selectionSharing=true`, `mentions=false`; disabling mentions removed the disposable catalogue snapshot.

### Follow-up native export and independent-review failures

After the next fresh Opaque Test opening, the repaired document-actions menu and Export reviewed PDF dialog were visible. The service materialized an export, but the user saw no Save dialog and no matching downloaded file was found. The adapter used an HTML blob download link; the bundled MCP Apps SDK explicitly documents that direct iframe downloads are blocked and supplies App.downloadFile. This is a failed native export check, not a qualified download.

The same run exposed competing ordinary reviews writing the disposable source. The independent review and peer review both had original-file destinations despite the independent choice. Their recorded PDF generations alternated through repeated external refresh/save cycles; the opaque reader reached generation 8 and correctly stopped at a save conflict. The previous opaque conflict draft remains durable in its separate recovery record. No user PDF was involved. The independent opening reported by the user succeeded as a reader, but its write-ownership safety check failed.

The local corrections route reviewed copies through awaited MCP Apps `downloadFile` with explicit cancellation/error handling, and start every explicit local fork with no save destination even when annotations were imported. The annotated-fork regression failed on the previous implementation, then passed with the fix; the combined recovery, extension runtime, host-resource service, adapter and shell suites pass 139 tests. Native verification of the revised downloads and independent destination is still pending.

An added real-shell/adapter regression exercises changed annotation names, a synchronous host write notification, and a deferred download: exactly one write occurs, the download finishes before refresh/resume remount, and no extra fix is needed for that ordering. The shell suite passes 36 tests. Focused correctness plus independent local adversarial review completed without findings (`20261105-export-fork-2a42fb97`). That verdict covers code, not native download persistence. Existing pre-fix original-writing fork records are not migrated; retesting must use fresh independent reviews.

Both candidates were rebuilt and installed from `e786b3f5` after export commit `25a6a6e0`. Normal build at `2026-11-05T06:01:25.012Z`: bundle `3529caa726fdcfa6eaebd63ee374890a7b962d56c7c4f5e647acc781f865d248`. Opaque build at `2026-11-05T06:01:29.448Z`: bundle `fe92f50e6a8fe72c68013452c7dfc05f16196d11b92f3029283aa73c404a570c`. All 13 installed files matched each candidate. Both isolated services restarted successfully, with original sharing preferences unchanged and mentions disabled. Existing recovery directories and modified disposable PDFs were retained. A fresh `export-and-fork-test.pdf` fixture was copied from the original fixture for the next native run. Full typecheck passed after the final test addition; builds passed. Restart/fresh native opening is pending.

### Stale reader after native restart and fresh opening

On the morning of November 5, the user reported fully quitting/relaunching Codex and using Open In for `export-and-fork-test.pdf`. Export produced no retained file; the user recalled a Save window briefly appearing and closing. Direct read-only inspection of the panel's script found the old browser-download warning and no new host-download warning. The built, packaged and installed HTML all contained the new host-download warning instead. Running opaque MCP server processes started that morning and pointed at the updated candidate files. Therefore this attempt does not qualify the new download implementation: the host presented older HTML despite the refreshed files. The prior statement that the updated reader had loaded was incorrect. The server still advertised the same `ui://placekeeper/review-v1.html` address for every build; content-derived resource addressing is being added to separate updated shell bytes in host caches.

The MCP server now advertises a SHA-256-derived HTML resource address consistently in all three opening tools and the resource catalogue. The old fixed address remains only a compatibility read alias. Tests verify address stability for identical bytes, changes for updated bytes, matching entrypoint metadata and resource contents, isolation between server instances, and rejection of other versions. Sixteen focused server/entrypoint/preference tests and three candidate tests pass; full typecheck and diff checks pass. An independent follow-up review could not complete because the selected model was at capacity; a targeted manual review found no additional issues. No independent review receipt is claimed for this increment.

### Native versioned-reader uptake and unresolved download

After the next restart and file opening, direct DOM inspection confirmed the new host-download code was present and the old browser-download code absent. This qualifies uptake of the content-addressed reader. Export still produced no retained file; the user reported no dialog or one that closed. The current service recorded a prepared reviewed export at revision 1/generation 1, digest `9f559a4725efe802bf628760d4d362fd2aa31387eba024a311b7f7e727b9d755`, followed by a saved host source. This proves materialization, not successful download. The final host outcome was not retained in the existing UI after refresh.

A bounded export diagnostic and persistent user-facing outcome were added to the shell. They distinguish preparing, host request, host acceptance, host cancellation/denial, and failure, and record only the stage, previous stage and advertised download support. No PDF bytes, paths, grants or raw error messages are included. Existing export tests now check acceptance/denial/failure and persistence through the own-write refresh; 46 shell/adapter tests pass. The own-write test now waits for its asynchronous write instead of assuming one fake-timer flush completes native crypto. This is diagnostic work; no native download fix is claimed yet.


### Native diagnostic result, November 5, 2026

The user restarted and reopened `export-and-fork-test.pdf` through Placekeeper Opaque Test. The panel contained the new persistent-outcome code. A native Export attempt completed with the visible message “Export did not complete. Your review is still available.” The retained diagnostic was `{"phase":"failed","previousPhase":"host-requested","downloadAdvertised":false}`. Thus preparation reached the host download callback, the callback failed, and this Codex host did not advertise the MCP Apps `downloadFile` capability. This was not the `isError` cancellation/denial branch. The precise exception is deliberately not captured by these bounded diagnostics, so no exact RPC error or host-side cause is claimed.

The installed MCP Apps SDK documents host-mediated `downloadFile` as the export mechanism for sandboxed apps; its host-capability type makes support optional. The installed OpenAI extension SDK exposes reading/writing already supplied resources and opening a local path, but no new-file destination picker in those APIs. Writing over the source is not a substitute for exporting a separate reviewed copy. Native export remains blocked/unqualified on this host. Repeating the same restart/open procedure is not a useful next test without a supported download capability or a separately designed export route. Background context remained paused; no sharing settings were changed.


### Autosave-to-copy qualification amendment

The user chose desktop-style autosave to a local copy as the core persistence route for host-managed PDFs. Missing host download support no longer blocks that route. The updated plan requires the existing native folder picker and save coordinator, one active destination, and durable destination recovery.

Pending installed-host checks for the new implementation:

- Open the disposable PDF through Opaque Test and use the filename/save-options control. Cancel a folder selection and verify the prior destination/work remain intact.
- Choose a unique local copy in a temporary qualification folder. Verify the destination is shown, then change two annotations in sequence. Inspect the actual saved PDF after each edit and verify the original source bytes remain unchanged after the copy is selected.
- Refresh and close/reopen the protected review, then make another edit. Verify the same copy is updated and the original still is not written.
- Repeat with a read-only host source. No Codex download call or dialog is required.

These are pending checks, not claims of native success.


The autosave-to-copy implementation passes 287 tests across the host-resource, Codex persistence, save coordinator, extension shell/adapter, production reader, Codex runtime, and layout suites. Both writable and read-only copy cases use real PDFs, the real writer, and parsed destination annotations after successive edits and a source successor. Recovery tests retain the destination across service restart and persist a later edit. A deferred host-write test proves copy selection waits for the old write, and that later saves/retries use the local destination. Late host receipts and chunk reads cannot affect the copy’s Save Sync. Unsupported host downloads are hidden independently of Save options.

The first combined run exposed two fake-clock tests assuming real Web Crypto work completed after a timer flush/default polling budget. Explicit promises now await the observable write/download/remount boundaries; ordering and exact write-count assertions are unchanged. The parent rerun passed all 287 tests. Typecheck and web, service, and Codex client/server production builds pass. Five browser checks passed at desktop/mobile widths, covering the extension layout and shared save dialog’s save/cancel/name behavior; the local test server required normal local-network execution after the restricted run timed out. These browser checks simulate host integration and do not qualify the native picker. Installed-host checks above remain pending.

Code review completed (`20261105-copy-autosave`) with three confirmed findings, all applied: rejected copy selection retains warnings; download-capable Codex hosts retain both Save options and Export; opaque sources cannot enter generic filesystem export after selecting a copy. The export-boundary regression was verified failing with its guard removed. The final parent run passed 211 tests across five affected suites, typecheck, and all four production builds. Native qualification remains pending.

The post-review browser check found a focus regression introduced while exposing Save options beside Export. Restored blocked-export focus to Open Annotations; both unchanged browser tests now pass, covering stale confirmation, blocked export, pending export, and retry. Rebuilt the web reader and Codex client/server after the correction.

### Native autosave-to-copy result, November 5, 2026

Installed build `f9158c87` exposed Save options with no unsupported download action. The user confirmed the macOS folder picker appeared and canceled it; the reader retained Saved, no folder was selected, and Save stayed disabled. A second picker selection chose `/private/tmp/placekeeper-native-copy-check`; the reader created `native-autosave-check.pdf`. Two successive highlight-comment edits persisted to that same PDF without a download or another destination choice. Parsed output after the first edit contained “Native autosave check one” (SHA-256 `8583bfea128b147c03c37dd60f53513803c897aaf49f58d6235f3bd0dc889341`), then “Native autosave check two” (`e452938eedf21f1124cff62db32f70fd6fde51c94882a261a7598a64f967cf38`). The existing unsupported stamp remained present. The original stayed byte-identical at `95ab8b413dc9d0352eb8caadf69b9df801517a631e56b62853d9abb5b91e5e02` throughout. This qualifies native picker cancellation/selection and consecutive copy autosaves for this writable opaque source.

Closing the panel and reopening the same original did **not** restore the protected review: inspect returned a different file ID, generation 1/revision 0 and original annotation comments; Save options again had no folder. The existing annotated copy remained safe on disk. Reopen persistence is failed/unqualified pending diagnosis, not a passed recovery scenario. Read-only native qualification remains pending.

Native interaction also exposed the discussion chooser covering the workspace rail and Annotations tab. User keyboard interaction bypassed the overlap for this test; a separate layout correction is in progress. Row edit actions need pointer hover or focus, which the DOM-only native test surface cannot supply directly; after the user focused the edit action, automated editing/Apply succeeded.

The source correction adds a distinct, explicit matching-copy recovery offer when an opaque URI changes. Automated coverage includes an existing owner refusing takeover, retired ownership, cold restart, ambiguous same-content/name copies, changed target fingerprints, and a source-byte change before activation. Cold recovery of an externally modified destination retains protected work without a write capability; a newly exposed shared status bug was corrected so later edits/retry retain target-changed instead of incorrectly showing missing. The final parent service/runtime/shell/recovery/save-coordinator run passed 195 tests; typecheck and web/service/Codex production builds pass. The discussion chooser now takes its own layout row; parent Chromium checks pass at 1440, 1120 and 375 pixels. Installed requalification and final code review are still pending.

Full code review `native-recovery-iSm6o4Wn` completed with seven findings, all applied: require a completed verified reread before matching-copy activation; retire a mismatched provisional grant and replay a fresh-open ticket; block provisional host export/chunks; reject canonical path redirection for recovered imported copies; persist the explicitly adopted host identity; fail closed on unreadable matching sidecars; and describe the normalized filename as a similarity hint. The final parent rerun passed all 218 tests across seven relevant suites. Existing local-path alias recovery remains compatible. The installed native recovery recheck remains pending.

The intermittent inline-expansion navigation failure was reproduced deterministically by waiting for the hidden viewport's ResizeObserver to report zero width before requesting navigation. The failing result arrived in 2.8 ms, before the viewer adapter's timeout. The reader bridge now waits, bounded to 1.5 seconds and fenced by generation, reader identity, visibility and navigation operation, for usable geometry before dispatch. A separately reproduced race changes the query during that wait: the old result is now rechecked before dispatch and is not selected or navigated if absent. Annotation targets are likewise resolved at dispatch. Focused review `navigation-readiness-DNdXvxUr` completed; its one P2 stale-search finding was applied and verified. Final parent verification passed 146 reader/bridge/layout tests, all six extension Chromium acceptance tests, typecheck and production builds. Native installation checks below still require a fresh reader invocation.

### Native saved-copy recovery passed, November 5, 2026

After restarting Codex and opening the same original through Opaque Test, build `e0a0933c` offered the distinct matching-copy choice. Selecting Resume protected review restored “Native autosave check two,” the existing stamp, and the selected local copy. The workspace toggle and Annotations tab were directly clickable with the new discussion layout. The user edited the highlight to “Native autosave check three”; the reader returned Saved. Parsing the same `/private/tmp/placekeeper-native-copy-check/native-autosave-check.pdf` confirmed the third comment and stamp (3457 bytes, SHA-256 `24684dcc9027554401377af2a69666a34617aa4eb9f9b6560f5a68d00581a9a4`). The original remained `95ab8b413dc9d0352eb8caadf69b9df801517a631e56b62853d9abb5b91e5e02`. This qualifies explicit changed-URI recovery across service/Codex restart and continued native autosave to the same copy for the writable test source. Read-only native qualification and the other outstanding host checks remain pending.


### Follow-up refresh and read-only preparation, November 5, 2026

The current Opaque Test reader's live inspection returned generation 1/revision 50 with “Native autosave check three” and the stamp. Clicking Refresh PDF completed with the same accepted state; the subsequent live page-navigation call returned navigated. This checks expanded navigation after refresh, not collapsed expansion. Opening Save options presented a new-copy proposal with no selected folder; cancel retained Saved. That proposal does not itself identify the active destination, so no destination-restoration claim is inferred from the dialog.

The existing disposable `dist/extension-candidate-opaque/read-only-test.pdf` is 1326 bytes, mode 0444, and `os.access(..., W_OK)` returns false. Its SHA-256 is `680647716f2336daf1bed3c4361eacd82274e30207a5d108105fcb1f70b21654`. Native file-menu opening through Opaque Test is the next human-assisted step. Filesystem permissions alone do not qualify host read-only metadata or copy autosave; those remain pending observation.


### Native filesystem-read-only source copy autosave passed, November 5, 2026

The user opened `read-only-test.pdf` through Opaque Test. Live inspection confirmed its expected source digest at generation 1/revision 0. The user selected the temporary destination folder through the real picker; Save created `/private/tmp/placekeeper-native-copy-check/native-read-only-copy-check.pdf`, initially containing the supported highlight and unsupported stamp (3349 bytes, SHA-256 `6129b945efec95b0b82b5d5bc5b7a0d672d4415f8fe5da27a21adfef0ebeffe5`).

After user assistance opening the hover-only edit action, two consecutive edits completed with Saved. Parsed copy bytes contained “Native read-only autosave check one” (3520 bytes, SHA-256 `0e789bbba9a78a981f0d68ccf96b2c5b77d4d126bdf821aac221e6bd8fbe7b70`), then “Native read-only autosave check two” (3521 bytes, SHA-256 `a0fec328e4277a620e0dc719ee70ab7db21cb7f1070f2d42099ff2b40c36e4f6`). Both retained the stamp. The original remained 1326 bytes with SHA-256 `680647716f2336daf1bed3c4361eacd82274e30207a5d108105fcb1f70b21654` and its original comments after each edit. No host download was needed. This qualifies native copy creation and successive autosaves with a filesystem-read-only source; the host's advertised writable metadata was not directly inspected. Reopening this read-only-source review and continuing to the same copy remains pending.


### Read-only close/reopen blocked by retained ownership

After the user closed and reopened the read-only fixture, the old reader disappeared from the MCP Apps tab list and the fresh panel displayed “A saved-copy review with matching PDF contents and a similar filename is already open. You can open an independent review.” Only independent review and cancel were offered. No choice was selected and no takeover was attempted. This close/reopen check failed; the two verified copy autosaves remain valid.

The recovery offer's `canResume` is false while `ExtensionRuntimeManager.#hasReviewGrant` finds any grant for the matched review. Presentation expiry suspends the panel but retains its continuation grant until the 30-minute idle deadline. The shell's explicit teardown invokes revoke after awaiting host resource disposal; transport close invokes disconnected instead. These paths explain the ownership guard but do not establish whether this native close omitted teardown or failed/delayed its cleanup/revoke. The missing lifecycle evidence must be resolved before claiming a causal fix.


### Teardown ordering correction and mention fallback

A regression with a real host adapter and deferred host unsubscribe failed because no grant revoke was dispatched. Teardown now fences the reader and dispatches revoke before cleanup; resource unsubscribe no longer delays its completion. The same test then passed, together with all 72 shell, adapter and extension-runtime tests. Typecheck and all four production builds passed. Focused code review `20261105-184715-6741e516` completed without findings, including a local adversarial read. This fixes the demonstrated cleanup-ordering defect; it does not yet prove the native host delivers teardown or that it caused the observed retained owner.

Mention copy now qualifies retrieval by host composer support and points to editable selection/annotation drafts when Placekeeper is absent from the mention menu. All six extension Chromium checks passed at desktop and narrow widths. A redundant second browser run was interrupted after the completed passing run and adds no evidence. The combined plan unit selection passed 1,891 of 1,892 tests; a qualification-experiment concurrent-publication failure also reproduced in a focused rerun and is being diagnosed separately. The first restricted integration attempt was stopped after local-server permission failures; those are not product failures.


Both isolated candidates were rebuilt and installed from `15409216009322f89803e43c4329d3fd85cadca7`. Ordinary build at `2026-11-05T23:50:24.830Z`: bundle `0e08235c6d5cd63a94fc046da96a07b1028bc49f6586a49a50b1cb65aae18922`. Opaque build at `2026-11-05T23:50:25.438Z`: bundle `c5b2eeddc3e388c967c0ddf23f421269d94bf588a16fa84f897d3a599e01b76b`. All 13 installed plugin-file hashes matched for each. Both services restarted with their existing recovery roots; disposable source bytes were preserved and included in each updated manifest digest. Fresh native uptake and close/reopen requalification are pending.


### Read-only saved-copy recovery after restart passed

After the user restarted Codex and reopened the read-only source, the new panel contained the updated host-qualified mention text, confirming uptake of the `15409216` reader. The matching-copy offer allowed Resume protected review and restored “Native read-only autosave check two” with the same two annotation identities. After the user opened the hover-only edit control, “Native read-only autosave check three” returned Saved and was parsed from the existing `/private/tmp/placekeeper-native-copy-check/native-read-only-copy-check.pdf` (3550 bytes, SHA-256 `e09cbc840ed7ba761213c44b56cb6d1957b2802d44b01408906fa3c00a569aff`), with the stamp intact. The original remained 1326 bytes with SHA-256 `680647716f2336daf1bed3c4361eacd82274e30207a5d108105fcb1f70b21654`. This qualifies recovery after service/Codex restart and continued saving from the filesystem-read-only source. It does not yet qualify close/reopen without restarting; that separate test is pending.


### Final combined automated run

The combined plan unit selection passed all 1,894 tests across 110 files after making qualification-process startup/publication boundaries explicit and awaiting worker/broker shutdown before fixture removal. The concurrent run-publication uncertainty remains separately tested as incomplete; it is not hidden by treating unexpected worker errors as expected uncertainty. The result is recorded in `/private/tmp/placekeeper-final-unit.json`. Native close/reopen without a restart remains pending and is not inferred from this automated pass.


### Native close cancels release requests, November 5, 2026

The user closed and reopened without restarting Codex. The fresh Opaque Test panel again offered only an independent review because the saved-copy review still had an owner. No independent review was opened. This invalidates cleanup ordering as a sufficient native close fix.

The host log for this invocation gives the decisive boundary (November 6 UTC, November 5 Eastern): at 00:31:39.015 it removed the app registration; at .036 it sent resource teardown; at .037 it removed the sandbox; outgoing app tool requests at .114 and .151 were cancelled with AbortError before server-tool dispatch. Therefore even an immediate revoke in the teardown callback cannot rely on a working host route. This is distinct from the previously fixed resource-unsubscribe delay. Production grant/ownership guards are retained; an inactive or sleeping panel is not silently taken over.

An explicit Close review control now requests ownership release while the panel is registered, waits for confirmation, and only then requests host teardown. Failed release keeps the panel fenced and offers retry. The native close button remains subject to the host limitation. Automated tests verify ordering and retry; installed-host validation of this fallback is pending.

The focused review `20261105-193733-24bc8730` found two release-retry cases; both are fixed. A lost successful revoke reply can be retried against a five-minute digest-only closed receipt, which cannot resume access or revoke a different rotated grant and is not extended by replay. Close is blocked while an unresolved resume operation could still hold a rotated grant. Both regressions failed before the fixes; all 76 shell/adapter/runtime tests passed afterward, as did the tightened receipt-expiry regression, typecheck, six Chromium checks and production service/client/server builds. Native explicit-close qualification remains pending.
