# Source and PDF navigation across editors

The native Mac app accepts source-to-PDF requests through its installed command and returns PDF locations to a locally configured editor. The embedded VS Code panel keeps its own editor association. Automatic PDF refresh preserves reading position and zoom; following a saved source cursor after a build is off by default.

Start here for **Zed** or **VS Code** on an Apple-silicon Mac:

1. From a checkout containing this integration, follow the [installation prerequisites](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/docs/installation.md) and run `./install.sh --zed=manual` for on-demand jumps, `./install.sh --zed=preview` to also jump after builds, or `./install.sh --vscode=setup` for the embedded VS Code viewer. Check the installer summary for pending steps. Zed needs its LaTeX extension; reload the VS Code window after installing its extension.
2. From the project root, build with SyncTeX enabled (for example, `latexmk -pdf -synctex=1 -outdir=build main.tex`). Check that `build/main.pdf` and `build/main.synctex.gz` (or `.synctex`) exist. In Zed, make sure Texlab’s PDF directory matches the build directory.
3. Put the cursor on a line of typeset text. In Zed, run **task: spawn → Placekeeper: Forward SyncTeX** and approve the project’s source folder when prompted. In a trusted local VS Code workspace, run **Placekeeper: Forward SyncTeX** from the command palette. Confirm the PDF shows that passage, then use **Go to Source** there and check that the editor returns to the corresponding source.

Neither installer-managed route requires creating a profile by hand. See [Zed](#zed) and [VS Code](#vs-code) below for settings. The [acceptance record](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/test/acceptance/editor-synctex.md) lists the installed-app and live editor checks and their limits. Neovim, Sublime Text, and Emacs have manual recipes but have not been verified live.

## Install and build

Use the launcher inside the installed app. It includes its own Node runtime; neither the checkout nor system Node is needed:

```sh
PLACEKEEPER="$HOME/Applications/Placekeeper.app/Contents/MacOS/placekeeper"
```

Install a TeX distribution with `synctex` and build with SyncTeX enabled, for example `latexmk -pdf -synctex=1 -outdir=build main.tex`. On macOS, the service searches `/Library/TeX/texbin` as well as its inherited `PATH`. For a custom TeX location, start Placekeeper with that directory in `PATH`; quit existing Placekeeper windows and the service before changing the environment.

Identify the root PDF separately from the current source file: `chapters/results.tex` still navigates to `build/main.pdf`. The approved source root must contain every source file to which inverse search may return. It is not inferred from the PDF directory.

## Create a local editor profile

A profile stores an absolute executable and argument array, or the Neovim adapter. Templates accept `{file}`, `{line}`, and `{column}`. Arguments are passed separately without a shell. Select only an executable you intend to run. Do not add `--wait`: navigation waits for the editor command to exit.

Replace these example executable paths with the actual paths on your machine:

```sh
"$PLACEKEEPER" editor add --name vscode \
  --executable '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' \
  --args-json '["--reuse-window","--goto","{file}:{line}:{column}"]'

"$PLACEKEEPER" editor add --name zed-manual --executable /usr/local/bin/zed \
  --args-json '["{file}:{line}:{column}"]'

"$PLACEKEEPER" editor add --name neovim --adapter neovim

"$PLACEKEEPER" editor add --name sublime \
  --executable '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl' \
  --args-json '["{file}:{line}:{column}"]'

"$PLACEKEEPER" editor add --name emacs --executable /ABSOLUTE/PATH/TO/emacsclient \
  --args-json '["--no-wait","+{line}","{file}"]'

"$PLACEKEEPER" editor list
```

Adding the same name replaces its saved profile for future registrations. Existing registrations retain the executable and arguments they captured; register again to use a changed profile. Profiles persist in private application-support storage. Sessions and associations last only for the current service process.

VS Code's `--reuse-window` targets an editor-selected window, not necessarily the originating one. Use the embedded extension when its panel and source-group behavior are required. [VS Code CLI](https://code.visualstudio.com/docs/configure/command-line).

Zed's CLI accepts file locations, but this recipe has no originating-window identifier. Zed chooses the window. Do not add `--reuse`, which can replace a workspace. [Zed CLI](https://zed.dev/docs/reference/cli).

Placekeeper rejects colon or newline filenames in combined `{file}:{line}` syntax rather than opening the wrong file. Separate `{file}` arguments, including Emacs and structured Neovim RPC, do not have that limitation. Missing columns default to 1; the Emacs recipe intentionally uses line-only navigation.

## View a source location

After creating a profile, use the shared viewer command from any editor that can invoke a process:

```sh
"$PLACEKEEPER" view-source --editor zed-manual \
  --source '/Users/YOU/Research/Project with spaces/chapters/results.tex' \
  --line 42 --pdf '/Users/YOU/Research/Project with spaces/build/main.pdf'
```

`--editor` names a saved profile, such as `zed-manual` created above. The name `zed` is reserved for the installed Zed integration: that alias requires Zed setup and uses its saved CLI configuration and build fences. Use `zed-manual` for a separately configured generic Zed profile. Neovim profiles additionally require `--socket '/absolute/listening/socket'`. On first use, approve the source folder in Placekeeper. The shared command retains that approval and renews its session after service restarts. If `--pdf` is omitted, it discovers a matching PDF; `--pdf-directory '/absolute/output/folder'` narrows the search. Source and line are required, and line numbers start at 1.

Manual requests default to `--intent explicit`: they establish the return editor and take precedence over older pending navigation. An automatic callback must use `--intent preview` so it cannot replace a newer manual request's return target. Preview requests need the build fence captured before compilation and are currently supported only through the installed Zed alias and its build wrapper. Generic Texlab callbacks must remain manual.

## Low-level session commands

The lower-level commands remain available for clients that manage their own session and build tokens. Register one editor session with the folder containing the source files:

```sh
SESSION=$("$PLACEKEEPER" editor register --profile zed-manual \
  --source-root '/Users/YOU/Research/Project with spaces')

ASSOCIATION=$("$PLACEKEEPER" forward-search \
  --pdf '/Users/YOU/Research/Project with spaces/build/main.pdf' \
  --source '/Users/YOU/Research/Project with spaces/chapters/results.tex' \
  --line 42 --column 1 --session "$SESSION")
```

The command prints an opaque association token when accepted. Exit status 0 means accepted, not yet displayed: the app may still be opening or awaiting matching mapping data. Pending and failed navigation are shown in the viewer. The latest explicit request for that PDF determines its return editor. Refresh and follow requests cannot take that association over.

For mapping data stored separately from the PDF, append `--synctex-directory '/absolute/mapping folder'`. The mapping must have the root PDF's stem (`main.synctex` or `main.synctex.gz`). Placekeeper snapshots the matching PDF and mapping together and isolates that choice from other presentations. Do not leave both compressed and uncompressed mappings in the selected folder.

SyncTeX matches the source path spelling recorded by the compiler. When a project is opened through a directory alias or symbolic link (for example `/tmp` versus `/private/tmp`), use the compiler's absolute source path, or rebuild using the path your editor supplies. Relative CLI paths resolve against the process working directory, which macOS may canonicalize. Configuration files should use absolute paths: they do not expand `~`, `$HOME`, or shell expressions. Lines and optional columns are one-based positive integers.

Clients using the low-level commands must register again after a service restart or app update and replace the old handle in editor settings. Do not commit live handles or machine-specific paths to a shared project. A stale handle fails rather than falling back to another editor.

## VS Code

Use **Placekeeper: View PDF**, **Placekeeper: Forward SyncTeX**, and **Placekeeper: Go to Source** in a trusted local workspace. Texlab is optional. To follow the saved cursor after builds, explicitly set:

```json
{ "placekeeper.followAfterBuild": true }
```

The default is `false`. Newer manual navigation cancels older pending following; refresh continues in either mode.

If an explicit **Forward SyncTeX** request finds missing, pending, or stale mapping data, VS Code shows “Waiting for SyncTeX data.” It retains the source position captured when you invoked the command and retries when output or mapping changes are observed, with periodic recovery checks while work remains pending. Moving the cursor does not retarget that request. A newer explicit jump replaces it, and an explicit jump cancels an older saved-cursor follow. This works with `placekeeper.followAfterBuild` disabled.

Waiting for mapping has no fixed one-minute expiry: it ends when delivered, superseded, canceled by reverse navigation, terminated by a terminal failure, or disposed with the panel. Once a target is sent to the viewer, a separate acknowledgement wait expires after about a minute. Pending requests are not restored after closing the panel or restarting the extension. Live overlap checks used source and PDF visible side by side; automatic delivery into a hidden PDF tab remains unqualified. LaTeX Workshop's scoped compatibility launcher remains separate and best-effort. It does not use the general native session handle.

To use the native window instead, create the `vscode` command profile and use the shared viewer command or generic Texlab settings below. Native navigation does not redirect the embedded panel's return target.

## Zed

Install or enable Zed’s existing **LaTeX** extension, then select **Zed** when installing Placekeeper. Choose **manual** for jumping from the current cursor on demand, or **preview** for jumping after successful builds. No separate Placekeeper Zed extension is needed. For an unattended install, append `--zed=manual` or `--zed=preview` to the install command; `--zed=setup` means manual. Rerun the installer to change modes or repair setup.

Setup updates Zed’s user `settings.json` and `tasks.json`, preserving comments, unrelated settings, custom build executable and arguments, and output directories. Preview wraps the existing build command and enables build-on-save; switching back to manual restores the saved build command and on-save setting. Settings that cannot be safely parsed or a conflicting task name cause setup to stop with a diagnostic.

Open a TeX project and run **task: spawn → Placekeeper: Forward SyncTeX**. On first use, approve the folder containing its source files in Placekeeper. That approval persists for future requests; installation grants no source-folder access. The shared `view-source --editor zed` command registers sessions as needed, including after service restarts. Build with SyncTeX enabled and configure Texlab’s `build.pdfDirectory` to match your output directory. The manual task passes the current source file and row with `--pdf-directory` to find the matching PDF. Rerunning setup migrates the previously installed `zed-forward` user task to this command. If a project-local task overrides it, update that task from [zed-tasks.json](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/integrations/editors/zed-tasks.json) or remove the override; legacy commands remain supported.

Preview keeps the `zed-build` wrapper around the LaTeX extension’s Texlab build command and invokes `view-source --editor zed --intent preview` from its forward-search callback. The wrapper captures the build fence before compilation so a delayed callback cannot overtake newer manual navigation. A failed build does not navigate; refresh continues to preserve reading position until a successful eligible build requests a jump. The extension’s own preview command also uses the configured callback. Use the Placekeeper task for a jump from the current cursor. If you bind **task: rerun**, set `reevaluate_context` to `true` so Zed does not reuse the previous cursor context.

Zed chooses the return window through its CLI. In the recorded two-workspace check it returned to the existing source workspace while another workspace was active; exact originating-window routing is not guaranteed. The installed setup, first-use folder approval, manual task, and automatic preview after an app/service restart passed the isolated [acceptance check](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/test/acceptance/editor-synctex.md#seamless-zed-installation-and-persistent-approval--november-2-2026). A canceled preview build wrapper can suppress further Texlab builds until the language server restarts. [Zed LaTeX preview](https://github.com/rzukic/zed-latex/wiki/Preview), [Zed task variables](https://zed.dev/docs/tasks#variables).

## Other Texlab clients

Merge [texlab.json](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/integrations/editors/texlab.json) into your LSP client's configuration. Replace the executable and `REPLACE_WITH_PROFILE` with a profile created above. `%f`, `%p`, and `%l` supply the source, PDF, and line to `view-source`. No session token belongs in this configuration: the shared command registers and renews it. The example deliberately uses `--intent explicit` for manual forward search, which establishes the return editor. Keep `build.forwardSearchAfter` false. Enabling automatic callbacks with explicit intent would give a build completion manual precedence; automatic requests require `--intent preview` and a build fence captured before compilation. That path is currently supported only by installed Zed setup; the generic profile recipe supports explicit requests. Use `build.pdfDirectory` for a separate PDF directory, matching your build configuration; top-level `auxDirectory` is deprecated. [Texlab configuration](https://github.com/latex-lsp/texlab/wiki/Configuration).

## Neovim

The [Lua helper](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/integrations/editors/placekeeper.lua) uses `vim.system`, requiring Neovim 0.10 or newer. It registers a local listening socket and sends argument arrays. Source return uses structured MessagePack RPC without interpolating filenames into Lua or Ex commands. It does not activate the terminal application. [Neovim process API](https://neovim.io/doc/user/lua/#vim.system()), [Neovim RPC](https://neovim.io/doc/user/api/#rpc-connecting).

Create the `neovim` profile above. Start Neovim with a local socket, for example `nvim --listen '/tmp/my-project.nvim'`, then load the installed helper:

```lua
local pk = dofile(vim.fn.expand("~/Applications/Placekeeper.app/Contents/Resources/integrations/editors/placekeeper.lua"))
pk.setup({
  launcher = vim.fn.expand("~/Applications/Placekeeper.app/Contents/MacOS/placekeeper"),
  source_root = "/Users/YOU/Research/Project with spaces",
  pdf = "/Users/YOU/Research/Project with spaces/build/main.pdf",
  profile = "neovim",
  follow_after_build = false,
})
vim.keymap.set("n", "<leader>lv", pk.forward)
```

The first explicit forward request registers the session. Call `pk.register()` after the service restarts. Each Neovim instance needs its own socket. Source return uses ordinary buffer protection and never force-discards unsaved edits.

For opt-in following, set `follow_after_build = true` and capture the token **before** the build. An explicit forward request must already have established the association:

```lua
local captured = pk.capture_build()
vim.system({ "latexmk", "-pdf", "-synctex=1", "-outdir=build", "main.tex" },
  { cwd = "/Users/YOU/Research/Project with spaces", text = true },
  function(result)
    vim.schedule(function() pk.build_finished(captured, result.code == 0) end)
  end)
```

The helper retains the captured source, session and association; it never substitutes the newest token at completion. A later explicit request makes the old follow ineligible. Failed builds do not navigate. The helper installs no save hook or build-on-save behavior.

## Sublime Text — unverified

Register the `sublime` profile above. Copy [placekeeper_sublime.py](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/integrations/editors/placekeeper_sublime.py) to `Packages/User`. Add these values to the project's `settings` object:

```json
{
  "placekeeper_launcher": "/Users/YOU/Applications/Placekeeper.app/Contents/MacOS/placekeeper",
  "placekeeper_pdf": "/ABSOLUTE/PROJECT/build/main.pdf",
  "placekeeper_session": "REPLACE_WITH_SESSION"
}
```

Add a user key binding such as `{ "keys": ["super+alt+j"], "command": "placekeeper_forward_sync_tex" }`. The command captures file and line and invokes Placekeeper without a shell. It installs no automatic following. Sublime chooses the return window. The CLI syntax is documented, but this recipe has not completed an editor round trip. [Sublime CLI](https://www.sublimetext.com/docs/command_line.html).

## Emacs — unverified

Start a server with `M-x server-start`, configure the `emacs` profile above, and register it with your source root. Load [placekeeper.el](https://github.com/brad-ross/placekeeper/blob/c75be6a8bcc10210b056e577b21e84a2db5bfb38/integrations/editors/placekeeper.el); set `placekeeper-launcher`, `placekeeper-pdf`, and `placekeeper-session` to the absolute launcher, root PDF and registration handle. Run `M-x placekeeper-forward-sync-tex`. No automatic following is installed.

For a named server, add fixed `--socket-name` and server-name arguments to the trusted profile before registering. Do not use `--eval`, shell interpolation, or an alternate-editor command. This recipe has not completed an editor round trip. [Emacs client options](https://www.gnu.org/s/emacs/manual/html_node/emacs/emacsclient-Options.html), [Emacs process arguments](https://www.gnu.org/s/emacs/manual/html_node/elisp/Synchronous-Processes.html).

## PDFs opened directly in Finder

Choose **File → Go to Source**, or use the viewer's source-navigation gesture. On first use, select a saved profile and source folder. Neovim also needs its listening socket path. Canceling leaves the PDF open and changes no association. Use **File → Configure Source Navigation…** to change the selection. If there are no profiles, create one with `editor add`, then reopen the chooser.

Setup applies only to that native window. A later explicit editor request can replace its return editor. Ordinary Finder opens and public document links do not supply editor configuration or source-root authority.

## Recovery

| Symptom | Next step |
|---|---|
| Session expired | Low-level clients must register again and update their handle. The shared `view-source` command renews sessions automatically. |
| Native pending navigation | Finish a SyncTeX-enabled build and check both paths. Native requests time out after about a minute; issue a new request afterward. |
| VS Code waiting for SyncTeX data | Finish a build with matching PDF and sidecar. The captured explicit request resumes automatically while its panel remains live; invoke a newer jump to replace it. See [VS Code](#vs-code) for cancellation and qualification limits. |
| Missing or stale mapping | Rebuild PDF and SyncTeX together; do not reuse a predecessor's sidecar. |
| Ambiguous mapping | Keep one current `main.synctex` or `main.synctex.gz`, not both. |
| Source outside the root | Select the actual source-project root or register again with it. |
| Missing SyncTeX tool | Install/configure the TeX tool path and restart the service. |
| Editor unavailable | Check the executable or Neovim socket; register again after restarting Neovim. |
| Wrong Zed/VS Code window | Check CLI routing; use the embedded VS Code panel or targeted Neovim socket for session-specific return. |
| Modified Neovim buffer prevents return | Save or resolve the buffer normally, then retry. |

Failures leave reading and annotations available. CLI acceptance does not prove that the editor UI or PDF destination was reached; record installed checks separately.
