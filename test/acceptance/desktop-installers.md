# Desktop release validation

Run the Desktop installer candidate workflow at one canonical source commit/version. All four hosted native builds (macOS arm64/x64, Windows x64 and Linux x64), platform tests and packaged runtime tests must succeed before assembly. These tests do not establish attended installer interaction, browser-downloaded unsigned OS approval, full lifecycle testing or real-host integration behavior. Operator-attended self-hosted runners and an external qualification report are not release requirements.

The complete draft inventory is the four filenames returned by `desktopAssetNames`, `placekeeper-source-vVERSION.tar.gz`, `install-placekeeper.sh`, `SHA256SUMS`, and `desktop-build-provenance.json`. Checksums cover all six payloads. Build provenance pins every desktop filename/hash/target, both source hashes, the source commit and candidate workflow run. The source archive descriptor must match the same version and commit. Only the complete assembled candidate can be staged as a draft; source fallback validation cannot publish independently.

Dispatch Publish desktop release on main with the stable version, full source commit, successful candidate run and reviewed public notes. The publisher checks that the originating Desktop installer candidate workflow completed successfully on main through workflow_dispatch at that exact commit. It downloads the original complete candidate artifact and the staged draft without rebuilding. Both complete inventories and every byte, including build provenance, must agree. Missing, expired, unexpected, duplicate or changed assets block publication. Publication creates a stable latest release and verifies anonymous public download hashes for every asset.

## Optional attended qualification

The following commands and scenarios remain available for deeper testing. They are separate evidence and are not publication gates. An uploaded CI artifact, a built app directory and successful packaged runtime tests do not establish these interactions. Rebuilding an installer changes its SHA-256 and invalidates prior evidence for those bytes. Retain hash-bound records and state which scenarios were actually exercised. The optional `validate:desktop-qualification` command checks the older full qualification report independently of the release inventory.

| Optional scenario | Evidence to retain |
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

The public baseline is commit `3e37ca4b84dde61725b8e03d87dbc3023f1d1f4f`, archive SHA-256 `d67be517bf191966ea4d380d00f75cca3b7804e4920d007adf20bbb927d62a41`. An Electron app with a changed version string is not an acceptable baseline. The fixture never launches `PlacekeeperMac` or writes the real `local.placekeeper` preference domain: HOME alone is not proven to isolate standard UserDefaults. The public AppKit release supported Apple Silicon only; native legacy migration is relevant on that target, and no Intel historical-baseline result is requested. The service fixture can support only the automated conservative service migration result. The actual public service deletes clean recovery at shutdown without considering unfinished Protected Drafts. The candidate must therefore refuse that unsafe retirement, retain the running legacy service and draft, and identify the required user save action. The fixture verifies refusal before letting the user finish that draft through the original browser UI. It never requests legacy shutdown during failure cleanup while a pending draft remains. Automatic migration of unfinished legacy drafts is not established by this scenario. Full legacy UI/preferences/host evidence must be recorded separately to claim that coverage.

For attended Linux qualification, install the actual deb, check the root-owned immutable runtime and sandbox helper, then invoke the installed dispatcher as an ordinary user with a temporary HOME. An incompatible host sandbox policy fails that check; do not add `--no-sandbox` or disable host protections to make it pass. Remove/purge and multiple-user qualification remain separate scenarios. Administrator cleanup of retained `/opt/placekeeper/runtimes` is manual only after all users' sessions are closed; never traverse their home/state/recovery trees.

## Record the release

- Record the final four installer hashes and both source hashes from the complete candidate.
- Confirm the trusted hosted candidate run passed for the exact source commit.
- Retain the immutable build provenance and checked public download hashes.
- State any attended installer, downloaded OS approval, legacy migration and real-host testing that was actually performed, including its artifact scope. Leave unperformed scenarios unclaimed.

Historical local DMG results and earlier platform reports keep their original commit and artifact scope. They do not establish coverage for rebuilt release bytes.
