# Placekeeper

Placekeeper is a focused everyday PDF reader and annotator for serious readers. It preserves your place and train of thought across annotation, search, and nested reference lookup, produces a portable reviewed PDF from a recoverable session, and can supply task-scoped live PDF and annotation context to its Codex plugin.

<img src="packaging/macos/icon/Placekeeper.svg" alt="Placekeeper's two-page reference-and-return app icon" width="128">

## Install

On an Apple-silicon Mac running macOS 13 or newer, download or clone this repository and run one command from the repository folder:

```sh
./install.sh
```

The installer uses a checksum-pinned local Node toolchain, installs locked dependencies, builds into a temporary directory, verifies the packaged PDF writer offline, and transactionally installs the app under `~/Applications`. A failed update restores the previous app. It does not require an Apple Developer account or a global Node installation.

See [Install and uninstall](docs/installation.md) for first-launch, update, optional Codex/VS Code integration, and removal instructions. See [Privacy and recovery](docs/privacy-and-recovery.md) for local storage behavior.

## Use

After installation, select one local PDF in Finder and choose **Open With -> Placekeeper**. You can also open the app from `~/Applications` and choose a PDF. For upgrade compatibility, the physical bundle remains at `~/Applications/PDF Proofreader.app`; Finder presents it as Placekeeper. The app runs on numeric loopback, bundles its browser and PDF assets, performs no telemetry, and leaves the original PDF unchanged unless you explicitly choose the separately confirmed Replace Original action.

With the bundled Codex plugin installed, ask Codex to open one explicit local PDF in Placekeeper. The hosting task is bound automatically after the in-app browser loads. Each later prompt refreshes the current Review Items, Existing PDF Annotations, and save status; Codex retrieves bounded PDF text, layout, render, or annotation evidence only when needed. Finder, ordinary-browser, and VS Code launches remain unbound and show no Codex control.

## Supported release scope

The current personal release is source-first and Apple-silicon-only. Developer ID signing, notarization, Intel/x64, DMG/PKG packaging, auto-update, and release CI are optional future work, not installation requirements.
