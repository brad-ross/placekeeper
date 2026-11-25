# Claude Desktop qualification

## Current result

Cases 1 and 2 passed on macOS by user report on 2026-11-22: the development candidate's server connected, `open_pdf_file` drew the view, and the reader worked. No Claude Desktop, macOS or checkout versions and no logs were recorded with that report, so rerun both cases with full records when running the rest. Every other case is not yet run case by case. Separately, on 2026-11-23 the owner reported that the Placekeeper view, chat context, chat-driven search and the reopening dialog worked with the development candidate in Claude Desktop 6.28899.6 on macOS 26.7.1; record those cases here with logs when they are run against this checklist. Installed-app setup (case 19) has unit tests only and has not been run against a real Claude Desktop. Claude Desktop support is in code (`apps/codex-mcp/src/claude-desktop-server.ts`, `standard-model-context.ts`, `reader-bridge.ts`) and in the development candidate's `claude-desktop-config.json`. Automated tests and browser stubs are not host evidence. No release support is asserted. The user guide is [Documents in Claude Desktop](../guides/claude-desktop.md).

## Setup

Run on a Mac. Build and start the default candidate as described in `scripts/extension-candidate/README.md`, then merge the `placekeeper-candidate` entry from `dist/extension-candidate/claude-desktop-config.json` into `~/Library/Application Support/Claude/claude_desktop_config.json` (**Settings → Developer → Edit Config**) and fully quit and restart Claude Desktop. Keep `dist/extension-candidate` in place and the daemon running in a foreground terminal throughout. Use only `dist/extension-candidate/disposable-test.pdf` and other disposable copies. No user PDFs are needed.

Record before starting: Claude Desktop version, macOS version, the checkout revision, and `build.json`'s `bundleSha256` and the `claude-desktop-config.json` digest. Cases 19 and 20 also need an installed Placekeeper built from the same revision; record its version.

**Logs:** MCP server logs are in `~/Library/Logs/Claude/mcp*.log`; the file for this server is named after `placekeeper-candidate`. **DevTools:** choose **Help → Troubleshooting → Enable Developer Mode**, then open DevTools on the app view to inspect its frame and console. Record relevant log lines and console errors with each case. Do not record grants, tokens or full user paths.

**Host capabilities:** after case 2, run `app.getHostCapabilities()` in the view's DevTools console and record the `updateModelContext` value, including which modalities it lists (`text`, `resource`, `structuredContent` and so on), or that it is absent. Chat context (cases 12 to 15) depends on it: without `updateModelContext` no context is published; with it but without `resource`, **Put document in context** publishes a text note instead of the PDF.

## Checklist

Run in order. Stop at case 2 if it fails.

1. **Server connected.** Open **Settings → Developer** and the chat's tool menu. Record whether `placekeeper-candidate` shows as connected, whether `open_pdf_file`, `open_placekeeper`, `inspect_review`, `search_document`, `navigate_page`, `reveal_search_result`, `reveal_annotation` and `read_document_text` are listed (the app-only `extension_app` and `reader_bridge` tools should not be offered to the model), and whether the **Open a PDF in Placekeeper** prompt (`open_pdf`) is listed. If the server fails to start, record the log error.
2. **View draws (go/no-go).** In a new chat, ask "Open `<absolute path to dist/extension-candidate/disposable-test.pdf>` in Placekeeper". Allow the tool when asked. Record whether Claude draws the Placekeeper view inline with a status line and **Open reader**. If Claude shows only text, stop: record that local servers do not render MCP Apps in this Claude Desktop build, and include the text shown. If the text is "This app cannot show the Placekeeper reader because it does not support MCP Apps views…", record that Claude did not advertise MCP Apps support to the server.
3. **Fullscreen and rendering.** Record whether the view opened fullscreen or in a side panel on its own (the resource asks for `preferredDisplayMode: fullscreen`). If it is inline, choose **Open reader**; Claude grants fullscreen only after a click in the view. Record whether the view expands to fullscreen and the PDF pages render. The shell HTML is about 3.5 MB inline; record any size, load or blank-frame failure with log and console lines. If expansion is refused, record the message shown.
4. **Annotate and save.** Add a highlight and a note. Click the filename, choose **Save to a new copy**, and pick a folder and filename in the native picker. Record whether the copy is written, whether later edits autosave to it, and the save status shown.
5. **Chooser.** In a new chat, ask Claude to open Placekeeper without a path. Record whether `open_placekeeper` shows the chooser, whether the system file picker opens a disposable PDF, and whether **Recent Documents** lists the earlier document with **Resume** and **Open Copy**. Cancel the picker once and record that existing work is unchanged.
6. **Close and reopen.** Close the view (or the chat), then open the same PDF again by path. Record whether the **Reopen Document** dialog says "You had this document open earlier." with **Cancel**, **Open Copy** and **Continue**, whether **Continue** restores the accepted annotations and save destination, and what **Open Copy** produces.
7. **Private data stays private.** After case 2 or 6, ask Claude to repeat the raw tool result exactly, including any metadata. Record the text Claude reports. Record whether any 43-character base64url string (the grant) appears. It must not: Claude should see only "Opened disposable-test.pdf in Placekeeper…".
8. **Rejected inputs.** Ask Claude to open a relative path (`disposable-test.pdf`), a non-PDF file (for example `build.json`), and a missing `.pdf` path. Record that each returns "Placekeeper can open only an existing local .pdf file given by its absolute path." and that no view opens.
9. **Prompt.** From the **+** menu choose **Open a PDF in Placekeeper**. Run it once with the fixture's absolute path and once empty. Record whether the first opens the PDF and the second opens the chooser.
10. **Second chat conflict.** With the fixture open in one chat, open the same PDF in a second chat. Record whether the **Reopen Document** dialog says "This document is still open elsewhere…" and offers **Cancel**, **Open Copy** and **Check again**, that the second chat cannot take over the open document, and that **Open Copy** keeps an independent document. After closing the first view, record whether **Check again** turns into "You had this document open earlier." with **Cancel**, **Open Copy** and **Continue**.
11. **Teardown.** Close or delete the chat with the open view. Record whether the server log or daemon shows release of the document, and whether reopening from a new chat then offers **Continue** without a conflict. If teardown does not arrive, record how long until the connection expires.
12. **Background context.** Open a multi-page disposable PDF, choose **Open reader**, go to page 2 and select a sentence. Without attaching anything, ask "What page am I on, and what text did I select?". Record Claude's answer and whether it matches. Move to another page, clear the selection, ask again, and record whether the answer reflects the change (each update replaces the previous one).
13. **Add selection and annotation to chat.** Select text, choose the bot button, **Add selection to chat**, add a note and choose **Add to chat**. Record whether the prompt text stays unchanged, no message is sent, and Claude can quote the selection and note when asked. Repeat with **Add annotation to chat** on an existing highlight, then reopen its bot action, edit the note, and record whether Claude sees the edited note. Record whether Claude shows anything that lets you remove these attachments.
14. **Document note and full text.** Click **Put document in context**. Record whether the button reads "Document in context: Claude can read this PDF on request." Ask Claude to summarize the whole document and record whether it calls `read_document_text` and the page ranges it requests. Use a PDF whose text exceeds 100,000 characters, or ask for the full text of a long one, and record whether the result ends with "Continue with read_document_text startPage: N" and whether Claude continues from that page. Record any page shown with "[No reliable extracted text on this page.]".
15. **Search, reveal and navigate.** With the reader expanded, ask Claude to search for a word that appears on several pages, reveal the second result, then go to the last page. Record the tool calls (`search_document`, `reveal_search_result`, `navigate_page`), whether the reader highlights the result and reaches the page, and whether search coverage is reported. Ask Claude to reveal an annotation and record `reveal_annotation`. Then collapse the reader (or start a new view without choosing **Open reader**) and repeat; record whether the tools answer `unavailable` with "Open the Placekeeper reader…" and whether they succeed after you choose **Open reader**.
16. **No view open.** In a new chat with no Placekeeper view, ask Claude to search the open PDF. Record whether it gets "No Placekeeper reader is open…".
17. **Two views route to the most recent.** Open PDF A, then PDF B in the same chat or a second chat. Ask Claude for `inspect_review` and record which document answers (it should be B). Close B's view and repeat; record whether A answers or the call reports no reader, and how long that takes.
18. **Grant stays private in reader tools.** Ask Claude to repeat the raw results of `inspect_review` and `read_document_text` exactly. Record whether any 43-character base64url string appears. It must not.
19. **Installed-app setup.** Remove the candidate entry and stop the candidate daemon. Add a dummy server to `claude_desktop_config.json` and save a copy of the file. In the installed Placekeeper choose **Help → Set Up Integrations**, select **Claude Desktop (experimental)**, and record the reported outcome. Record whether a `placekeeper` entry was added under `mcpServers` and the dummy server and other settings are unchanged. Restart Claude Desktop and repeat cases 1 and 2 against `placekeeper`. Run setup again and record whether it reports the server as current without changing the file. Then replace the entry with a hand-written `placekeeper` entry, run setup, and record whether it leaves that entry untouched and reports it. Also try `./install.sh --claude=setup` from a source install if available, and record its outcome. Restore the saved file afterwards.
20. **File → Open in Claude.** Open a disposable PDF in the Placekeeper desktop app and choose **File → Open in Claude**. Record whether Claude Desktop opens a new chat with `Open "<path>" in Placekeeper.` typed but not sent, and whether sending it opens the same PDF. Record whether the item is disabled with no PDF open, and what Placekeeper shows when Claude Desktop is not installed.

When finished, remove the `placekeeper-candidate` entry (and the `placekeeper` entry from case 19 if you do not keep it), restart Claude Desktop, stop the daemon with Control-C, and keep the evidence needed for this record.

## Results

| # | Case | Result | Notes |
|---|---|---|---|
| 1 | Server connected, tools and prompt listed | Passed (macOS, user report 2026-11-22; no recorded versions or logs) | |
| 2 | View draws (go/no-go) | Passed (macOS, user report 2026-11-22; no recorded versions or logs) | |
| 3 | Fullscreen and rendering | Not yet run | |
| 4 | Annotate and save to local copy | Not yet run | |
| 5 | Chooser and Recent Documents | Not yet run | |
| 6 | Close and reopen | Not yet run | |
| 7 | Grant not visible to the model | Not yet run | |
| 8 | Rejected inputs | Not yet run | |
| 9 | `open_pdf` prompt | Not yet run | |
| 10 | Second chat conflict | Not yet run | |
| 11 | Teardown | Not yet run | |
| 12 | Background context | Not yet run | Record `updateModelContext` modalities |
| 13 | Add selection and annotation to chat | Not yet run | |
| 14 | Document note and `read_document_text` continuation | Not yet run | |
| 15 | Search, reveal and navigate; unavailable when collapsed | Not yet run | |
| 16 | No view open | Not yet run | |
| 17 | Two views route to the most recent | Not yet run | |
| 18 | Grant not visible in reader tool results | Not yet run | |
| 19 | Installed-app setup, rerun and foreign entry | Not yet run | |
| 20 | File → Open in Claude | Not yet run | |
