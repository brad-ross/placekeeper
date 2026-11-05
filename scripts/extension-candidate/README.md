# Production extension candidate

This packages the current production reader, extension MCP server, and service into a separate development marketplace. It does not install or replace the production plugin or the earlier compatibility probe.

From the checkout, build the service, web client, and Codex app/server, then package:

```sh
pnpm build:service
pnpm build:codex
pnpm exec tsx scripts/extension-candidate/build.ts
```

Keep `dist/extension-candidate` in place throughout qualification. Record its `build.json` bundle digest and individual server, reader and service digests in the qualification record. The recorded revision may have a modified working tree; the file digests identify the actual artifact.

The production web build contains its asset manifest, app JavaScript/CSS, PDFium WASM and browser/Codex workers; the service generates HTML. Packaging checks those actual assets and copies the complete web tree beside `runtime/service/main.js`, where the service resolves its `../web` assets. The launcher also points the service's native PDF engine explicitly to that copied `pdfium.wasm`. There is no required web `index.html`.

Start the generated `start-daemon.mjs` with the Node executable printed by the packaging command, in a foreground terminal. It runs the copied service with development identity, a dedicated recovery/control root under `/private/tmp/pk-extension-…` (the exact path is in `build.json`), and port 48763. The short root keeps the control socket within macOS's socket path limit. Both MCP and service use that same root and port. Stop it with Control-C after testing. Do not connect it to the installed service or reuse the installed recovery root. If this candidate daemon is already running, reuse that same artifact; stop it before rebuilding the candidate.

Register the local marketplace at `dist/extension-candidate` through the supported host plugin flow and select `placekeeper-extension-candidate@placekeeper-extension-candidate-test`. The display name is **Placekeeper Extension Candidate** and the MCP server name is `placekeeper-extension-candidate`. Start a fresh host invocation after installation. Use only the copied `disposable-test.pdf` and other disposable fixture copies for native writes/conflicts. No user PDFs are needed.

Open that fixture through its native file-menu extension action. For recovery, explicitly close and reopen through the file action; the earlier probe's browser-page reload experiment failed on this host. Once the user opens the app, its embedded MCP Apps surface can inspect the reader and invoke tools. Installation, host restart, and native file-menu controls require supported native host access or the user's assistance.

Record actual-host results separately from browser stubs in `docs/testing/chatgpt-extension-qualification.md`. Verify direct conversation entry, context removal, exact search/reveal, collapsed expansion, editable discussion drafts, sharing and mention controls, resource updates, conditional writes/conflicts, reconnect and protected recovery. Stop the candidate daemon and remove its marketplace/plugin through the supported host flow after qualification; retain needed evidence first. Do not remove the earlier compatibility probe until its evidence is no longer needed.
