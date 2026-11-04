# Desktop release qualification

An uploaded CI artifact, a built app directory, and a successful fresh install are partial evidence. They do not qualify a release. Rebuilding any installer changes its SHA-256 and invalidates every approval for that installer.

Run the Desktop installer candidate workflow at one canonical source commit/version. Hosted native builds produce unqualified bytes with status `built`; they do not attempt unattended native dialogs. The subsequent operator-attended native matrix must succeed before assembly or draft staging. Configure four self-hosted graphical runners with labels `self-hosted`, `placekeeper-qualification`, and their target (`darwin-arm64`, `darwin-x64`, `win32-x64`, or `linux-x64`). Use disposable, ordinary-user accounts with browser/desktop access; Linux also needs apt/dpkg, sandbox-compatible storage and administrator permission to install the package. Configure the `desktop-native-qualification` environment with a required human reviewer, and approve only while an operator can respond to the installer dialogs. An absent runner, rejected approval, failed native test, or unsupported sandbox policy leaves assembly/staging closed. Reusable calls and non-main runs can build diagnostics but cannot bypass the attended native gate. Their exact guarded DMG, Setup.exe and deb files, native build records, source archive and source bootstrap feed one assembly job. Only that job's complete candidate can be staged as a draft. The draft initially contains an empty qualification manifest, so publication fails by design. Source fallback validation cannot publish independently.

The complete draft inventory is the four filenames returned by `desktopAssetNames`, `placekeeper-source-vVERSION.tar.gz`, `install-placekeeper.sh`, `SHA256SUMS`, and `desktop-qualification.json`. Checksums cover all six payloads. The manifest also pins both source payload hashes and covers each desktop filename/hash/target and its source commit and candidate workflow run. Publication re-downloads the draft and the original complete candidate artifact from the successful trusted workflow run; it never rebuilds installers. Both inventories and every payload byte must agree. Expired or unavailable candidate provenance leaves publication closed. Only the manifest can be replaced with reviewed evidence. Unexpected or duplicate assets block publication.

For every target, supply exactly one passing, hash-bound result for each scenario below. A skipped, cancelled, unavailable or manually untested result cannot satisfy a scenario. Evidence must link to the repository's retained workflow run, issue or PR record and include the same candidate run, commit and hash as the manifest. Keep native automated results, interactive OS approval, and real-host results separate. The publication environment `desktop-release` must require a human reviewer who checks the linked records. A JSON status alone is not proof that the interaction happened.

| Required scenario | Evidence to retain |
| --- | --- |
| Fresh install | Actual supported installer entrypoint; bundled runtime and shell/PDF readiness; no development toolchain; default PDF association unchanged |
| Identical reinstall | Same downloaded bytes, usable existing installation and unchanged work |
| Accepted upgrade | Informed consent with active reviews in each host; acknowledged closure after durable writes; new shell usable |
| Declined upgrade | Decline the actual installer dialog; incumbent stays usable and work remains |
| Pending and failed writes | Delayed acknowledged write settles before replacement; failed protection prevents replacement |
| Startup failure and recovery | Exact candidate activation failure; controlled retirement; prior installation and newer user data recoverable |
| Uninstall and reinstall | Ordinary platform uninstall removes owned resources/registrations, preserves documents/recovery/unknown state, and reinstall reads retained work |
| Integration repair | Previously opted-in registrations repaired; edited/foreign registrations preserved; host actions reported accurately |
| Downloaded OS approval | Browser-download staged exact bytes, retain quarantine/Mark of the Web, exercise normal OS approval without disabling protections |
| Real-host integrations | Native VS Code, Chrome and Codex on isolated profiles where supported, required trust/restart/permission actions and actual review work |
| Linux multiple users | Two logged-in users, separate state roots, immutable prior runtime retained while either user still uses it |
| Debian removal and purge | Real apt/dpkg install/upgrade/remove/purge; no root GUI; retained potentially active runtimes and user work; sandbox still enforced |
| Public legacy service migration (Apple Silicon) | Actual published AppKit service creates accepted annotation and Protected Draft; exact DMG refuses unsafe retirement while retaining the old process and draft. User explicitly saves the draft in the old UI, then both annotations survive safe migration |
| Public legacy native migration (Apple Silicon) | Actual AppKit windows/preferences generated under proven isolation, documents/annotations/recovery/preferences survive; old integrations repaired or required actions identified |

## Native commands

Fresh install plus identical reinstall uses an unused port and creates its own short isolated state root:

```sh
PLACEKEEPER_NATIVE_INSTALLER_ARTIFACT=/absolute/path/to/exact.dmg \
PLACEKEEPER_NATIVE_INSTALLER_PORT=63828 \
pnpm test:desktop-installers
```

On Windows supply the exact Setup.exe and run the same command with native environment-variable syntax. To additionally exercise uninstall/reinstall, set `PLACEKEEPER_NATIVE_UNINSTALL_REINSTALL=1`; approve the real uninstall dialog. Keep the printed evidence directory. The ordinary installation sentinel must survive. This does not replace the platform's default uninstall UI qualification. To require the macOS download metadata assertion, set `PLACEKEEPER_REQUIRE_DOWNLOADED_APPROVAL=1` after downloading in a real browser; the test does not generate quarantine metadata.

The authentic legacy service fixture requires the published source archive, its extracted source with release descriptor, and the AppKit app built from that archive. It verifies the public archive SHA-256 and AppKit bundle identity before launching only its bundled service with temporary HOME:

```sh
PLACEKEEPER_LEGACY_APP=/absolute/path/to/authentic/Placekeeper.app \
PLACEKEEPER_LEGACY_SOURCE=/absolute/path/to/extracted/placekeeper-source \
PLACEKEEPER_LEGACY_ARCHIVE=/absolute/path/to/placekeeper-source-v0.2.4.tar.gz \
PLACEKEEPER_NATIVE_INSTALLER_ARTIFACT=/absolute/path/to/exact.dmg \
PLACEKEEPER_LEGACY_PORT=63829 \
pnpm test:desktop-legacy
```

The public baseline is commit `3e37ca4b84dde61725b8e03d87dbc3023f1d1f4f`, archive SHA-256 `d67be517bf191966ea4d380d00f75cca3b7804e4920d007adf20bbb927d62a41`. An Electron app with a changed version string is not an acceptable baseline. The fixture never launches `PlacekeeperMac` or writes the real `local.placekeeper` preference domain: HOME alone is not proven to isolate standard UserDefaults. The public AppKit release supported Apple Silicon only; native legacy migration is required on that target, and no Intel historical-baseline result is requested. The service fixture can support only the automated conservative service migration result. The actual public service deletes clean recovery at shutdown without considering unfinished Protected Drafts. The candidate must therefore refuse that unsafe retirement, retain the running legacy service and draft, and identify the required user save action. The fixture verifies refusal before letting the user finish that draft through the original browser UI. It never requests legacy shutdown during failure cleanup while a pending draft remains. Automatic migration of unfinished legacy drafts is not established by this scenario. Full legacy UI/preferences/host evidence remains required separately.

The attended Linux native qualification job installs the actual deb, checks the root-owned immutable runtime and sandbox helper, then invokes the installed dispatcher as an ordinary user with a temporary HOME. An incompatible host sandbox policy fails the native job; do not add `--no-sandbox` or disable host protections to make it pass. Remove/purge and multiple-user qualification remain separate obligations. Administrator cleanup of retained `/opt/placekeeper/runtimes` is manual only after all users' sessions are closed; never traverse their home/state/recovery trees.

## Record before publication

- [ ] Final four installer hashes and both source hashes match the complete staged candidate.
- [ ] All required automated native lifecycle results refer to those exact final hashes.
- [ ] Real browser DOM typing and an in-flight input write are frozen/protected across simultaneous live hosts; accepted preparation closes them and reopening recovers the acknowledged input. Callback/protocol unit tests and ordinary Electron window-close tests alone do not establish this scenario.
- [ ] Downloaded unsigned OS approval has been exercised on every supported target.
- [ ] Actual public legacy service and native migration evidence are both complete.
- [ ] Real VS Code, Chrome and Codex results show remaining host actions accurately.
- [ ] Linux multiple-user, removal and purge evidence is complete.
- [ ] Required human reviewer has checked the manifest and retained evidence records.
- [ ] A separately authorized Publish qualified desktop release run is requested.

No item above is pre-checked. The current implementation work does not authorize release publication. Intermediate local DMG results do not qualify later rebuilt bytes. Missing Windows/Linux hosts, downloaded OS interactions, real DOM typing across the shared multi-host upgrade barrier, legacy native preferences/UI, or real-host access leave publication closed. After separately authorized publication, the single publisher verifies anonymous public reachability and hashes for every asset and reports any failure.
