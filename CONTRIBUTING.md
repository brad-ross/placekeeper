# Contributing

Read [Concepts](docs/concepts.md) for domain vocabulary and the [documentation index](docs/README.md) for operating instructions, decisions, and captured learnings. Installation and user workflows remain in the [README](README.md).

## Repository map

| Area | Responsibility |
| --- | --- |
| `apps/web` | Shared production review client, PDF interaction adapters, host runtimes, static entry, and native web entry. |
| `apps/service` | Local review authority: file capabilities, session lifecycle, durable recovery, PDF saves, source reconciliation, and host transports. |
| `apps/macos` | Native AppKit windows, lifecycle, menus, and the embedded web bridge. |
| `apps/vscode` | Trusted-workspace review panel, rebuild observation, editor navigation, and packaged web assets. |
| `apps/chrome-extension` | PDF interception, browser source acquisition, and the Chrome runtime bridge. |
| `apps/electron-spike` | Preserved decision probe; not an adopted production host. See its [README](apps/electron-spike/README.md). |
| `packages/core` | Review state, commands, reducers, geometry, portable annotation contracts, and host protocol vocabulary. |
| `packages/pdf-backends` | PDF inspection, annotation import, and verified writing through the selected backend. |
| `scripts/build` | Pinned PDFium worker extraction and shared asset loading/emission. Host Vite configs retain host policy. |
| `scripts/testing` | Explicit suite membership and ordered stages, thin command adapter, and shared browser/static configuration. |
| `scripts/pdf-symbol-catalog` | Deterministic generation and audited updates from pinned standards inputs. |
| `packaging/macos` | Bundle validation, isolated candidates, transactional installation, and installed-consumer integration updates. |
| `test` | Cross-package conformance, browser acceptance, fixtures, and shared test support. |

## Ownership within the review client

`ProductionReviewApp` composes the host runtime and mounted document. Focused hooks own search demand and cancellation (`pdf/use-pdf-search.ts`), save-destination attempts (`save/use-save-destination.ts`), SyncTeX request currentness (`host/use-host-synctex.ts`), and live context polling (`host/use-codex-context.ts`). Pure host projections live beside those hooks. Shared transport/result types belong in neutral modules rather than a component that consumes them.

`ReviewShell` composes layout, input routing, and its domain models. `review/use-authoring-session.ts` owns frozen authoring authority, draft protection, command ordering, and settlement; `review/use-annotation-reader.ts` owns detail identity, measured-overflow resumption, and cancellable focus/scroll restoration. Geometry placement and navigation remain distinct from those transient lifecycles.

`SessionBroker` is the service facade and sole session authority. Its preparation helpers build candidates; they do not independently publish, persist, end sessions, or schedule a competing write tail. `RecoveryDecisions` and `PresentationRecords` own bounded bookkeeping, while the broker authorizes and applies their records. SyncTeX preparation remains in `synctex/generation-binding.ts`; the broker serializes attachment and operation-token publication.

## Style ownership

`apps/web/src/app/review-layout.css` and `neutral-chrome.css` are ordered entrypoints. The neutral overrides load after base layout. Do not regroup late rules merely because their selectors name the same component: their position is part of the cascade.

| Stylesheet group | Owner |
| --- | --- |
| `review-shell-chrome.css`, `review-viewer-framing.css` | Production root, titlebar, reading frame, workspace hosts, and native clipping boundary. |
| `review-workspace-surfaces.css`, `review-search-references.css`, `review-outline-row-actions.css` | Trays, Search/References, Outline, and row actions. |
| `review-annotation-rows-reader.css`, `review-annotation-marks-reconciliation.css` | Annotation content, full reader, marks, and reconciliation surfaces. |
| `review-recovery.css`, `review-document-actions.css` | Recovery and document/save actions, including body-portaled menus. |
| `neutral-controls.css`, `neutral-editor-surfaces.css`, `neutral-workspace-navigation.css` | Neutral controls, editors, and workspace navigation overrides. |
| `neutral-context-status.css`, `neutral-annotation-rows-reader.css`, `neutral-workspace-interactions.css` | Status, annotation hierarchy, and deliberately late interaction refinements. |
| `review-design-tokens.css`, `review-modal-surface.css` | Scoped shared tokens and modal/control grammar, including recovery, static launcher, and Chrome handler consumers. |

Global `--pk-*` and scoped `--review-*` properties are not interchangeable aliases. Keep portal and non-production-root consumers in view. The native drawer overflow exception requires actual native first-paint evidence; browser layout bounds alone cannot prove that WKWebView painted its contents.

## Build and test

Use the Node and pnpm requirements in `package.json` (Node 24 or newer; pnpm 11.16.0) and the locked dependencies:

```sh
pnpm install --frozen-lockfile
pnpm fixtures:pdf
pnpm build
pnpm typecheck
```

The root build orders service, VS Code, and Chrome. The VS Code build first rebuilds the shared production web bundle, then packages it into the extension; copying an old web directory is not a freshness check. `build:web` checks the mathematical-symbol catalog before bundling. Native web and static profiles have separate builds:

```sh
pnpm build:macos:web
pnpm verify:static:distribution
```

Use canonical aliases for the affected boundary:

| Alias | Purpose |
| --- | --- |
| `pnpm test:service`, `pnpm test:security` | Service authority and security contracts. |
| `pnpm test:web`, `pnpm test:review` | Web and review-model suites. |
| `pnpm test:save-export` | Save and export behavior; historical alias `test:u5`. |
| `pnpm test:source-rebuild` | Source/rebuild workflows; historical alias `test:u6`. |
| `pnpm test:host-integration` | Host integration; historical alias `test:u7-host`. |
| `pnpm test:production-integration` | Production integration; historical alias `test:u7`. |
| `pnpm test:full-validation` | Existing full-validation sequence; historical alias `test:u8`. |
| `pnpm test:ci:unit` | Explicit CI unit membership, including the `.mjs` VS Code updater test. |
| `pnpm test:e2e`, `pnpm test:e2e:webkit`, `pnpm test:visual` | Browser behavior and platform-specific visual coverage. |
| `pnpm test:static:pr`, `pnpm test:static` | Static PR matrix and broader static validation sequence. |

The authoritative ordered membership is in `scripts/testing/suites.ts`; `run-suite.ts` executes it. Aliases overlap intentionally. `pnpm test` is its declared sequence, not an automatic union of every repository test. When adding coverage, choose its suite deliberately and preserve prerequisite order. Focused characterization tests outside default suites can be run explicitly with `pnpm exec vitest run <paths>`.

For a native candidate, `pnpm package:macos:native-candidate` builds into an isolated output; `packaging/macos/run-native-candidate.ts` supplies private runtime state. User installation and installed-extension updates are separate operations described in [installation](docs/installation.md).

## Verification and documentation

For behavior-preserving refactors, capture baseline behavior before extraction, retain public command semantics, and compare the same inputs afterward. Keep tests at public boundaries; do not change snapshots merely because the refactor caused failures. Record existing failures separately from newly introduced differences and distinguish browser evidence from native or installed-host evidence.

Capture a new learning when a verified fix exposes reasoning that its code and tests do not explain. Refresh existing learnings when paths, ownership, or guidance drift; retain dated incident evidence and independent problems. Plans and experiments are historical context, not automatic evidence that every proposed feature shipped.

Useful starting points:

- [Shared production client and host authority](docs/solutions/architecture-patterns/shared-production-review-client-host-runtime-boundaries.md)
- [Atomic generation transitions](docs/solutions/architecture-patterns/atomic-generation-transitions-for-rebuilt-pdf-reviews.md)
- [Annotation autosave and recovery](docs/solutions/architecture-patterns/recoverable-editable-pdf-annotation-autosave.md)
- [Contextual authoring](docs/solutions/design-patterns/contextual-annotation-composer-preserves-document-context-during-authoring.md)
- [Full annotation reader](docs/solutions/design-patterns/full-annotation-reader-preserves-tray-context.md)
