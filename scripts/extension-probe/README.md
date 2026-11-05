# Placekeeper extension host probe

This standalone plugin qualifies host entrypoints before production admission and recovery are changed. It never connects to the Placekeeper service, writes a PDF, or sends a chat message. File names, URIs, source paths, file bytes, and the private test nonce are excluded from its observation log. The nonce authorizes only bounded test observations, not a review. Testing nonce replay establishes host delivery behavior, not production isolation by itself.

Build and verify from the repository root:

```sh
node --import tsx scripts/extension-probe/build.ts
node node_modules/vitest/vitest.mjs run scripts/extension-probe/server.test.ts scripts/extension-probe/packaged.test.ts
node --import tsx scripts/extension-probe/browser-smoke.ts
```

The browser smoke uses an isolated headless Chromium profile and synthetic MCP host. It cannot qualify ChatGPT behavior. Its screenshots and result explicitly identify that scope.

## Install the candidate

1. Open ChatGPT's Plugins page and add a **local marketplace** using this checkout's `dist/extension-probe` directory. In a macOS folder picker, Command-Shift-G accepts the full path.
2. In **Placekeeper Extension Test**, install **Placekeeper Extension Probe** (`extension-probe`). Review and approve its trust prompt if acceptable. Leave the existing Placekeeper plugin installed.
3. Reload the plugin through the supported host controls, or fully quit and reopen ChatGPT if a reload control is unavailable. Return to this chat.

The equivalent supported CLI registration commands are `codex plugin marketplace add <absolute-path-to-dist/extension-probe> --json` and `codex plugin add extension-probe@placekeeper-extension-test --json`. Native trust and reload still need host verification. The generated registration uses absolute paths to this candidate and the current Node executable; keep the checkout and candidate directory in place while testing.

## First host test

Open `dist/extension-probe/disposable-test.pdf` in ChatGPT, then select **Placekeeper Extension Probe** from the PDF's open-with/extension action. Do not send an “open PDF” message: this check is specifically for the direct entrypoint.

The probe should display **Connected**, `privateResultReceived: true`, and `resourceRead` containing `pdf: true`. It is intentionally a diagnostic panel, not yet the review reader. If the entrypoint is absent or the panel fails, report that exact outcome instead of trying the existing Placekeeper skill.

Then collapse and reopen the panel. Click **Reload this probe** once. Note whether the invocation stays the same, a new mount ID appears, and the private result arrives. These are observations, not assumptions that the host replays results.

Optionally click **Attach test context marker**, remove the marker in ChatGPT, then click **Read PDF again**. The probe does not republish automatically. Its `hostContextPresent` display and `host-context` observations report the notification it receives.

The next test can ask chat to call `inspect_placekeeper_probe` while expanded and collapsed, if the host exposes that live tool. It returns only the test mount state, never PDF text.

## Evidence and cleanup

`dist/extension-probe/build.json` identifies the exact bundles. `observations.jsonl` is the local append-only diagnostic log. Screenshots are mock-host evidence only. No observation file exists until the real server receives a test invocation. Inspect the log after the native actions and record results in `docs/testing/chatgpt-extension-qualification.md`.

Uninstall **extension-probe@placekeeper-extension-test** through the host when qualification is finished. This does not remove the normal Placekeeper plugin. Host write/conflict tests and production authority tests require the later candidate; this probe deliberately does not claim to cover them.
