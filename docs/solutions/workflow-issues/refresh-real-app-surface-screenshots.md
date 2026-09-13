---
title: Refresh real app surface screenshots without rebuilding the staging workflow
date: "2026-09-12"
last_updated: "2026-09-12"
category: workflow-issues
module: Landing page app surface captures
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Refreshing landing-page screenshots after the reader or host interface changes"
  - "Preparing isolated Mac, ChatGPT, Chrome Extension, VS Code, and Web demo windows"
tags: [screenshots, landing-page, isolated-profiles, vscode, chrome, chatgpt, macos]
---

# Refresh real app surface screenshots without rebuilding the staging workflow

## Context

The September 2026 landing-page work replaced reconstructed host illustrations with real windows. Most of the effort was staging: a clean editor profile still had an obsolete extension payload, native automation sometimes exposed controls without screenshots, the wrong similarly named window was resized repeatedly, and a fresh chat accidentally reused a review owned by an older staging task. These details cannot be recovered from the final image files.

This is a repeatable capture recipe, not a claim that every app version exposes the same controls. The commands below are setup templates; inspect current installed paths and current tool permissions first. Temporary folders from the original session are not durable dependencies. The captures and source changes are present on the working branch as of this date; no upstream merge is asserted.

## Guidance

### Quick refresh checklist

1. Identify affected surfaces and keep the accepted compositions below.
2. Build current artifacts and verify the exact installed consumer/profile.
3. Prepare the authorized paper/source copies and isolated native-host registration.
4. Stage the page, tray, query, and pane widths before sizing the window.
5. Identify the intended window, resize it, and inspect the readback.
6. Capture without overlays; inspect the original PNG, then integrate and rebuild.

For each refresh, record in the asset provenance: capture date, source revision/build identifier, host build, paper version, original page/tray/query state, window point dimensions if measured, actual image pixels, and asset filename. Record disposable profile paths only in local staging notes; never record credentials or capability URLs. Do not infer an exact point-size readback from the user's “worked” confirmation; the supplied image dimensions are independently inspectable.

### 1. Decide the five compositions before opening apps

| Surface | Composition used | Target asset | Captured pixels |
| --- | --- | --- | --- |
| Mac | Section 4.1, original page 14; Search tray with literal `\Gamma` | `surface-mac.png` | 2400 × 1504 |
| ChatGPT | Clean question and proof intuition on the left; Theorem 1 on original page 15 in Placekeeper on the right; sidebar hidden | `surface-chatgpt.png` | 2880 × 1800 |
| Chrome Extension | Original arXiv PDF URL visible; page 14 above Appendix A, page 31, in the bottom References tray | `surface-chrome.png` | 2880 × 1800 |
| VS Code | Real Section 4.1 TeX source left, Placekeeper page 14 right; workspace named `paper` | `surface-vscode.png` | 2880 × 1800 |
| Web | Top of the landing page with the brand and Upload PDF/link box, in a clean browser | `surface-web.png` | 1152 × 768 |

The canonical asset inventory is `apps/web/src/landing/assets/README.md`; selection and intrinsic image dimensions live in `apps/web/src/landing/SurfaceShowcase.tsx`. Preserve the screenshot's aspect ratio. Inspect file signatures as well as names: the existing `surface-web.png` is actually JPEG data at the recorded dimensions. Browsers load it, but future captures should use an extension matching the actual format; do not assume every `.png` asset is PNG. Existing captures have different resolutions; standardize new captures around a 1440 × 900 point window when practical, not by stretching old images.

Use the same paper and version across surfaces: arXiv **2312.07520v3**, *Estimating Counterfactual Matrix Means with Short Panel Data*. The full paper has 100 pages. Use original page labels, not excerpt indices. Stage the native/editor/chat screenshots with a full local copy; the interactive landing demo has a separate bounded excerpt. Obtain the authorized source PDF afresh if the temporary copy is gone.

The historical staging folder was `/private/tmp/paper`, with `Counterfactual Matrix Means.pdf` and a user-cleaned `theory.tex`. The authorized TeX source was `/Users/bross1/Library/CloudStorage/Dropbox-Personal/Apps/Overleaf/short_panel_general_missingness/paper/sections/theory.tex`. That is a user-specific source location, not a repository fixture. Copy the latest user-approved source; do not keep an earlier staging copy after the user removes comments. Do not edit the original Overleaf project merely to improve a screenshot.

### 2. Prove that the installed consumer is current

Do this **before** arranging panes and capturing. A current source tree or native app does not establish a current VS Code extension. The extension embeds its own reader assets. Identical version strings can conceal different builds.

Current build entrypoints in `package.json`:

```sh
pnpm build:vscode
pnpm build:chrome
pnpm package:macos
pnpm build:static:pages
```

Use only the targets required by the changed surfaces. `apps/vscode/package.json` rebuilds shared web output before its bundle, and `apps/vscode/copy-web-assets.mjs` copies those assets into the extension. Install the newly produced VSIX into the **same isolated profile used for capture**, using `--force` if the version is unchanged. The updater skips absent extensions and has no direct profile-flag options, so running it normally cannot bootstrap a new empty capture profile. Package the fresh VSIX using its implementation, then invoke the Code CLI yourself with the same two profile-directory flags plus `--install-extension <absolute-fresh-vsix> --force`. Reload that window and compare its installed manifest/assets with the intended build; do not trust the extension version alone. Consult `packaging/macos/update-vscode.mjs` for the repository's existing VSIX packaging/install implementation rather than inventing a second packaging format. It is an implementation reference, not a packaging-only command: it deletes its temporary VSIX on exit. Prepare and retain the staging archive separately when installing into a new profile.

For native captures, verify which app bundle is running. Updating a different copy under another Applications directory will not refresh an already running process. Prefer the supported installer or candidate workflow. During this session, modifying/re-signing an app in place caused launch trouble; avoid turning screenshot preparation into ad hoc signed-bundle surgery. Keep any diagnostic modifications temporary and remove them after diagnosis.

If pnpm/Corepack is blocked while dependencies already exist, the verified static build fallback was:

```sh
env PLACEKEEPER_STATIC_BASE=/placekeeper/ node_modules/.bin/vite build --config apps/web/vite.static.config.ts --configLoader runner
```

`--configLoader runner` avoided writing Vite's temporary config beside dependencies outside the writable worktree. Rebuilding matters: the local preview can serve an old distribution even after the source was edited. Reload the page after rebuilding, then verify the actual image URL and natural dimensions.

### 3. Isolate browser and editor state

Use separate, disposable profile directories. Do not sign in, import profiles, or load the user's extensions. Keep the **Chrome Extension** profile separate from the extension-free **Web** profile; otherwise the Web capture can accidentally illustrate the extension instead.

Illustrative Chrome for Testing launch, after checking the executable exists:

```sh
"/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" --user-data-dir=/private/tmp/placekeeper-capture-web-profile --no-first-run --no-default-browser-check http://127.0.0.1:4184/placekeeper/
```

Use a different `--user-data-dir` for the extension capture. Load only the current Placekeeper extension using the supported extension setup. Chrome for Testing was useful for this isolated setup; do not assume ordinary Chrome accepts every development-extension flag. The extension profile also needs a valid native-messaging registration pointing to the current installed Placekeeper endpoint and allowing the actual extension ID. The normal browser profile's registration is not evidence that the test profile can reach the host. `packaging/macos/chrome-integration.ts` owns manifest and endpoint validation. Do not bypass an opt-in prompt or manually invent an allowed origin.

For the extension capture, the supported unpacked extension is the picker-friendly **Placekeeper Chrome Extension** folder beside the installed app (`docs/installation.md`, `packaging/macos/chrome-integration.ts`). Load it through `chrome://extensions`, then enable automatic PDF opening in its popup; a new profile starts paused. Validate the actual extension ID against the current manifest and keep the native manifest restricted to that origin.

The isolated Chrome for Testing profile needed its own native-host registration in this session. The normal installer targets the ordinary Chrome registration, so do not assume it configures a custom test data root. The existing renderer can create a profile-local registration without hand-authoring security-sensitive JSON:

```sh
"/absolute/path/Placekeeper.app/Contents/MacOS/placekeeper" chrome-registration render --candidate-app "/absolute/path/Placekeeper.app" --installed-app "/absolute/path/Placekeeper.app" --output "/private/tmp/placekeeper-capture-chrome-profile/NativeMessagingHosts/com.placekeeper.chrome.json"
```

These app paths are substitution examples. `apps/service/src/cli/chrome-registration-command.ts` validates the bundle and absolute paths, creates the parent privately, and writes a new file without clobbering an existing one. Inspect an existing registration or use a fresh disposable profile rather than overwriting unrelated state. The profile-local lookup is historical working behavior here, not a guarantee for every Chrome distribution. Confirm the generated endpoint points to the current installed native wrapper, then prove a PDF actually opens in Placekeeper before staging the screenshot.

Illustrative VS Code launch:

```sh
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --user-data-dir /private/tmp/placekeeper-capture-code-profile --extensions-dir /private/tmp/placekeeper-capture-code-extensions --new-window /private/tmp/paper
```

Use those **same two directory flags** when installing the current extension with `--install-extension` and `--force`. Avoid `--disable-extensions`, which would disable Placekeeper too. A new window with the ordinary profile is not an isolated installation. If automation selects the wrong VS Code instance, inspect the window inventory and ask the user to close the competing instance if needed; don't repeatedly click an empty accessibility tree.

### 4. Stage each surface

**Mac:** open the full paper, navigate to page 14 and Section 4.1, select Search, and enter literal `\Gamma`. Choose a zoom that leaves useful source text and search results visible. Verify traffic lights are vertically centered after showing and resizing the window. AppKit can reset their frames during native layout, so checking only the initial programmatic frames is insufficient. The current fix reapplies positioning after native layout in `apps/macos/Sources/PlacekeeperMac/PlacekeeperWindowController.swift`; regression coverage is in `apps/macos/Tests/PlacekeeperMacTests/MacPoliciesTests.swift`. Capture the actual post-layout appearance.

**Chrome Extension:** open the real paper URL in the isolated extension browser, allow the normal Placekeeper handoff, navigate to page 14, follow Appendix A and place References on the bottom with page 31 visible. Retain the original arXiv URL in the address bar. This is the differentiator from the Web surface. Move the pointer away from reference controls so close/open actions or tooltips do not obscure the resting tabs.

**VS Code:** open the folder named `paper`, not `placekeeper-showcase`. Put `theory.tex` beside the Placekeeper PDF using **Placekeeper: Open Local PDF** or **Placekeeper: View PDF**, not another extension's PDF viewer. Scroll the TeX to the factor-identification material in Section 4.1 and the PDF to page 14. Focus the source editor before capture so the top bar identifies `theory.tex — paper`. Hide unnecessary sidebar, minimap, panels, and other elements through the isolated profile's UI. Right-click the status bar and uncheck **Screen Reader Optimized** if present; hide its status item rather than globally disabling accessibility. Retain the user's final UI choices. If a shared PDF is already tied to another surface, use an independent staging copy as in this session, without changing the original paper or claiming live source synchronization from an unmatched copy.

**Web:** use the extension-free browser profile and the rebuilt landing page. Show the hero and Try box, with no filled personal URLs, dialogs, or demonstration PDF covering the landing page.

**ChatGPT:** have the user create a clean task and type its messages themselves. Sending a prompt from another task produces a visible delegation attribution unsuitable for this screenshot. Complete installation and debug work in a different task **before** creating the photographic conversation. Hide the sidebar. Keep the theorem and opening proof intuition visible together. In this session the user used these messages:

> Open /private/tmp/paper/Counterfactual Matrix Means.pdf in Placekeeper and scroll to Theorem 1 on page 15.

> Explain the intuition behind the proof of Theorem 1 given that I understand the O^3 Algorithm.

Use the currently installed Placekeeper skill for opening, not a generic PDF extraction skill. If an earlier task owns the same review, an independent review is needed; opening a browser alone does not prove agent context. Have the user send a normal follow-up and verify a current context envelope and successful scoped evidence retrieval before using context-dependent answer claims. Cross-task follow-ups in this session did not supply that refresh. Do not reuse old task bindings or replay launch proofs. The final supplied screenshot visually shows the conversation and theorem; a green icon or screenshot is not itself evidence that a particular earlier diagnostic retrieval succeeded.

### 5. Size the correct window, not the first similarly named accessibility window

Aim for **1440 × 900 macOS points**, which produced 2880 × 1800 Retina PNGs here. Move the window to a display large enough for it and exit full screen first. Read back the result after resizing.

The important discovery: the relevant process in the user's actual accessibility inventory was **ChatGPT**, not Codex. It exposed two windows with the same name. One was a tall narrow window (758 × 1862) and the useful main window was 1470 × 923. Targeting `front window` or even `window 2` repeatedly reported the narrow window. The user successfully selected the wide window by dimensions instead.

The following is a **user-run Script Editor recipe**, verified by the user in this session. It is not authorization for an agent to circumvent Computer restrictions on controlling the host app. Check current tool restrictions; if host control or capture is blocked, let the user run this and supply the PNG.

```applescript
tell application "System Events"
    tell process "ChatGPT"
        repeat with w in windows
            set {windowWidth, windowHeight} to size of w
            if windowWidth > 1000 and windowHeight < 1200 then
                set size of w to {1440, 900}
                set position of w to {15, 33}
                exit repeat
            end if
        end repeat
        delay 1
        set report to {}
        repeat with w in windows
            set end of report to {position of w, size of w}
        end repeat
        return report
    end tell
end tell
```

Expected: the inventory includes position `{15, 33}` and size `{1440, 900}`. If several windows satisfy the condition, do not blindly choose the first; inspect them or close extra demo windows. The predicate describes this session's layout, not a stable app API.

If `process "Codex"` gives **Invalid index**, do not immediately blame Accessibility permission: the process may expose no windows while the UI is owned by ChatGPT. Inventory the frontmost app after a short delay, click the intended window during that delay, and record names, positions, and sizes. A returned size of 758 × 1862 does not mean 1440 × 900 succeeded. If the dimensions do not change, stop guessing indices. Script Editor may need Accessibility authorization, but permission does not fix selecting the wrong window.

### 6. Capture, inspect, and integrate

For a user-run macOS window capture:

1. Dismiss menus, tooltips, selection affordances, and transient notifications. Let scrolling and tray animations finish.
2. Move the automation pointer/overlay outside the target window. A computer-use cursor overlay appeared in an early VS Code capture even though a normal screenshot cursor would be excluded.
3. Press **Shift–Command–4**, then **Space**. Hold **Option** while clicking the target window to omit its shadow.
4. Inspect the saved original PNG at full resolution. Check the title, source comments, profile/account chrome, native buttons, tab resting states, and all four edges. Do not rely only on a downsized preview.
5. Preserve the original pixels. Do not redraw the host chrome, generate a fake conversation, or stretch/crop away required context merely to avoid restaging.
6. Copy to the matching `surface-*.png` asset, update `SurfaceShowcase.tsx` intrinsic dimensions and descriptive alt text, and record the source/date/state in the asset README.
7. Rebuild the static distribution, reload the preview, select every changed surface, and verify the image loads at its actual natural size and fits at both desktop and narrow widths. On narrow layouts the horizontal cards belong **above** the screenshot, leaving the document more readable.

Computer may expose accessibility controls while returning **Screenshot unavailable**. This is not proof that Screen Recording permission is disabled, and repeatedly asking the user to enable an already enabled permission wastes time. Diagnose the supported capture surface once; where the tool blocks the host app, hand capture to the user. In this session the final ChatGPT screenshot was user supplied, while native Mac, Chrome Extension, and VS Code captures used authorized cursor-free window captures. Alternate CLI launches were explicitly authorized. Re-check the current session's tool instructions rather than treating these historical permissions as a universal exemption.

## Why This Matters

The image is the last step. Most wasted time came from stale consumer assets, shared review ownership, wrong accessibility-window identity, and incidental UI state. Stabilizing those first makes later interface refreshes a short restaging job instead of another debugging session. Real windows also preserve the exact host/reader proportions that hand-built illustrations got wrong.

## When to Apply

Use this recipe when replacing any landing-page app surface after interface changes. Do not retake every surface automatically if a change affects only one host. Recheck paper version, current installed build, profile isolation, window identity, and output dimensions each time; none should be inferred from old filenames or version strings.

## Examples

The final ChatGPT integration removed the last mock branch in `SurfaceShowcase.tsx`: every surface now selects a real capture and renders the same proportional image element. In the recorded session, the static build and the static-runtime test run (32 executed cases) passed, and the browser reported the supplied image loaded at 2880 × 1800. These verify integration, not the scientific correctness of the screenshot's answer.

## Related

- [Refresh independently installed VS Code payloads](../integration-issues/refresh-independent-vscode-payload-after-app-install.md)
- [Task-scoped live PDF context](../architecture-patterns/task-scoped-prompt-refreshed-live-pdf-context.md)
- [Shared production review client](../architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)

- [Diagnose unbound agent context](../integration-issues/diagnose-open-pdf-with-unbound-agent-context.md)
- [Production reader demo boundaries](../design-patterns/production-reader-demos-with-bounded-real-paper.md)
