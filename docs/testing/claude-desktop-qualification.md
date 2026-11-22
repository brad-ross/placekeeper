# Claude Desktop qualification

## Current result

Not yet run. Claude Desktop support exists in code (`apps/codex-mcp/src/claude-desktop-server.ts`) and in the development candidate's `claude-desktop-config.json`, but no check below has been performed in a real Claude Desktop. Automated tests and browser stubs are not host evidence. No release or installed-app support is asserted. The user guide is [PDF review in Claude Desktop](../guides/claude-desktop.md).

## Setup

Run on a Mac. Build and start the default candidate as described in `scripts/extension-candidate/README.md`, then merge the `placekeeper-candidate` entry from `dist/extension-candidate/claude-desktop-config.json` into `~/Library/Application Support/Claude/claude_desktop_config.json` (**Settings → Developer → Edit Config**) and fully quit and restart Claude Desktop. Keep `dist/extension-candidate` in place and the daemon running in a foreground terminal throughout. Use only `dist/extension-candidate/disposable-test.pdf` and other disposable copies. No user PDFs are needed.

Record before starting: Claude Desktop version, macOS version, the checkout revision, and `build.json`'s `bundleSha256` and the `claude-desktop-config.json` digest.

**Logs:** MCP server logs are in `~/Library/Logs/Claude/mcp*.log`; the file for this server is named after `placekeeper-candidate`. **DevTools:** choose **Help → Troubleshooting → Enable Developer Mode**, then open DevTools on the app view to inspect its frame and console. Record relevant log lines and console errors with each case. Do not record grants, tokens or full user paths.

## Checklist

Run in order. Stop at case 2 if it fails.

1. **Server connected.** Open **Settings → Developer** and the chat's tool menu. Record whether `placekeeper-candidate` shows as connected, whether `open_pdf_file` and `open_placekeeper` are listed (the private `extension_app` tool should not be offered to the model), and whether the **Open a PDF in Placekeeper** prompt (`open_pdf`) is listed. If the server fails to start, record the log error.
2. **View draws (go/no-go).** In a new chat, ask "Open `<absolute path to dist/extension-candidate/disposable-test.pdf>` in Placekeeper". Allow the tool when asked. Record whether Claude draws the Placekeeper view inline with a status line and **Open reader**. If Claude shows only text, stop: record that local servers do not render MCP Apps in this Claude Desktop build, and include the text shown. If the text is "This app cannot show the Placekeeper reader because it does not support MCP Apps views…", record that Claude did not advertise MCP Apps support to the server.
3. **Fullscreen and rendering.** Record whether the view opened fullscreen or in a side panel on its own (the resource asks for `preferredDisplayMode: fullscreen`). If it is inline, choose **Open reader**; Claude grants fullscreen only after a click in the view. Record whether the view expands to fullscreen and the PDF pages render. The shell HTML is about 3.5 MB inline; record any size, load or blank-frame failure with log and console lines. If expansion is refused, record the message shown.
4. **Annotate and save.** Add a highlight and a note. Click the filename, choose **Save to a new copy**, and pick a folder and filename in the native picker. Record whether the copy is written, whether later edits autosave to it, and the save status shown.
5. **Chooser.** In a new chat, ask Claude to open Placekeeper without a path. Record whether `open_placekeeper` shows the chooser, whether the system file picker opens a disposable PDF, and whether **Recent Documents** lists the earlier review with **Resume** and **Open Copy**. Cancel the picker once and record that existing work is unchanged.
6. **Close and reopen.** Close the view (or the chat), then open the same PDF again by path. Record whether **Continue** restores the accepted annotations and save destination, and what **Open Copy** produces.
7. **Private data stays private.** After case 2 or 6, ask Claude to repeat the raw tool result exactly, including any metadata. Record the text Claude reports. Record whether any 43-character base64url string (the grant) appears. It must not: Claude should see only "Opened disposable-test.pdf in Placekeeper…".
8. **Rejected inputs.** Ask Claude to open a relative path (`disposable-test.pdf`), a non-PDF file (for example `build.json`), and a missing `.pdf` path. Record that each returns "Placekeeper can open only an existing local .pdf file given by its absolute path." and that no view opens.
9. **Prompt.** From the **+** menu choose **Open a PDF in Placekeeper**. Run it once with the fixture's absolute path and once empty. Record whether the first opens the PDF and the second opens the chooser.
10. **Second chat conflict.** With the fixture open in one chat, open the same PDF in a second chat. Record whether the reopening dialog offers **Continue**, **Open Copy**, or **Check again**, that the second chat cannot take over the active review, and that **Open Copy** keeps an independent review.
11. **Teardown.** Close or delete the chat with the open view. Record whether the server log or daemon shows release of the review, and whether reopening from a new chat then offers **Continue** without a conflict. If teardown does not arrive, record how long until the connection expires.

When finished, remove the `placekeeper-candidate` entry, restart Claude Desktop, stop the daemon with Control-C, and keep the evidence needed for this record.

## Results

| # | Case | Result | Notes |
|---|---|---|---|
| 1 | Server connected, tools and prompt listed | Not yet run | |
| 2 | View draws (go/no-go) | Not yet run | |
| 3 | Fullscreen and rendering | Not yet run | |
| 4 | Annotate and save to local copy | Not yet run | |
| 5 | Chooser and Recent Documents | Not yet run | |
| 6 | Close and reopen | Not yet run | |
| 7 | Grant not visible to the model | Not yet run | |
| 8 | Rejected inputs | Not yet run | |
| 9 | `open_pdf` prompt | Not yet run | |
| 10 | Second chat conflict | Not yet run | |
| 11 | Teardown | Not yet run | |
