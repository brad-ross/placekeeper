# Electron shell spike results

Observed on 2026-09-03 on arm64 macOS 26.5.2. This is decision evidence for a
timeboxed spike, not a release qualification or an Electron adoption record.

## What passed

- Electron 43.4.0 (Chromium 150.0.7871.224, Node 24.18.1) loaded the existing
  packaged Placekeeper client and its PDFium worker/WASM without client changes.
- Two corrected Launch Services PDF runs reached the normal cap-free review
  route in 975-1,069 ms from receipt of the `open-file` action and 1,515-1,563
  ms of process uptime, with the service already available.
- A corrected spike-only deep link reopened the active document in 797 ms,
  retained the same renderer PID, and reported the reused window focused.
- The probe derives process timing from process uptime and timestamps each
  action when the app receives it, including actions queued before readiness.
- The effective renderer preferences reported `sandbox: true`,
  `contextIsolation: true`, `nodeIntegration: false`, and `webSecurity: true`.
  There is no preload script or renderer-visible Electron/launcher API.
- Native visual inspection showed a normal document title bar and menu bar with
  no visible loopback URL or overlap. The accessible Next Page command moved
  from page 1/2 to 2/2, and the right workspace opened with its Search and
  Annotations tabs plus a labeled PDF search field.
- The temporary bundle was ad-hoc signed, passed strict deep signature
  verification, and declared an alternate PDF viewer plus a separate spike-only
  URL scheme without replacing the installed Placekeeper bundle.

## Measured cost

- Temporary Electron bundle: 275 MB.
- Current installed Placekeeper bundle: 143 MB.
- The corrected paired PDF/deep-link run reported four Electron processes and
  approximately 474 MB of aggregate Electron working set after the initial
  review, rising to approximately 551 MB after the same-window deep link.
  Main-process RSS was approximately 159-161 MB. These figures exclude the
  existing Placekeeper daemon, which remains necessary for every host.
- A generic Node recursive copy changed framework-relative symlinks into
  absolute links and caused code signing to fail. Packaging had to use macOS
  `ditto` before the bundle could be signed successfully. This is a useful
  warning against treating Electron packaging as an ordinary directory copy.

## Still deliberately unresolved

- Protected Recovery choices fail closed instead of being reimplemented.
- Annotation mutation, save/export, reload recovery, and VoiceOver were not
  manually qualified inside Electron, although the same client has browser and
  WebKit coverage elsewhere in the repository.
- Developer ID signing, notarization, stapling, auto-update, and release CI were
  not attempted.
- The timing sample did not isolate a stopped-daemon cold start. It measures the
  presentation path after the existing service was available.
- The spike retains Electron's stock helper identities and icon. Production
  branding and a complete bundle manifest remain real packaging work.

## Interpretation

Electron is technically viable as a deliberately unprivileged presentation
shell around the existing service. It buys fast reuse, predictable Chromium
behavior, and clean macOS open/focus semantics. It does not remove the loopback
service needed by Chrome, VS Code, ordinary browsers, and Codex, and it roughly
doubles the current app footprint while adding an Electron patch/security
cadence. Adoption should therefore depend on whether its implementation-speed
advantage beats a measured WKWebView shell, not on renderer feasibility.
