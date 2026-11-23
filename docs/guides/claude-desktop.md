# Documents in Claude Desktop

Claude Desktop support is experimental. With the development candidate in Claude Desktop 6.28899.6 on macOS 26.7.1, the Placekeeper view, chat context, chat-driven search and the reopening dialog worked. Setup from the installed app is covered by automated tests only and has not yet been tried with a real Claude Desktop. Other items in the [qualification checklist](../testing/claude-desktop-qualification.md) are still unverified, and Windows and Linux have not been tried.

## Set up from the installed app

Choose **Help → Set Up Integrations** and choose **Set Up** for **Claude Desktop (experimental)**. First launch offers the same choice, and the source installers accept `--claude=ask|setup|skip`. Setup adds a `placekeeper` server to Claude Desktop's `claude_desktop_config.json` and keeps every other server and setting in that file. Open Claude Desktop once before running setup; if its folder does not exist yet, setup reports Claude Desktop as not found and changes nothing. Then fully quit Claude Desktop and start it again; closing the window is not enough. In **Settings → Developer**, check that `placekeeper` is running, and in a chat's tools menu check that it is enabled. The first time Claude calls a Placekeeper tool, it asks you to allow it. Placekeeper repairs the entry when it starts after a move or upgrade; restart Claude Desktop when it says so. Step-by-step setup, file locations, setup outcomes, what setup leaves untouched, and removal are described in [Installation](../installation.md#claude-desktop-experimental). For problems, see [Support and diagnostics](../support.md#claude-desktop).

## Set up from a checkout (development)

The development candidate runs against its own isolated daemon and recovery root and does not touch the installed application. From the checkout, build the service, web client, and Codex app/server, then package the candidate:

```sh
pnpm build:service
pnpm build:codex
pnpm exec tsx scripts/extension-candidate/build.ts
```

The packaging command prints the daemon start command and the path of `dist/extension-candidate/claude-desktop-config.json`. Start the isolated daemon with the printed command in a foreground terminal and leave it running while you use Claude Desktop. It listens on port 48763. Stop it with Control-C when you are done. The candidate's daemon root is under `/private/tmp`, so this route currently targets macOS.

Open Claude Desktop's configuration file through **Settings → Developer → Edit Config**. It is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Copy the `placekeeper-candidate` entry from `claude-desktop-config.json` into its `mcpServers` object. Keep any other servers already listed there. The entry uses absolute paths into `dist/extension-candidate` and the Node executable that ran the build, so keep both in place. Fully quit Claude Desktop and start it again.

## Open a PDF

Claude has no file-menu or conversation entry points for apps. The reader opens only when Claude calls a Placekeeper tool, and the first call asks you to allow the tool.

- **From Placekeeper:** with a PDF open in the desktop app, choose **File → Open in Claude**. Claude Desktop opens a new chat with `Open "<path>" in Placekeeper.` already typed. Review it and press send; Claude does not send it for you.
- **By path:** ask in chat, for example "Open /path/to/paper.pdf in Placekeeper". Claude calls `open_pdf_file` with that absolute path.
- **By prompt:** choose **Open a PDF in Placekeeper** (`open_pdf`) from the **+** menu. Enter an absolute path, or leave it empty to choose a file.
- **By chooser:** ask Claude to open Placekeeper without a path. Claude calls `open_placekeeper`, and the reader offers the system file picker and **Recent Documents**.

Attaching or dropping a PDF into the chat uploads it to Claude and does not give Placekeeper the file. Use a path or the chooser instead.

**File → Open in Claude** uses a `claude://claude.ai/new?q=` link. You can build the same link yourself, for example `claude://claude.ai/new?q=Open%20%2FUsers%2Fme%2Fpaper.pdf%20in%20Placekeeper`.

The reader starts inline as a compact status line. Choose **Open reader** to expand it to fullscreen, where PDF search, page navigation, annotation editing and save status work as described in [Documents in chat](chatgpt-extension.md). Click the PDF filename and choose **Save to a new copy** to pick a local folder and filename; accepted edits then autosave to that copy. Closing and reopening the same PDF shows **Reopen Document** with "You had this document open earlier." and the choices **Cancel**, **Open Copy** and **Continue**, as in ChatGPT.

## Chat context

When Claude advertises support for app context updates, the open document, current page and current selection are automatically available as context in the current chat. **Add selection to chat** and **Add annotation to chat** attach the captured evidence and your optional note in the same way, without changing your prompt or sending a message. Each update replaces the previous one. Claude does not list Placekeeper's context groups for you to remove one by one, and Placekeeper cannot read back what Claude holds. Background context does not confirm that Claude has read the evidence.

Click the toolbox bot button, **Put document in context**, to tell Claude about the open PDF. Claude does not accept a PDF as context from a local app unless it advertises resource support, so when it does not, Placekeeper publishes a short note instead: the title, page count, and how to read it. The button then reads **Document in context: Claude can read this PDF on request.** When Claude needs the contents, it calls `read_document_text`.

## Reader tools in chat

Claude can also use these tools on the open reader:

- `inspect_review` reports the current PDF, page and selection.
- `search_document` searches with the reader's exact search behavior.
- `reveal_search_result` and `reveal_annotation` show a result or annotation in the reader.
- `navigate_page` expands the reader and goes to a page.
- `read_document_text` returns the extracted text of a page range, with page markers. Each call returns at most 100,000 characters; when the text is cut, the result names the page to continue from.

Commands go to the most recently opened Placekeeper view. If no view is open, Claude is told to open the PDF first. Tools that need the visible reader may answer that the reader is unavailable until you choose **Open reader**, because Claude grants fullscreen only after a click in the view. Document text is passed to Claude as untrusted data.

## What differs from ChatGPT

- There is no file-menu or conversation entry inside Claude. Views open only from a tool call: use **File → Open in Claude**, a path, the `open_pdf` prompt or the chooser.
- Opening host-managed files and saving back to them does not apply. Claude passes local paths, and Placekeeper saves to a local copy you choose.
- The whole PDF is not attached to chat. Claude reads it on request as text with `read_document_text`.
- Chat context has no per-group removal. Each update replaces the previous one.

Claude Code can call the same tools but shows only the tool's text, not the reader.

## Privacy

Claude chooses the path it passes to `open_pdf_file`. Placekeeper opens it only after you allow the tool call, and only when it resolves to an existing local file ending in `.pdf`. Relative paths, other file types and missing files are refused with a plain error. The reader's private connection data is kept out of the text Claude sees; Claude sees only the file name unless you put context in chat or Claude calls a reader tool. Annotations and drafts stay in the installed app's recovery root, or for the candidate in its isolated recovery root, recorded in `dist/extension-candidate/build.json`. See [Privacy and recovery](../privacy-and-recovery.md) for local storage boundaries.

## Remove

For the installed app, follow the removal steps in [Installation](../installation.md#claude-desktop-experimental). For the candidate, delete the `placekeeper-candidate` entry from `claude_desktop_config.json`, then fully quit and restart Claude Desktop, and stop the candidate daemon with Control-C in its terminal. Removing an entry does not change other servers or the installed Placekeeper application.
