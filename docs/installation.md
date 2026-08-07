# Install and uninstall

PDF Proofreader is a personal, local-only macOS app. Install the architecture-specific signed package (`arm64` for Apple silicon, `x64` for Intel), drag **PDF Proofreader.app** to `/Applications`, then launch it once through Finder so macOS can verify it. The app registers as an alternate PDF viewer; it does not take over the default PDF handler.

Use **Open With → PDF Proofreader** for one PDF, or install the bundled **Open in PDF Proofreader** Quick Action in `~/Library/Services`. Install the bundled Codex plugin from the app resources, and install the bundled VS Code extension locally. The VS Code command works only in a local desktop window; Remote SSH, containers, Codespaces, web, and virtual workspaces are intentionally refused.

The [installed-host acceptance checklist](../test/acceptance/installed-hosts.md) must show Gatekeeper acceptance, offline launch, Finder registration, Codex plugin installation, VS Code installation, and the same review on clean arm64 and x64 Macs. These checks are still external/manual until signed and notarized release artifacts and clean test machines are available.

To uninstall, quit the app, remove `/Applications/PDF Proofreader.app`, remove the Quick Action from `~/Library/Services`, uninstall the Codex plugin and VS Code extension, then optionally remove the recovery directory described in [Privacy and recovery](privacy-and-recovery.md). User-owned reviewed PDFs, handoffs, dispositions, and revised PDFs are not deleted.
