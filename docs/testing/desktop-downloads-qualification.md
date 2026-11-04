# Desktop downloads and manual upgrades: local qualification

Date: 2026-11-03. Runtime source: `2ae2becb`. This report qualifies the checks below on macOS arm64; it does not authorize a desktop release or qualify other operating systems.

## Exact local artifact

| Item | SHA-256 / identity |
|---|---|
| `Placekeeper-0.3.0-macos-arm64.dmg` | `dda5edd7b422f511d51d407125291eecb61c41498570aed292c5a778598c2763` |
| Runtime manifest | `14fe9f723ab47c939f53019b97390f88cddf493ddc8fbe4ef4ad2f1ee74c846e` |
| Daemon identity | `9e51fad4f3d35bfd491748bc4c0bea9b68fc60372afb6f097ed4cf28e942563e` |
| Install artifact identity | `07f8aad1bf604e58e52fe1f33c95bf1a6c2b252934d0790737d9995d96756887` |
| Electron `app.asar` | `3ca3dc1d6ae7924a42f011235aefa658906605410ba240704dfb193b56e85726` |

The packaged app used by the installed suite and the app nested inside this DMG had identical `app.asar` and runtime-manifest hashes. Runtime files are individually covered by the manifest. All native checks used temporary destinations, private service roots and copied PDFs. The user's installation and recovery were not replaced.

## Results

| Check | Result and scope |
|---|---|
| Combined desktop, Electron, upgrade, release and distribution unit/integration suites, plus routing and MCP entrypoint checks | 725 passed, 14 platform skips; 88 files passed, 3 skipped; 40.61 seconds |
| Full TypeScript and whitespace checks | Passed |
| Real browser preparation | Three passed, 28.5 seconds: two composers protect their final DOM text before commit and recover on reopen; an Electron renderer observing commit early stays mounted; persistence failure cancels and restores editing without animation frames |
| Packaged Electron | All 13 passed, 1.1 minutes, including real PDF rendering/edit/save/reopen, restoration, MCP startup through an aliased temporary path, warm/inverse/delayed/cold SyncTeX, and authenticated prepared closure |
| Prepared Electron closure | Final composer input is durable before acknowledgment; the exact app PID exits before harness cleanup; restoration remains nonempty and unchanged; no second ordinary close settlement occurs |
| Renderer startup failure | Passed: candidate service and shell retire before the retained app is restored |
| Interrupted activation | Passed: reentry retires the exact interrupted candidate and retains protected data |
| Compatible service rollback | Passed, 3.4 seconds: current → earlier preparation-capable runtime → current preserves acknowledged recovery |
| Exact native DMG lifecycle | Passed, 3.7 minutes: fresh install, identical reinstall, uninstall, reinstall; user-data sentinel preserved; actual installer dialogs and renderer readiness receipts observed |
| Authentic public 0.2.4 service migration | Passed, 2.8 minutes: installer refusal retains old process and unfinished draft; old browser UI explicitly applies/saves both notes; manual old-service retirement precedes migration; PDF bytes/annotations and user sentinel remain preserved |
| Uninstall notice | Native dialog names the retained recovery app and support-folder backup |
| Static website | Build passed. Integrated browser checked landing page, unavailable-download/source-only guidance, install modal and Escape/focus return. Earlier focused wide/narrow Chromium suite: eight passed |

The original service rollback comparison used an older runtime without preparation v1. The final runtime correctly refused to retire it. The passing compatible-runtime comparison used the earlier verified `5b3635c8` payload; this is not a claim that automatic legacy shutdown is supported.

The native prepared-closure test begins at the already-consented private controller boundary. It does not prove installer consent UI across simultaneous browser, editor and Codex hosts. Browser tests use actual composers and service persistence; they do not use test-issued draft writes to stand in for typing.

## Review

The final implementation review identified eight defects. All were fixed and committed in `2ae2becb`; an independent review of its 29-file delta found no new actionable defects. The fixes cover committed closure grace, retained-resource notices, quit restoration capture, repeated renderer settlement, background-frame independence, Electron closure ownership, real composer regression coverage, and Debian package identity validation.

The old animation-frame behavior reproduced a preparation timeout before its fix. Real browser execution exposed overlapping settlement reproof canceling an already-ready attempt; its focused regression and all three browser cases pass after correction. Packaged checks separately exposed and fixed MCP startup through `/tmp` versus `/private/tmp` aliases.

## Release gates still closed

- Final Windows, macOS Intel and Debian installer lifecycle evidence, including Linux multi-user activation and remove/purge.
- Browser-downloaded unsigned artifacts and actual OS approval behavior. Local builds do not prove Gatekeeper, SmartScreen or organization policy behavior.
- Real VS Code, Chrome and Codex trust/activation, and simultaneous mixed-host consented closure.
- Full legacy AppKit UI/preferences migration. The authentic old-service fixture is narrower.
- Accessibility, Wayland, macOS 13, large scanned/recovery corpora, named-editor placement and physical display latency.

The release workflow requires exact-artifact native evidence before staging and separately authorized publication. No release was published. Historical four-platform and performance results in [the Electron migration report](electron-migration-qualification.md) retain their original commit scope and do not qualify these final installer bytes.

The broader historical Chromium run was not rerun in full. Its compact Reference-action popup interception remains unresolved; prior baseline classifications remain in the migration report. The targeted checks above do not erase that residual.
