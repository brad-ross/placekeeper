# PDF review in Claude Desktop

Claude Desktop support is experimental. Claude's documentation says Claude Desktop draws MCP App views for local (stdio) servers, but Placekeeper has not yet been verified in a real Claude Desktop. Progress is tracked in the [qualification checklist](../testing/claude-desktop-qualification.md). There is no installed-app setup yet: Placekeeper's **Help → Set Up Integrations** does not offer Claude Desktop. The only route today is the development candidate built from a checkout, which runs against its own isolated daemon and recovery root and does not touch the installed application.

## Set up from a checkout

From the checkout, build the service, web client, and Codex app/server, then package the candidate:

```sh
pnpm build:service
pnpm build:codex
pnpm exec tsx scripts/extension-candidate/build.ts
```

The packaging command prints the daemon start command and the path of `dist/extension-candidate/claude-desktop-config.json`. Start the isolated daemon with the printed command in a foreground terminal and leave it running while you use Claude Desktop. It listens on port 48763. Stop it with Control-C when you are done. The candidate's daemon root is under `/private/tmp`, so this route currently targets macOS.

Open Claude Desktop's configuration file through **Settings → Developer → Edit Config**. It is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Copy the `placekeeper-candidate` entry from `claude-desktop-config.json` into its `mcpServers` object. Keep any other servers already listed there. The entry uses absolute paths into `dist/extension-candidate` and the Node executable that ran the build, so keep both in place. Fully quit Claude Desktop and start it again; closing the window is not enough.

## Open a PDF

Claude has no file-menu or conversation entry points for apps. The reader opens only when Claude calls a Placekeeper tool, and the first call asks you to allow the tool.

- **By path:** ask in chat, for example "Open /path/to/paper.pdf in Placekeeper". Claude calls `open_pdf_file` with that absolute path.
- **By prompt:** choose **Open a PDF in Placekeeper** (`open_pdf`) from the **+** menu. Enter an absolute path, or leave it empty to choose a file.
- **By chooser:** ask Claude to open Placekeeper without a path. Claude calls `open_placekeeper`, and the reader offers the system file picker and **Recent Documents**.

Attaching or dropping a PDF into the chat uploads it to Claude and does not give Placekeeper the file. Use a path or the chooser instead.

To start from outside Claude, a `claude://claude.ai/new?q=` link opens a new chat with the request already typed, for example `claude://claude.ai/new?q=Open%20%2FUsers%2Fme%2Fpaper.pdf%20in%20Placekeeper`. Claude does not send it for you: review the text and press send.

The reader starts inline as a compact status line. Choose **Open reader** to expand it to fullscreen, where PDF search, page navigation, annotation editing and save status work as described in [PDF review in chat](chatgpt-extension.md). Click the PDF filename and choose **Save to a new copy** to pick a local folder and filename; accepted edits then autosave to that copy. Closing and reopening the same PDF offers **Continue** or **Open Copy**, as in ChatGPT.

## What differs from ChatGPT

These host features exist only in ChatGPT and Codex and are not available in Claude:

- Opening a PDF from its file menu, reading host files, and saving back to them. Save to a chosen local copy instead.
- **Put document in context**, **Add selection to chat** and **Add annotation to chat**.
- Live reader tools that let chat search, reveal or navigate in the open reader. Use the reader's own controls.

Claude Code can call the same tools but shows only the tool's text, not the reader.

## Privacy

Claude chooses the path it passes to `open_pdf_file`. Placekeeper opens it only after you allow the tool call, and only when it resolves to an existing local file ending in `.pdf`. Relative paths, other file types and missing files are refused with a plain error. The reader's private connection data is kept out of the text Claude sees; Claude sees only the file name. Review data stays in the candidate's isolated recovery root, recorded in `dist/extension-candidate/build.json`. See [Privacy and recovery](../privacy-and-recovery.md) for local storage boundaries.

## Remove

Delete the `placekeeper-candidate` entry from `claude_desktop_config.json`, then fully quit and restart Claude Desktop. Stop the candidate daemon with Control-C in its terminal. Removing the entry does not change other servers or the installed Placekeeper application.
