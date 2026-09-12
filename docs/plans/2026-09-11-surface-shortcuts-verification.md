# Layout and view shortcut verification

The user approved Control–Command–0/L/O/A/R across native, browser, and VS Code on Mac, superseding the earlier Command-0 proposal. Non-Mac browser and VS Code bindings use Control–Alt.

- Page and zoom fields use font-relative em widths. A native WKWebView probe reproduced double scaling of ch widths under pageZoom; em follows text sizing.
- The gap above bottom References uses the same measured overlay inset as the outer tray margins.
- Fit Width, horizontal lock/unlock, Outline, Annotations, and References share semantic command handling, with native menu and VS Code host routes. Unavailable destinations and active editing/modal states retain appropriate guards.
- 49 focused unit tests passed, including command availability, key matching, and host protocol validation.
- Four Chromium acceptance tests passed: reference-focus shortcut routing/editable protection, tray gap, bottom gutter, and classic scrollbar inset. The classic scrollbar test now waits for responsive layout before measuring its initial canvas.
- Root and VS Code TypeScript checks passed. Web and isolated native candidate builds passed.
- Native UI checks confirmed Annotations, horizontal lock/unlock, and Fit Width. Chrome UI checks confirmed Outline, Annotations, and References. Automated browser coverage exercised all five commands.
- Independent review completed; its destination-availability finding was fixed and tested.

Candidate: `/tmp/placekeeper-surface-shortcuts-final/Placekeeper.app` (isolated identity and private state; installed application untouched).

Limits: native XCTest remains waived by the user. A live VS Code host check was not performed. Earlier physical keyboard/pinch verification for the broader app-zoom work remains pending; this record does not claim that gate is complete.
