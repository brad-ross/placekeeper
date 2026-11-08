# Manual upgrades and recovery

Download the intended version from [published releases](https://github.com/brad-ross/placekeeper/releases/latest), read its notes and verify its checksum. The release page lists published Electron installers. Version 0.2.4 was a source-only release for Apple Silicon macOS. For help with a macOS approval prompt, see [Unsigned approval](installation.md#unsigned-approval-provisional).

## Upgrade through the supported entrypoint

Open **Install Placekeeper.app** inside the Mac DMG, run Windows **Setup.exe**, or install the exact Debian package and explicitly launch the ordinary-user app. Source users run `./install.sh` or `./install.ps1` from the intended checkout in an interactive terminal. Do not overwrite a running app through Finder or other manual copy operations.

The coordinator previews active work and asks before closing reviews. Declining leaves the installed app usable. Allow pending writes to finish; recoverable drafts are protected before replacement. If a renderer cannot settle, a task remains bound, an old service cannot prove idle retirement, or recovery backup fails, installation stops. Follow its specific save/close/retry action. It does not force-kill unknown processes. A noninteractive source invocation cannot approve active-work closure: rerun interactively or save and close the work yourself.

On macOS, the installer checks the service launcher and desktop app before moving the current app. It repeats the launch checks at the final location before starting the service. If macOS blocks a launch check, the installer leaves or restores the current app and keeps the staged copy for a retry. If **Open Anyway** opens the staged copy, it exits without starting Placekeeper. Return to **Install Placekeeper.app** and retry. Before committing activation, the installer verifies the exact candidate service and renderer/PDF readiness. A failed startup attempts to restore the retained previous installation only after proving candidate retirement. If that proof is ambiguous, both versions and recovery remain for manual attention. Do not delete journals or force-close broadly matched processes to get past a blocked upgrade.

The Debian package stages immutable root-owned versions. Each user switches on their next explicit launch, with the same preparation/consent checks. Other users may keep using earlier versions. The stable `/usr/bin/placekeeper` dispatcher keeps integrations independent of a version directory. Sandbox/mount errors block activation with guidance; they do not authorize disabling the sandbox.

## Moving from public 0.2.4 on macOS

The public app's identity is **Placekeeper**, bundle ID `local.placekeeper`, executable `PlacekeeperMac`; it is not an Electron build with an old version label. Before retrying its upgrade:

1. Apply each unfinished annotation you want to keep, then save/export the PDF. Explicitly discard only edits you do not want. A saved PDF indicator does not establish that unfinished annotation text is saved: public 0.2.4 can delete that text during shutdown.
2. Close Placekeeper windows and browser/editor review surfaces. End bound Codex tasks; closing a panel alone can leave an active task, so fully quit the host if necessary.
3. Quit the old Mac app after those steps and wait for its service to retire. The new installer refuses to shut down a running legacy service; retry after the old service has exited.

The legacy native close path cannot acknowledge renderer settlement, so automatic safe closure is not claimed. If the installer still reports active or unknown work, follow the diagnostic and preserve the old installation. Its support root `~/Library/Application Support/Placekeeper` and compatibility launchers are preserved. Validated window-restoration and interface-zoom preferences are imported once without replacing existing Electron preferences; the original preference file remains.

After installation, revisit **Help → Set Up Integrations**. Reload the Chrome extension from the reported new runtime folder. Update/reinstall the local Codex marketplace/plugin, review trust, fully restart Codex and use a new chat. Apply VS Code's prepared launcher setting, reload and verify a PDF handoff. Prepared files and registration receipts are not proof of host enablement or trust. Zed's Mac source setup remains available; SyncTeX still needs a separate native TeX installation.

## Keep recovery resources

The support root is `~/Library/Application Support/Placekeeper` on macOS, `%LOCALAPPDATA%\Placekeeper` on Windows, and `${XDG_STATE_HOME:-~/.local/state}/placekeeper` on Linux. Protected drafts live under `recovery`; installer backups live under `installer/recovery-backup-<timestamp>`. Settings and integration ownership records are separate from app files. See [Privacy and recovery](privacy-and-recovery.md) before removing any of them.

For copied installs, the app's parent contains `.placekeeper-install-transactions/<destination-hash>/journal.json`. During an upgrade the installer moves the previous app to `previous.app` on macOS or `previous` on other platforms. The journal names the exact destination, attempt, previous version and backup location. On macOS, after the new app passes its startup checks and the installer records success, it removes the old app bundle if its signature verifies. It also removes temporary startup files. On a retry or subsequent upgrade, it removes the preceding backup for the same destination if the new verified backup contains the exact same files and contents. Modified app bundles, backups with different contents, and recovery journals are preserved.

For the Debian route, retain `/opt/placekeeper/runtimes/<artifact-identity>`, the available marker, and the per-user `installer/selected-runtime.json` and `installer/runtime-activation/journal.json` under the support root. Package removal **and purge** leave potentially active runtimes intact. There is no automatic runtime garbage collection. An administrator may remove explicitly identified unused runtime directories only after every Placekeeper session is closed and recovery is no longer needed; never traverse users' state to clean them.

## If installation stops

Keep the complete diagnostic, the journal and every app/runtime location it names. If the previous app was restored, reopen it normally and inspect recovery before retrying. If retirement is uncertain, close the exact candidate and all Placekeeper sessions yourself, then retry the same supported entrypoint so its recovery logic can use the journal. An unreadable or invalid journal needs manual inspection; keep all versions instead of guessing which to overwrite.

Do not copy an old recovery backup over current canonical user data: newer accepted writes may exist. Recover drafts through the app's resume, discard or separate-copy choices. A fixed loopback URL does not transfer credentials or task authority to a successor; reopen/recovery remains explicit. Ask for support with the diagnostic and retained paths when the installer cannot restore safely.

For guarded macOS uninstall, open **Install Placekeeper.app** in the mounted DMG and choose **Uninstall existing installation** when offered. For a custom destination, keep a separate mounted complete installer and invoke its embedded candidate executable with `--placekeeper-uninstall /absolute/path/to/separate/candidate/Placekeeper.app --destination /absolute/path/to/installed/Placekeeper.app` (the candidate is `Install Placekeeper.app/Contents/Resources/Placekeeper.app/Contents/MacOS/PlacekeeperDesktop`). This uses the same consent/preparation path and retains a recovery app and backup. Windows **Uninstall.exe** stages a separate complete runtime before coordinating removal. Follow any retained-registration report. Normal uninstall preserves user data; do not erase the support root as part of removing the application.
