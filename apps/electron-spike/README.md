# Electron shell spike

This is a disposable decision probe, not an adopted Placekeeper host. It tests whether a
sandboxed Electron window can make the existing Finder launch path feel like a dedicated
macOS document app while the packaged Node daemon remains the sole review authority.

The renderer receives no preload script, Node integration, filesystem path, launcher handle,
or Electron API. The main process admits one PDF through the installed Placekeeper launcher,
accepts only a capability bootstrap on `http://127.0.0.1:43179`, denies permissions and new
windows, and prevents navigation away from that exact origin.

## Run

Install the normal Placekeeper app first, then install workspace dependencies and launch the
spike with one absolute PDF path:

```sh
pnpm install
pnpm spike:electron -- /absolute/path/to/paper.pdf
```

The spike's `prestart` hook downloads Electron's checksum-verified runtime on first use; an
ordinary workspace install does not pull the 275 MB application bundle into the release app.

Use `Cmd+O`, Finder `open-file` events from a packaged probe, or a second invocation to test
document switching and focus reuse. Set `PLACEKEEPER_SPIKE_LAUNCHER` to an absolute launcher
path to test another installed bundle.

For a machine-readable cold-load observation:

```sh
pnpm spike:electron -- --probe-json --exit-after-probe /absolute/path/to/paper.pdf
```

The JSON record includes Electron/Chromium/Node versions, launch-to-load time, main-process
resident memory, renderer PID, final review URL, and the effective renderer isolation flags.

Build a temporary, ad-hoc-signed `.app` with PDF and spike-only URL registrations by running:

```sh
pnpm --dir apps/electron-spike package
```

The package is written to a unique directory under the system temporary directory. It is never
installed over the real Placekeeper app and carries the separate bundle identifier
`local.placekeeper.electron-spike`.

For a Launch Services/Finder-style probe, set `PLACEKEEPER_ELECTRON_PROBE=1` and
`PLACEKEEPER_ELECTRON_PROBE_EXIT=1` through `open --env`, then capture stdout with `open -o`.
Those variables exist only so an OS-delivered `open-file` event can produce bounded evidence;
ordinary launches ignore them.

## Decision gates

- A Finder open and a second invocation focus the one native window without exposing a URL.
- PDFium worker/WASM, selection, annotation, save, and reload work in the real Electron renderer.
- The renderer remains sandboxed and exact-origin navigation/permission probes fail closed.
- Cold launch, idle memory, and installed footprint are acceptable for a PDF utility.
- Chrome, VS Code, ordinary-browser, and Codex launch behavior remain unchanged.

Protected Recovery choices are intentionally not reimplemented in this spike. Encountering one
fails closed; a production shell would reuse the service's complete recovery contract rather
than invent Electron-owned review state.
