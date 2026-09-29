/** Explicit ordered stages. Repeated stages and suite omissions are intentional. */
export type TestStage = string | {
  runner: 'vitest' | 'playwright';
  options: string[];
  files: string[];
};

export const suites: Record<string, TestStage[]> = {
  "test:source-release": [{ runner: "vitest", options: [], files: ["scripts/source-release.test.ts", "scripts/install-release.test.ts"] }],
  "test:static:distribution": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "scripts/validate-static-distribution.test.ts"
      ]
    }
  ],
  "test": [
    "pnpm test:service",
    "pnpm test:u4",
    "pnpm test:u5",
    "pnpm test:u6",
    "pnpm test:u7-host"
  ],
  "test:pdf-writer": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "test/conformance/pdf-writer.conformance.test.ts"
      ]
    }
  ],
  "test:reviewed-pdf": [
    "pnpm fixtures:pdf",
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "test/conformance/reviewed-pdf.test.ts"
      ]
    }
  ],
  "test:pdf-viewer": [
    "pnpm fixtures:pdf",
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/conformance/pdf-viewer.conformance.spec.ts",
        "test/conformance/pdf-appearance.conformance.spec.ts"
      ]
    }
  ],
  "test:static:artifact": [
    {
      "runner": "playwright",
      "options": [
        "--config",
        "scripts/testing/config/playwright.static.config.ts"
      ],
      "files": []
    }
  ],
  "test:static:secondary-full": [
    "PLACEKEEPER_STATIC_ENGINE=firefox PLACEKEEPER_STATIC_PROFILE=exhaustive pnpm test:static:artifact",
    "PLACEKEEPER_STATIC_ENGINE=webkit PLACEKEEPER_STATIC_PROFILE=exhaustive pnpm test:static:artifact"
  ],
  "test:static:unit": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/web/test/static-runtime.test.ts",
        "apps/web/test/static-entry.test.ts",
        "packages/core/test/portable-annotation.test.ts",
        "packages/pdf-backends/test/browser-writer.test.ts",
        "scripts/static-release.test.ts"
      ]
    }
  ],
  "test:static:conformance": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "test/conformance/pdf-writer.conformance.test.ts",
        "test/conformance/reviewed-pdf.test.ts"
      ]
    }
  ],
  "test:static": [
    "pnpm fixtures:pdf",
    "pnpm test:static:unit",
    "pnpm test:static:conformance",
    "pnpm build:static:pages",
    "pnpm validate:static",
    "PLACEKEEPER_STATIC_ENGINE=chromium PLACEKEEPER_STATIC_PROFILE=exhaustive pnpm test:static:artifact",
    "PLACEKEEPER_STATIC_ENGINE=firefox PLACEKEEPER_STATIC_PROFILE=representative pnpm test:static:artifact",
    "PLACEKEEPER_STATIC_ENGINE=webkit PLACEKEEPER_STATIC_PROFILE=representative pnpm test:static:artifact"
  ],
  "test:static:pr": [
    "pnpm fixtures:pdf",
    "pnpm test:static:unit",
    "pnpm typecheck",
    "pnpm build:static:pages",
    "pnpm validate:static",
    "pnpm test:static:distribution",
    "PLACEKEEPER_STATIC_ENGINE=chromium PLACEKEEPER_STATIC_PROFILE=critical pnpm test:static:artifact"
  ],
  "test:pdf-conformance": [
    "pnpm fixtures:pdf",
    "pnpm test:pdf-writer",
    "pnpm test:reviewed-pdf",
    "pnpm test:pdf-viewer"
  ],
  "test:chrome-extension": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/chrome-extension/test/*.test.ts"
      ]
    }
  ],
  "test:chrome-runtime": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "packages/core/test/review-runtime-protocol.test.ts",
        "apps/web/test/host-runtime.test.ts",
        "apps/web/test/embedpdf-viewer.test.ts",
        "apps/web/test/pdf-document-title.test.ts",
        "apps/web/test/review-location-history.test.ts",
        "apps/web/test/copy-link-control.test.ts",
        "apps/chrome-extension/test/native-protocol.test.ts",
        "apps/service/test/chrome-local-refresh.integration.test.ts",
        "apps/service/test/chrome-download-folder.test.ts",
        "apps/service/test/chrome-runtime.test.ts"
      ]
    }
  ],
  "test:chrome-handoff:unit": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/chrome-extension/test/*.test.ts",
        "apps/service/test/chrome-native-messaging.test.ts",
        "apps/service/test/chrome-handoff.test.ts",
        "apps/service/test/chrome-native-host.test.ts",
        "apps/service/test/chrome-daemon-handoff.test.ts",
        "apps/service/test/chrome-local-refresh.integration.test.ts",
        "apps/service/test/browser-source-store.test.ts",
        "apps/service/test/pdf-save-coordinator.test.ts",
        "apps/web/test/production-review-app.test.tsx",
        "packaging/macos/chrome-integration.test.ts",
        "test/acceptance/installed-chrome.test.ts"
      ]
    }
  ],
  "test:chrome-handoff": [
    "pnpm fixtures:pdf",
    "pnpm build:chrome",
    "pnpm test:chrome-handoff:unit",
    {
      "runner": "playwright",
      "options": [
        "--config",
        "scripts/testing/config/playwright.chrome-handoff.config.ts"
      ],
      "files": []
    }
  ],
  "test:chrome-installed": [
    "tsx test/acceptance/installed-chrome.ts"
  ],
  "test:service": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "packages/core/test/live-context.test.ts",
        "packages/core/test/placekeeper-link.test.ts",
        "apps/service/test/placekeeper-link.test.ts",
        "apps/service/test/session-security.test.ts",
        "apps/service/test/review-interactions.test.ts",
        "apps/service/test/recovery.test.ts",
        "apps/service/test/local-document-observer.test.ts",
        "apps/service/test/live-document-replacement.test.ts",
        "apps/service/test/pdf-save-coordinator.test.ts",
        "apps/service/test/export-transaction.test.ts",
        "apps/service/test/replace-original.test.ts",
        "apps/service/test/synctex.test.ts",
        "apps/service/test/task-binding-registry.test.ts",
        "apps/service/test/restart-reconnect-store.test.ts",
        "apps/service/test/launch-host.test.ts",
        "apps/service/test/open-command.test.ts",
        "apps/service/test/doctor-command.test.ts",
        "apps/service/test/hook-contract.test.ts",
        "apps/service/test/context-command.test.ts",
        "apps/service/test/live-context-service.test.ts",
        "apps/service/test/pdf-evidence-service.test.ts",
        "apps/service/test/source-reconciliation-service.test.ts",
        "apps/service/test/live-source-workflow.test.ts",
        "apps/service/test/codex-live-context.integration.test.ts"
      ]
    }
  ],
  "test:security": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/service/test/session-security.test.ts",
        "apps/service/test/review-interactions.test.ts",
        "apps/service/test/recovery.test.ts",
        "apps/service/test/export-transaction.test.ts",
        "apps/service/test/replace-original.test.ts"
      ]
    }
  ],
  "test:web": [
    "pnpm fixtures:pdf",
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/web/test/text-reliability.test.ts",
        "apps/web/test/selection-anchor.test.ts",
        "apps/web/test/reading-location.test.ts",
        "apps/web/test/owned-overlay.test.ts",
        "apps/web/test/annotation-surface.test.ts",
        "apps/web/test/owned-mark-hit-test.test.ts",
        "apps/web/test/reference-pdf-viewport.test.ts",
        "apps/web/test/viewer-interaction-events.test.ts",
        "apps/web/test/app-interactions.test.ts",
        "apps/web/test/existing-annotations.test.ts"
      ]
    },
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/acceptance/viewer.spec.ts"
      ]
    }
  ],
  "test:review": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "packages/core/test/review-commands.test.ts",
        "apps/web/test/save-state-controller.test.ts",
        "apps/web/test/proofread-gestures.test.tsx",
        "apps/web/test/selection-anchor.test.ts",
        "apps/web/test/selection-state.test.ts",
        "apps/web/test/review-surface-state.test.ts",
        "apps/web/test/viewer-controls.test.ts",
        "apps/web/test/viewer-framing.test.ts",
        "apps/web/test/review-layout.test.tsx",
        "apps/web/test/annotation-projection.test.ts",
        "apps/web/test/production-review-app.test.tsx",
        "apps/web/test/review-shell-reference-authoring.test.tsx",
        "apps/web/test/refresh-interaction-lifecycle.test.tsx",
        "apps/web/test/interaction-reconnect-runtime.test.ts",
        "apps/web/test/use-authoring-session-lifecycle.test.ts",
        "apps/web/test/codex-context-status.test.tsx",
        "apps/web/test/existing-annotations.test.ts",
        "apps/web/test/main-location-refresh.test.ts",
        "apps/web/test/navigation-coordinator.test.ts",
        "apps/web/test/review-location-history.test.ts",
        "apps/web/test/copy-link-control.test.ts",
        "apps/web/test/session-api.test.ts"
      ]
    },
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/acceptance/review-workflow.spec.ts",
        "test/acceptance/reattachment-tray.spec.ts"
      ]
    }
  ],
  "test:save-export": [
    "pnpm fixtures:pdf",
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/service/test/pdf-save-coordinator.test.ts",
        "apps/service/test/export-transaction.test.ts",
        "apps/service/test/replace-original.test.ts",
        "test/conformance/reviewed-pdf.test.ts"
      ]
    }
  ],
  "test:source-rebuild": [
    "pnpm fixtures:pdf",
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/service/test/live-source-workflow.test.ts",
        "apps/service/test/source-reconciliation-service.test.ts",
        "apps/service/test/context-command.test.ts",
        "apps/service/test/live-document-replacement.test.ts",
        "apps/vscode/test/extension.test.ts",
        "apps/vscode/test/review-panel-controller.test.ts",
        "apps/vscode/test/latex-workshop-bridge.test.ts",
        "apps/vscode/test/external-launch-registration.test.ts",
        "apps/vscode/test/rebuild-observer.test.ts",
        "apps/service/test/local-document-observer.test.ts",
        "test/conformance/reviewed-pdf.test.ts"
      ]
    }
  ],
  "test:e2e": [
    "pnpm build:vscode",
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/acceptance/launch-surfaces.spec.ts",
        "test/acceptance/viewer.spec.ts",
        "test/acceptance/review-workflow.spec.ts",
        "test/acceptance/production-flow.spec.ts",
        "test/acceptance/reloadable-links.spec.ts",
        "test/acceptance/legible-link-destinations.spec.ts",
        "test/acceptance/interface-followup.spec.ts",
        "test/acceptance/neutral-workspace-followup.spec.ts",
        "test/acceptance/workspace-row-interactions.spec.ts",
        "test/acceptance/pdf-mark-design.spec.ts",
        "test/acceptance/neutral-design-conformance.spec.ts",
        "test/acceptance/host-interface.spec.ts",
        "test/acceptance/macos-interface.spec.ts",
        "test/acceptance/annotation-behavior-followup.spec.ts",
        "test/acceptance/reference-annotations.spec.ts",
        "test/acceptance/reference-annotation-stale-commands.spec.ts",
        "test/acceptance/reattachment-tray.spec.ts",
        "test/acceptance/automatic-pdf-refresh.spec.ts",
        "test/acceptance/authoring-lifecycle-regressions.spec.ts"
      ]
    }
  ],
  "test:e2e:webkit": [
    "pnpm build:vscode",
    {
      "runner": "playwright",
      "options": [
        "--config",
        "scripts/testing/config/playwright.webkit.config.ts"
      ],
      "files": [
        "test/acceptance/launch-surfaces.spec.ts",
        "test/acceptance/viewer.spec.ts",
        "test/acceptance/review-workflow.spec.ts",
        "test/acceptance/production-flow.spec.ts",
        "test/acceptance/reloadable-links.spec.ts",
        "test/acceptance/legible-link-destinations.spec.ts",
        "test/acceptance/interface-followup.spec.ts",
        "test/acceptance/neutral-workspace-followup.spec.ts",
        "test/acceptance/workspace-row-interactions.spec.ts",
        "test/acceptance/pdf-mark-design.spec.ts",
        "test/acceptance/macos-interface.spec.ts",
        "test/acceptance/annotation-behavior-followup.spec.ts",
        "test/acceptance/reference-annotations.spec.ts",
        "test/acceptance/reference-annotation-stale-commands.spec.ts",
        "test/acceptance/reattachment-tray.spec.ts",
        "test/acceptance/automatic-pdf-refresh.spec.ts",
        "test/acceptance/authoring-lifecycle-regressions.spec.ts"
      ]
    }
  ],
  "test:visual": [
    "pnpm build:web",
    {
      "runner": "playwright",
      "options": [
        "--config",
        "scripts/testing/config/playwright.visual.config.ts"
      ],
      "files": []
    }
  ],
  "test:host-integration": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/service/test/launch-host.test.ts",
        "apps/service/test/open-command.test.ts",
        "apps/service/test/doctor-command.test.ts",
        "apps/service/test/codex-live-context.integration.test.ts",
        "apps/service/test/live-source-workflow.test.ts",
        "apps/service/test/live-document-replacement.test.ts",
        "apps/service/test/recovery.test.ts",
        "apps/web/test/codex-context-status.test.tsx",
        "apps/web/test/host-runtime.test.ts",
        "apps/web/test/production-review-app.test.tsx",
        "apps/vscode/test/extension.test.ts",
        "packaging/macos/packaging.test.ts"
      ]
    },
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/acceptance/launch-surfaces.spec.ts"
      ]
    }
  ],
  "test:upgrade-lifecycle": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/service/test/macos-daemon-runtime.test.ts",
        "apps/service/test/open-command.test.ts",
        "apps/chrome-extension/test/native-protocol.test.ts",
        "apps/service/test/chrome-runtime.test.ts",
        "packaging/macos/chrome-integration.test.ts",
        "packaging/macos/packaging.test.ts"
      ]
    }
  ],
  "test:production-integration": [
    "pnpm fixtures:pdf",
    "pnpm test:service",
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "apps/web/test/production-review-app.test.tsx",
        "apps/web/test/owned-overlay.test.ts",
        "apps/web/test/annotation-surface.test.ts",
        "apps/web/test/review-shell-reference-authoring.test.tsx",
        "apps/vscode/test/extension.test.ts",
        "packaging/macos/packaging.test.ts"
      ]
    },
    "pnpm build",
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/acceptance/production-flow.spec.ts",
        "test/acceptance/reference-annotations.spec.ts",
        "test/acceptance/reference-annotation-stale-commands.spec.ts"
      ]
    }
  ],
  "test:full-validation": [
    "pnpm fixtures:pdf",
    "pnpm test:service",
    "pnpm test:review",
    "pnpm test:u7-host",
    "pnpm test:pdf-conformance",
    "pnpm build",
    "pnpm test:e2e",
    "pnpm test:e2e:webkit",
    "pnpm validate:distribution"
  ],
  "test:ci:unit": [
    "pnpm build:vscode",
    {
      "runner": "vitest",
      "options": [
        "--config",
        "scripts/testing/config/vitest.ci.config.ts"
      ],
      "files": []
    }
  ],
  "test:ci:chromium": [
    {
      "runner": "playwright",
      "options": ["--config", "scripts/testing/config/playwright.config.ts"],
      "files": [
        "test/conformance/pdf-viewer.conformance.spec.ts",
        "test/conformance/pdf-appearance.conformance.spec.ts",
        "test/acceptance/viewer.spec.ts",
        "test/acceptance/review-workflow.spec.ts",
        "test/acceptance/launch-surfaces.spec.ts",
        "test/acceptance/production-flow.spec.ts",
        "test/acceptance/reloadable-links.spec.ts",
        "test/acceptance/legible-link-destinations.spec.ts",
        "test/acceptance/interface-followup.spec.ts",
        "test/acceptance/neutral-workspace-followup.spec.ts",
        "test/acceptance/workspace-row-interactions.spec.ts",
        "test/acceptance/pdf-mark-design.spec.ts",
        "test/acceptance/neutral-design-conformance.spec.ts",
        "test/acceptance/host-interface.spec.ts",
        "test/acceptance/macos-interface.spec.ts",
        "test/acceptance/annotation-behavior-followup.spec.ts",
        "test/acceptance/reference-annotations.spec.ts",
        "test/acceptance/reference-annotation-stale-commands.spec.ts",
        "test/acceptance/reattachment-tray.spec.ts",
        "test/acceptance/automatic-pdf-refresh.spec.ts",
        "test/acceptance/authoring-lifecycle-regressions.spec.ts"
      ]
    }
  ],
  "test:ci:webkit": [
    {
      "runner": "playwright",
      "options": [
        "--config",
        "scripts/testing/config/playwright.webkit.config.ts"
      ],
      "files": [
        "test/conformance/pdf-viewer.conformance.spec.ts",
        "test/conformance/pdf-appearance.conformance.spec.ts",
        "test/acceptance/viewer.spec.ts",
        "test/acceptance/review-workflow.spec.ts",
        "test/acceptance/production-flow.spec.ts",
        "test/acceptance/reloadable-links.spec.ts",
        "test/acceptance/legible-link-destinations.spec.ts",
        "test/acceptance/interface-followup.spec.ts",
        "test/acceptance/neutral-workspace-followup.spec.ts",
        "test/acceptance/workspace-row-interactions.spec.ts",
        "test/acceptance/pdf-mark-design.spec.ts",
        "test/acceptance/macos-interface.spec.ts",
        "test/acceptance/annotation-behavior-followup.spec.ts",
        "test/acceptance/reference-annotations.spec.ts",
        "test/acceptance/reference-annotation-stale-commands.spec.ts",
        "test/acceptance/reattachment-tray.spec.ts",
        "test/acceptance/authoring-lifecycle-regressions.spec.ts"
      ]
    }
  ],
  "test:ci:visual": [
    {
      "runner": "playwright",
      "options": [
        "--config",
        "scripts/testing/config/playwright.visual.config.ts"
      ],
      "files": []
    }
  ],
  "test:ci": [
    "pnpm fixtures:pdf",
    "pnpm catalog:check",
    "pnpm typecheck",
    "pnpm test:ci:unit",
    "pnpm test:chrome-handoff",
    "pnpm build:web",
    "pnpm test:ci:chromium",
    "pnpm test:ci:webkit",
    "pnpm test:ci:visual",
    "pnpm validate:distribution"
  ],
  "test:electron-spike": [
    "pnpm --dir apps/electron-spike test"
  ],
  "test:macos:native": [
    "swift test --package-path apps/macos"
  ],
  "test:macos:gate": [
    {
      "runner": "vitest",
      "options": [],
      "files": [
        "packages/core/test/macos-shell-protocol.test.ts",
        "packages/core/test/macos-helper-protocol.test.ts",
        "apps/service/test/macos-native-gate.test.ts",
        "apps/web/test/macos-entry.test.tsx",
        "packaging/macos/macos-native-gate.test.ts"
      ]
    },
    "swift test --package-path apps/macos"
  ]
};

/** Canonical CI is deliberately narrower than all repository tests; includes the updater's .mjs tests. */
export const ciUnitFiles = [
      'apps/service/test/macos-daemon-runtime.test.ts',
      'scripts/source-release.test.ts',
      'scripts/install-release.test.ts',
      'test/ci-workflow.test.ts',
      'apps/chrome-extension/test/*.test.ts',
      'test/conformance/pdf-writer.conformance.test.ts',
      'test/conformance/reviewed-pdf.test.ts',
      'packages/pdf-backends/test/backend-host.test.ts',
      'apps/service/test/canonical-json.test.ts',
      'apps/service/test/runtime-retention.test.ts',
      'apps/service/test/chrome-download-folder.test.ts',
      'apps/service/test/chrome-runtime.test.ts',
      'apps/service/test/macos-runtime.test.ts',
      'apps/service/test/session-security.test.ts',
      'apps/service/test/review-interactions.test.ts',
      'apps/service/test/recovery.test.ts',
      'apps/service/test/pdf-save-coordinator.test.ts',
      'apps/service/test/export-transaction.test.ts',
      'apps/service/test/replace-original.test.ts',
      'apps/service/test/synctex.test.ts',
      'apps/service/test/task-binding-registry.test.ts',
      'apps/service/test/launch-host.test.ts',
      'apps/service/test/open-command.test.ts',
      'apps/service/test/doctor-command.test.ts',
      'apps/service/test/hook-contract.test.ts',
      'apps/service/test/context-command.test.ts',
      'apps/service/test/live-context-service.test.ts',
      'apps/service/test/pdf-evidence-service.test.ts',
      'apps/service/test/source-reconciliation-service.test.ts',
      'apps/service/test/live-source-workflow.test.ts',
      'apps/service/test/local-document-observer.test.ts',
      'apps/service/test/live-document-replacement.test.ts',
      'apps/service/test/codex-live-context.integration.test.ts',
      'packages/core/test/live-context.test.ts',
      'packages/core/test/placekeeper-link.test.ts',
      'apps/service/test/placekeeper-link.test.ts',
      'packages/core/test/review-commands.test.ts',
      'apps/web/test/save-state-controller.test.ts',
      'apps/web/test/proofread-gestures.test.tsx',
      'apps/web/test/selection-anchor.test.ts',
      'apps/web/test/reading-location.test.ts',
      'apps/web/test/selection-state.test.ts',
      'apps/web/test/review-surface-state.test.ts',
      'apps/web/test/viewer-controls.test.ts',
      'apps/web/test/viewer-framing.test.ts',
      'apps/web/test/review-layout.test.tsx',
      'apps/web/test/annotation-projection.test.ts',
      'apps/web/test/production-review-app.test.tsx',
      'apps/web/test/annotation-surface.test.ts',
      'apps/web/test/reference-pdf-viewport.test.ts',
      'apps/web/test/review-shell-reference-authoring.test.tsx',
      'apps/web/test/codex-context-status.test.tsx',
      'apps/web/test/existing-annotations.test.ts',
      'apps/web/test/refresh-interaction-lifecycle.test.tsx',
      'apps/web/test/interaction-reconnect-runtime.test.ts',
      'apps/web/test/use-authoring-session-lifecycle.test.ts',
      'apps/web/test/main-location-refresh.test.ts',
      'apps/web/test/host-runtime.test.ts',
      'apps/web/test/session-api.test.ts',
      'apps/web/test/navigation-coordinator.test.ts',
      'apps/web/test/review-location-history.test.ts',
      'apps/web/test/copy-link-control.test.ts',
      'scripts/pdf-symbol-catalog/compile.test.ts',
      'scripts/pdf-symbol-catalog/generate.test.ts',
      'apps/web/test/pdf-search-model.test.ts',
      'apps/web/test/pdf-search-controller.test.ts',
      'apps/web/test/pdf-search-results.test.ts',
      'apps/web/test/pdf-symbol-catalog.test.ts',
      'apps/web/test/pdf-search-workspace.test.tsx',
      'apps/vscode/test/extension.test.ts',
      'apps/vscode/test/review-panel-controller.test.ts',
      'apps/vscode/test/latex-workshop-bridge.test.ts',
      'apps/vscode/test/external-launch-registration.test.ts',
      'apps/vscode/test/rebuild-observer.test.ts',
      'apps/vscode/test/rebuild-navigation.test.ts',
      'packaging/macos/packaging.test.ts',
      'packaging/macos/native-blob-install.test.ts',
      'packaging/macos/update-vscode.test.mjs',
      'packaging/macos/setup-integrations.test.mjs',
    ];

export const browserTestFiles = {
  default: '**/*.spec.ts',
  visual: 'review-visual.spec.ts',
  chromeHandoff: 'chrome-pdf-handoff.spec.ts',
  static: ['static-web.spec.ts', 'static-web-url.spec.ts'],
};

export function suiteCommand(name: string): string {
  const stages = suites[name];
  if (!stages) throw new Error(`Unknown test suite: ${name}`);
  return stages.map(stage => typeof stage === 'string' ? stage
    : [stage.runner, stage.runner === 'vitest' ? 'run' : 'test', ...stage.options, ...stage.files].join(' ')).join(' && ');
}
