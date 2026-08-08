# Install and uninstall

PDF Proofreader is a personal, local-only Apple-silicon macOS app distributed from source. It does not require an Apple Developer account, Developer ID certificate, notarization profile, Homebrew, or a global Node installation.

## Install from source

Requirements are macOS 13 or newer, an Apple-silicon Mac, internet access during installation, and the standard macOS command-line tools (`curl`, `tar`, `shasum`, and `ditto`). Download or clone the repository, open Terminal in the repository folder, and run:

```sh
./install.sh
```

The installer downloads the checksum-pinned Node 24.14.0 arm64 toolchain into the checkout, runs the exact pnpm 11.16.0 dependency graph from the lockfile, builds the app, and checks the packaged writer with networking disabled. It then transactionally installs the app at `~/Applications/PDF Proofreader.app` and asks macOS to register its native document bridge as an alternate PDF viewer. It does not modify the system Node installation or make PDF Proofreader the default PDF handler. Reinstalling removes the obsolete beta Quick Action if present.

Preview the actions without downloading or changing anything:

```sh
./install.sh --dry-run
```

To update, pull or download newer source and run `./install.sh` again. The installer replaces only its installed app; if replacement fails, it restores the previous app. It leaves recovery data and user-owned exports alone.

Because the source build is intentionally not Developer ID-signed or notarized (it receives only a local ad-hoc signature), macOS may warn on first launch. In Finder, Control-click `~/Applications/PDF Proofreader.app`, choose **Open**, and confirm once. Do not disable Gatekeeper globally and do not recursively remove quarantine attributes.

After installation, select one local PDF in Finder and use **Open With -> PDF Proofreader**. Alternatively, open PDF Proofreader from `~/Applications` and choose a PDF. No terminal is needed for ordinary use.

## Optional integrations

The app bundles two optional technical-user integrations:

- Codex plugin: `~/Applications/PDF Proofreader.app/Contents/Resources/integrations/codex-plugin`
- VS Code extension: `~/Applications/PDF Proofreader.app/Contents/Resources/integrations/vscode`

Install either directory through that application's local extension/plugin workflow. These adapters open the same local service; they do not upload PDFs or submit Codex tasks automatically. VS Code remains desktop-local and refuses Remote SSH, containers, Codespaces, web, virtual, and non-file workspaces.

## Uninstall

Quit PDF Proofreader, move `~/Applications/PDF Proofreader.app` and `~/Library/Services/PDF Proofreader.workflow` to the Trash, and uninstall any optional Codex or VS Code integration. Then optionally remove the local toolchain cache in the source checkout at `.local/`.

Removing the app does not remove recoverable drafts under `~/Library/Application Support/PDF Proofreader` or user-owned reviewed PDFs, handoffs, dispositions, and revised PDFs. See [Privacy and recovery](privacy-and-recovery.md) before deleting recovery data.
