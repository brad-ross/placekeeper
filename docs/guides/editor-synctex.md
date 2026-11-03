# Source and PDF navigation across editors

The native Mac app accepts source-to-PDF requests through its installed command and returns PDF locations to a locally configured editor. The embedded VS Code panel keeps its own editor association. Automatic PDF refresh preserves reading position and zoom; following a saved source cursor after a build is off by default.

These are integration recipes, not completed editor acceptance results. The [acceptance record](https://github.com/brad-ross/placekeeper/blob/feat/2026-11-02-1033-feat-editor-independent-synctex-plan-pr3/test/acceptance/editor-synctex.md) separates installed-app checks from hands-on VS Code and Zed checks. Neovim live testing is optional at the user’s request; Neovim, Sublime Text, and Emacs remain unverified.

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

"$PLACEKEEPER" editor add --name zed --executable /usr/local/bin/zed \
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

## Register, navigate, and renew

Register one editor session with the folder containing the source files:

```sh
SESSION=$("$PLACEKEEPER" editor register --profile zed \
  --source-root '/Users/YOU/Research/Project with spaces')

ASSOCIATION=$("$PLACEKEEPER" forward-search \
  --pdf '/Users/YOU/Research/Project with spaces/build/main.pdf' \
  --source '/Users/YOU/Research/Project with spaces/chapters/results.tex' \
  --line 42 --column 1 --session "$SESSION")
```

The command prints an opaque association token when accepted. Exit status 0 means accepted, not yet displayed: the app may still be opening or awaiting matching mapping data. Pending and failed navigation are shown in the viewer. The latest explicit request for that PDF determines its return editor. Refresh and follow requests cannot take that association over.

For mapping data stored separately from the PDF, append `--synctex-directory '/absolute/mapping folder'`. The mapping must have the root PDF's stem (`main.synctex` or `main.synctex.gz`). Placekeeper snapshots the matching PDF and mapping together and isolates that choice from other presentations. Do not leave both compressed and uncompressed mappings in the selected folder.

SyncTeX matches the source path spelling recorded by the compiler. When a project is opened through a directory alias or symbolic link (for example `/tmp` versus `/private/tmp`), use the compiler's absolute source path, or rebuild using the path your editor supplies. Relative CLI paths resolve against the process working directory, which macOS may canonicalize. Configuration files should use absolute paths: they do not expand `~`, `$HOME`, or shell expressions. Lines and optional columns are one-based positive integers.

After a service restart or app update, register again and replace the old handle in editor settings. Do not commit live handles or machine-specific paths to a shared project. A stale handle fails rather than falling back to another editor.

## VS Code

Use **Placekeeper: View PDF**, **Placekeeper: Forward SyncTeX**, and **Placekeeper: Go to Source** in a trusted local workspace. Texlab is optional. To follow the saved cursor after builds, explicitly set:

```json
{ "placekeeper.followAfterBuild": true }
```

The default is `false`. Newer manual navigation cancels older pending following; refresh continues in either mode. LaTeX Workshop's scoped compatibility launcher remains separate and best-effort. It does not use the general native session handle.

To use the native window instead, register the `vscode` command profile and use the generic Texlab settings below. Native navigation does not redirect the embedded panel's return target.

## Texlab and Zed

Merge [texlab.json](../../integrations/editors/texlab.json) into your LSP client's configuration. Replace the executable and `REPLACE_WITH_SESSION`. `%f`, `%p`, and `%l` supply the source, PDF, and line. Keep `build.forwardSearchAfter` false: that viewer command does not distinguish manual requests from build-triggered requests. Use `build.pdfDirectory` for a separate PDF directory, matching your build configuration; top-level `auxDirectory` is deprecated. [Texlab configuration](https://github.com/latex-lsp/texlab/wiki/Configuration).

In Zed, put the `texlab` object under `lsp.texlab.settings`. Preserve the explicit following setting because extension preview defaults may enable it. Copy [zed-tasks.json](../../integrations/editors/zed-tasks.json) to the project's `.zed/tasks.json`, set `PLACEKEEPER_LAUNCHER`, `PLACEKEEPER_PDF`, and `PLACEKEEPER_SESSION` in its `env` object, then run **task: spawn → Placekeeper: Forward SyncTeX**. The task maps Zed’s source and row into environment variables and quotes their shell expansion. Preserve those quotes: Zed 1.26.2 joins task arguments into a shell command, so an unquoted path with spaces is split. Passing file names through the environment also keeps quotes and shell metacharacters literal. [Zed LaTeX preview](https://github.com/rzukic/zed-latex/wiki/Preview), [Zed task variables](https://zed.dev/docs/tasks#variables).

Use **task: spawn** for the current cursor. If you bind **task: rerun**, set `reevaluate_context` to `true`; otherwise Zed can reuse its previous cursor context. In the recorded two-workspace check, Zed returned to the existing source workspace even while another workspace was active; this does not guarantee exact originating-window routing.

## Neovim

The [Lua helper](../../integrations/editors/placekeeper.lua) uses `vim.system`, requiring Neovim 0.10 or newer. It registers a local listening socket and sends argument arrays. Source return uses structured MessagePack RPC without interpolating filenames into Lua or Ex commands. It does not activate the terminal application. [Neovim process API](https://neovim.io/doc/user/lua/#vim.system()), [Neovim RPC](https://neovim.io/doc/user/api/#rpc-connecting).

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

Register the `sublime` profile above. Copy [placekeeper_sublime.py](../../integrations/editors/placekeeper_sublime.py) to `Packages/User`. Add these values to the project's `settings` object:

```json
{
  "placekeeper_launcher": "/Users/YOU/Applications/Placekeeper.app/Contents/MacOS/placekeeper",
  "placekeeper_pdf": "/ABSOLUTE/PROJECT/build/main.pdf",
  "placekeeper_session": "REPLACE_WITH_SESSION"
}
```

Add a user key binding such as `{ "keys": ["super+alt+j"], "command": "placekeeper_forward_sync_tex" }`. The command captures file and line and invokes Placekeeper without a shell. It installs no automatic following. Sublime chooses the return window. The CLI syntax is documented, but this recipe has not completed an editor round trip. [Sublime CLI](https://www.sublimetext.com/docs/command_line.html).

## Emacs — unverified

Start a server with `M-x server-start`, configure the `emacs` profile above, and register it with your source root. Load [placekeeper.el](../../integrations/editors/placekeeper.el); set `placekeeper-launcher`, `placekeeper-pdf`, and `placekeeper-session` to the absolute launcher, root PDF and registration handle. Run `M-x placekeeper-forward-sync-tex`. No automatic following is installed.

For a named server, add fixed `--socket-name` and server-name arguments to the trusted profile before registering. Do not use `--eval`, shell interpolation, or an alternate-editor command. This recipe has not completed an editor round trip. [Emacs client options](https://www.gnu.org/s/emacs/manual/html_node/emacs/emacsclient-Options.html), [Emacs process arguments](https://www.gnu.org/s/emacs/manual/html_node/elisp/Synchronous-Processes.html).

## PDFs opened directly in Finder

Choose **File → Go to Source**, or use the viewer's source-navigation gesture. On first use, select a saved profile and source folder. Neovim also needs its listening socket path. Canceling leaves the PDF open and changes no association. Use **File → Configure Source Navigation…** to change the selection. If there are no profiles, create one with `editor add`, then reopen the chooser.

Setup applies only to that native window. A later explicit editor request can replace its return editor. Ordinary Finder opens and public document links do not supply editor configuration or source-root authority.

## Recovery

| Symptom | Next step |
|---|---|
| Session expired | Register again and update the editor's handle. |
| Pending navigation | Finish a SyncTeX-enabled build and check both paths. Pending work times out after about a minute. |
| Missing or stale mapping | Rebuild PDF and SyncTeX together; do not reuse a predecessor's sidecar. |
| Ambiguous mapping | Keep one current `main.synctex` or `main.synctex.gz`, not both. |
| Source outside the root | Select the actual source-project root or register again with it. |
| Missing SyncTeX tool | Install/configure the TeX tool path and restart the service. |
| Editor unavailable | Check the executable or Neovim socket; register again after restarting Neovim. |
| Wrong Zed/VS Code window | Check CLI routing; use the embedded VS Code panel or targeted Neovim socket for session-specific return. |
| Modified Neovim buffer prevents return | Save or resolve the buffer normally, then retry. |

Failures leave reading and annotations available. CLI acceptance does not prove that the editor UI or PDF destination was reached; record installed checks separately.
