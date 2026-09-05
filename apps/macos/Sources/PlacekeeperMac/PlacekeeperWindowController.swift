import AppKit
import Foundation
@preconcurrency import WebKit

@MainActor
final class PlacekeeperWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static let toolbarHorizontalMargin: CGFloat = 16
    let windowID: String
    let canonicalReviewID: String
    let documentDigest: String
    let documentURL: URL
    private let webView: WKWebView
    private let schemeHandler: MacSchemeHandler
    private let attemptID: String
    private let runtimeID: String
    private let bridge: ReviewBridge
    private let displayName: String
    private let admission: MacReviewAdmission
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"
    private var readiness = ShellReadinessFence()
    private var dragFence: DragRegionFence
    private var dragOverlays: [NSView] = []
    private var installedDragRegions: [DragRect] = []
    private var installedDragWebHeight: CGFloat = -1
    private let onClose: (String) -> Void
    private let onBecameKey: (String) -> Void
    private var closed = false
    private var failed = false
    private var visiblePaintConfirmed = false
    private var pendingDocumentReadyGeneration: Int?
    private var activationStarted = false
    private var readinessDiagnosticScheduled = false
    private var pdfiumData: Data?
    private var workerData: Data?
    private(set) var commandSnapshot: MacCommandSnapshot?
    private var commandToken = 0
    private let onCommandSnapshot: (String) -> Void
    private let onRetry: (String) -> Void
    private let onDiagnostics: () -> Void
    private let centersOnFirstRoutingCommit: Bool

    init(
        windowID: String,
        documentURL: URL,
        packagedRoot: URL,
        attemptID: String,
        runtimeID: String,
        helper: SupervisedReviewHelper,
        admission: MacReviewAdmission,
        packagedAssets: PackagedReviewAssets,
        restoredFrame: NSRect? = nil,
        onBecameKey: @escaping (String) -> Void,
        onCommandSnapshot: @escaping (String) -> Void,
        onRetry: @escaping (String) -> Void,
        onDiagnostics: @escaping () -> Void,
        onClose: @escaping (String) -> Void
    ) {
        self.windowID = windowID
        self.canonicalReviewID = admission.projection.sessionID
        self.documentDigest = admission.digest
        self.documentURL = documentURL
        self.onClose = onClose
        self.onBecameKey = onBecameKey
        self.onCommandSnapshot = onCommandSnapshot
        self.onRetry = onRetry
        self.onDiagnostics = onDiagnostics
        self.attemptID = attemptID
        self.runtimeID = runtimeID
        self.admission = admission
        self.displayName = admission.displayName
        self.bridge = ReviewBridge(runtimeID: runtimeID, attemptID: attemptID, helper: helper, admission: admission)
        self.pdfiumData = packagedAssets.pdfium
        self.workerData = packagedAssets.worker
        self.centersOnFirstRoutingCommit = InitialWindowPlacementPolicy.shouldCenter(
            hasRestoredFrame: restoredFrame != nil
        )
        let geometryIdentity = "geometry_" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))
        self.dragFence = DragRegionFence(geometryIdentity: geometryIdentity)

        let contentController = WKUserContentController()
        let configuration = WKWebViewConfiguration()
        let handler = MacSchemeHandler(
            packagedRoot: packagedRoot,
            manifestKeys: [
                "macos.html",
                "assets/shell.js",
                "assets/shell.css",
                "assets/pdfium.wasm",
                "assets/pdfium-worker.js",
            ],
            helper: helper,
            admission: admission
        )
        self.schemeHandler = handler
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = contentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(handler, forURLScheme: "placekeeper-app")
        configuration.setURLSchemeHandler(handler, forURLScheme: "placekeeper-resource")
        webView = WKWebView(frame: .zero, configuration: configuration)
        if diagnosticsEnabled, #available(macOS 13.3, *) { webView.isInspectable = true }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = displayName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        let toolbar = NSToolbar(identifier: "PlacekeeperReviewToolbar")
        toolbar.allowsUserCustomization = false
        toolbar.autosavesConfiguration = false
        toolbar.displayMode = .iconOnly
        toolbar.showsBaselineSeparator = false
        window.toolbar = toolbar
        window.toolbarStyle = .unified
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        contentController.add(self, name: "placekeeperShell")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        let controller = NSViewController()
        let contentView = NSView(frame: NSRect(origin: .zero, size: window.contentLayoutRect.size))
        webView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            webView.topAnchor.constraint(equalTo: contentView.topAnchor),
            webView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
        ])
        controller.view = contentView
        window.contentViewController = controller
        alignTrafficLights()
        window.backgroundColor = NSColor(calibratedRed: 0.965, green: 0.949, blue: 0.918, alpha: 1)
        if let restoredFrame { window.setFrame(restoredFrame, display: false) }
    }

    required init?(coder: NSCoder) { nil }

    func start() {
        let rules = """
        [
          {"trigger":{"url-filter":"^https?://","resource-type":["document","image","style-sheet","script","font","raw","svg-document","media","popup"]},"action":{"type":"block"}},
          {"trigger":{"url-filter":"^wss?://","resource-type":["document","image","style-sheet","script","font","raw","svg-document","media","popup"]},"action":{"type":"block"}}
        ]
        """
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "local.placekeeper.macos.zero-egress.v1",
            encodedContentRuleList: rules
        ) { [weak self] ruleList, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.diagnostic("content-rule-error: \(error.localizedDescription)")
                    self.helperDidFail()
                    return
                }
                guard let ruleList,
                      let url = URL(string: "placekeeper-app://bundle/macos.html") else { return }
                self.diagnostic("content-rules-ready")
                self.webView.configuration.userContentController.add(ruleList)
                self.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
            }
        }
    }

    func helperDidFail() {
        guard !closed, !failed else { return }
        failed = true
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "placekeeperShell")
        schemeHandler.invalidate()
        installDragOverlays([])
        commandSnapshot = nil
        let controller = CatastrophicFallbackViewController(
            documentName: displayName,
            onRetry: { [weak self] in
                guard let self else { return }
                self.onRetry(self.windowID)
            },
            onDiagnostics: onDiagnostics,
            onClose: { [weak self] _ in self?.window?.performClose(nil) }
        )
        window?.contentViewController = controller
        window?.center()
        NSApplication.shared.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        guard !closed else { return }
        closed = true
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "placekeeperShell")
        schemeHandler.invalidate()
        installDragOverlays([])
        onClose(windowID)
    }

    func windowDidBecomeKey(_ notification: Notification) { onBecameKey(windowID) }

    func focus() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    @discardableResult
    func invokeCommand(_ command: MacReviewCommand) -> Bool {
        guard !closed, !failed, let snapshot = commandSnapshot,
              snapshot.commands[command]?.enabled == true else { return false }
        commandToken += 1
        sendToPage([
            "protocolVersion": 1,
            "type": "invoke-command",
            "runtimeId": runtimeID,
            "attemptId": attemptID,
            "command": command.rawValue,
            "snapshotRevision": snapshot.revision,
            "token": commandToken,
        ])
        return true
    }

    var restorationRecord: RestorableDocumentWindow? {
        guard let window else { return nil }
        return .init(
            sourcePath: documentURL.standardizedFileURL.path,
            frame: NSStringFromRect(window.frame),
            page: nil,
            zoom: nil
        )
    }

    func windowWillStartLiveResize(_ notification: Notification) { beginGeometryTransition() }

    func windowDidEndLiveResize(_ notification: Notification) {
        alignTrafficLights()
        endGeometryTransition()
    }

    func windowWillEnterFullScreen(_ notification: Notification) { beginGeometryTransition() }

    func windowDidEnterFullScreen(_ notification: Notification) {
        alignTrafficLights()
        endGeometryTransition()
    }

    func windowWillExitFullScreen(_ notification: Notification) { beginGeometryTransition() }

    func windowDidExitFullScreen(_ notification: Notification) {
        alignTrafficLights()
        endGeometryTransition()
    }

    func windowDidResize(_ notification: Notification) { alignTrafficLights() }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        beginGeometryTransition()
        alignTrafficLights()
        endGeometryTransition()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        beginGeometryTransition()
        alignTrafficLights()
        endGeometryTransition()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "placekeeperShell", let body = message.body as? [String: Any],
              let type = MacPageBridgeMessageType.parse(body) else { return }
        if type == .shellReady,
           Set(body.keys) == Set(["protocolVersion", "type", "layoutRevision"]),
           let revision = body["layoutRevision"] as? Int, revision >= 0 {
            _ = readiness.shellReady(revision: revision)
            if readiness.commitRouting() {
                alignTrafficLights()
                if centersOnFirstRoutingCommit { window?.center() }
                NSApplication.shared.activate(ignoringOtherApps: true)
                window?.makeKeyAndOrderFront(nil)
                readiness.didOrderVisible()
                sendToPage(["protocolVersion": 1, "type": "commit-visible", "geometryIdentity": dragFence.geometryIdentity])
            }
            diagnostic(.shellReadyAccepted)
            return
        }
        if type == .documentReady,
           Set(body.keys) == Set(["protocolVersion", "type", "runtimeId", "attemptId", "generation"]),
           body["runtimeId"] as? String == runtimeID,
           body["attemptId"] as? String == attemptID,
           let generation = body["generation"] as? Int,
           generation == admission.generation {
            pendingDocumentReadyGeneration = generation
            activateWhenReady()
            diagnostic(.documentReadyAccepted)
            return
        }
        if type == .runtimeMessage,
           Set(body.keys) == Set(["protocolVersion", "type", "runtimeId", "attemptId", "message"]),
           body["runtimeId"] as? String == runtimeID,
           body["attemptId"] as? String == attemptID,
           let message = body["message"],
           MacPageRuntimeRequest.parse(message, runtimeID: runtimeID) != nil {
            bridge.handle(message) { [weak self] response in self?.sendRuntimeMessage(response) }
            diagnostic(.runtimeMessageAccepted)
            return
        }
        if type == .runtimeError,
           Set(body.keys) == Set(["protocolVersion", "type", "runtimeId", "attemptId", "stage"]),
           body["runtimeId"] as? String == runtimeID,
           body["attemptId"] as? String == attemptID,
           let stage = (body["stage"] as? String).flatMap(MacRuntimeErrorStage.init),
           stage == .runtime {
            diagnostic(.runtimeErrorAccepted)
            return
        }
        if type == .commandSnapshot,
           body["runtimeId"] as? String == runtimeID,
           body["attemptId"] as? String == attemptID,
           let snapshot = MacCommandSnapshot.parse(body),
           commandSnapshot == nil || snapshot.revision > commandSnapshot!.revision {
            commandSnapshot = snapshot
            diagnostic(.commandSnapshotAccepted)
            onCommandSnapshot(windowID)
            return
        }
        if type == .visibleShellReady,
           Set(body.keys) == Set(["protocolVersion", "type", "layoutRevision", "geometryIdentity", "frameSequence"]),
           let revision = body["layoutRevision"] as? Int,
           let frameSequence = body["frameSequence"] as? Int, frameSequence > 0,
           body["geometryIdentity"] as? String == dragFence.geometryIdentity {
            if revision == dragFence.currentRevision, readiness.confirmPaint(revision: revision) {
                visiblePaintConfirmed = true
                activateWhenReady()
                diagnostic(.visibleShellReadyAccepted)
            } else {
                diagnostic(.visibleShellReadyRejected)
            }
            scheduleReadinessDiagnostic()
            return
        }
        if type == .dragRegions,
           Set(body.keys) == Set(["protocolVersion", "type", "layoutRevision", "geometryIdentity", "transitioning", "regions"]),
           let revision = body["layoutRevision"] as? Int,
           let identity = body["geometryIdentity"] as? String,
           let transitioning = body["transitioning"] as? Bool,
           let rawRegions = body["regions"] as? [[String: Double]] {
            if transitioning {
                installDragOverlays([])
                diagnostic(.dragRegionsAccepted)
                return
            }
            let regions = rawRegions.compactMap { region -> DragRect? in
                guard let x = region["x"], let y = region["y"], let width = region["width"], let height = region["height"] else { return nil }
                return DragRect(x: x, y: y, width: width, height: height)
            }
            if regions.count == rawRegions.count, dragFence.apply(DragRegionSet(revision: revision, geometryIdentity: identity, regions: regions)) {
                installDragOverlays(regions)
                if readiness.orderedVisible, !visiblePaintConfirmed {
                    sendToPage([
                        "protocolVersion": 1,
                        "type": "commit-visible",
                        "geometryIdentity": dragFence.geometryIdentity,
                    ])
                }
                diagnostic(.dragRegionsAccepted)
            } else {
                installDragOverlays([])
                diagnostic(.dragRegionsRejected)
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        diagnostic("navigation-finished: web \(Int(webView.bounds.width))x\(Int(webView.bounds.height)), window \(Int(window?.frame.width ?? 0))x\(Int(window?.frame.height ?? 0))")
        installPackagedResources()
    }

    private func sendBootstrap() {
        sendToPage([
            "protocolVersion": 1,
            "type": "bootstrap",
            "runtimeId": runtimeID,
            "attemptId": attemptID,
            "document": [
                "displayName": displayName,
                "resource": [
                    "url": bridge.documentResourceURL,
                    "generation": admission.generation,
                    "mime": "application/pdf",
                    "byteLength": admission.byteLength,
                    "digest": admission.digest,
                ] as [String: Any],
            ],
            "geometry": [
                "identity": dragFence.geometryIdentity,
                "trafficLightInset": trafficLightInset(),
                "trafficLightBounds": trafficLightBounds(),
                "trailingInset": Double(Self.toolbarHorizontalMargin),
            ] as [String: Any],
        ])
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        diagnostic("navigation-error: \(error.localizedDescription)")
        helperDidFail()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        diagnostic("provisional-navigation-error: \(error.localizedDescription)")
        helperDidFail()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diagnostic("web-content-process-terminated")
        helperDidFail()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.targetFrame?.isMainFrame == true,
              let url = navigationAction.request.url,
              MacSchemePolicy.bundleKey(for: url) == "macos.html" else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    private func sendToPage(_ message: [String: Any]) {
        webView.callAsyncJavaScript(
            "globalThis.__PLACEKEEPER_MAC_RECEIVE__?.(message)",
            arguments: ["message": message],
            in: nil,
            in: .page
        ) { [weak self] result in
            if case let .failure(error) = result {
                self?.diagnostic("page-delivery-error: \(error.localizedDescription)")
            }
        }
    }

    private func sendRuntimeMessage(_ message: [String: Any]) {
        sendToPage([
            "protocolVersion": 1,
            "type": "runtime-message",
            "runtimeId": runtimeID,
            "attemptId": attemptID,
            "message": message,
        ])
    }

    private func activateWhenReady() {
        guard !activationStarted, visiblePaintConfirmed,
              let generation = pendingDocumentReadyGeneration else { return }
        activationStarted = true
        bridge.activate(generation: generation) { [weak self] active in
            if !active { self?.helperDidFail() }
        }
    }

    private func installDragOverlays(_ regions: [DragRect]) {
        let webHeight = webView.bounds.height
        guard regions != installedDragRegions || webHeight != installedDragWebHeight else { return }
        installedDragRegions = regions
        installedDragWebHeight = webHeight
        dragOverlays.forEach { $0.removeFromSuperview() }
        dragOverlays.removeAll()
        for region in regions {
            let y = webView.isFlipped
                ? region.y
                : Double(webView.bounds.height) - region.y - region.height
            let overlay = DraggableTitlebarView(frame: NSRect(
                x: region.x,
                y: y,
                width: region.width,
                height: region.height
            ), webView: webView)
            webView.addSubview(overlay)
            dragOverlays.append(overlay)
        }
    }

    private func beginGeometryTransition() {
        dragFence.transitionInProgress = true
        installDragOverlays([])
    }

    private func endGeometryTransition() {
        let identity = "geometry_" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))
        dragFence.rolloverGeometryIdentity(to: identity)
        sendToPage([
            "protocolVersion": 1,
            "type": "geometry-changed",
            "geometry": [
                "identity": dragFence.geometryIdentity,
                "trafficLightInset": trafficLightInset(),
                "trafficLightBounds": trafficLightBounds(),
                "trailingInset": Double(Self.toolbarHorizontalMargin),
            ] as [String: Any],
        ])
    }

    private func trafficLightInset() -> Double {
        guard let window else { return 76 }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap(window.standardWindowButton)
        guard let rightmost = buttons.max(by: { $0.frame.maxX < $1.frame.maxX }),
              let buttonSuperview = rightmost.superview else { return 76 }
        let rightEdgeInWindow = buttonSuperview.convert(
            NSPoint(x: rightmost.frame.maxX, y: rightmost.frame.midY),
            to: nil
        )
        let rightEdgeInWebView = webView.convert(rightEdgeInWindow, from: nil)
        return Double(ceil(rightEdgeInWebView.x + Self.toolbarHorizontalMargin))
    }

    private func trafficLightBounds() -> [[String: Double]] {
        guard let window else { return [] }
        return [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap(window.standardWindowButton)
            .compactMap { button -> [String: Double]? in
                let converted = webView.convert(button.bounds, from: button)
                let y = webView.isFlipped
                    ? converted.minY
                    : webView.bounds.height - converted.maxY
                guard converted.minX.isFinite, y.isFinite,
                      converted.width.isFinite, converted.width > 0,
                      converted.height.isFinite, converted.height > 0 else { return nil }
                return [
                    "x": Double(max(0, converted.minX)),
                    "y": Double(max(0, y)),
                    "width": Double(converted.width),
                    "height": Double(converted.height),
                ]
            }
    }

    private func alignTrafficLights() {
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap(window.standardWindowButton)
        guard let buttonSuperview = buttons.first?.superview,
              buttons.allSatisfy({ $0.superview === buttonSuperview }) else { return }
        window.contentView?.layoutSubtreeIfNeeded()
        let toolbarLeadingInWindow = webView.convert(
            NSPoint(x: Self.toolbarHorizontalMargin, y: webView.bounds.midY),
            to: nil
        )
        let toolbarLeadingInButtonSuperview = buttonSuperview.convert(toolbarLeadingInWindow, from: nil)
        guard let trafficLightLeft = buttons.map(\.frame.minX).min() else { return }
        let horizontalOffset = toolbarLeadingInButtonSuperview.x - trafficLightLeft
        for button in buttons {
            button.setFrameOrigin(NSPoint(
                x: button.frame.origin.x + horizontalOffset,
                y: button.frame.origin.y
            ))
        }
    }

    private func diagnostic(_ message: String) {
        guard diagnosticsEnabled,
              let bytes = "[PlacekeeperMac] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(bytes)
    }

    private func diagnostic(_ event: MacPageBridgeDiagnosticEvent) {
        diagnostic(event.rawValue)
    }

    private func scheduleReadinessDiagnostic() {
        guard diagnosticsEnabled, !readinessDiagnosticScheduled else { return }
        readinessDiagnosticScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, !self.closed, self.pendingDocumentReadyGeneration == nil else { return }
            self.webView.callAsyncJavaScript(
                """
                const viewport = document.querySelector('[data-viewer-framing-viewport]');
                const workspace = document.querySelector('.pdf-workspace');
                const macosShell = document.querySelector('.macos-loading-shell');
                const reviewShell = document.querySelector('.review-shell');
                const viewportBounds = viewport?.getBoundingClientRect();
                const workspaceBounds = workspace?.getBoundingClientRect();
                const rootBounds = document.querySelector('#root')?.getBoundingClientRect();
                const macosShellBounds = macosShell?.getBoundingClientRect();
                const reviewShellBounds = reviewShell?.getBoundingClientRect();
                return JSON.stringify({
                  documentReadyState: document.readyState,
                  runtimeLoading: document.querySelectorAll('[data-runtime-loading-workspace]').length,
                  viewerLoading: document.querySelectorAll('.pdf-workspace__loading').length,
                  viewerViewport: document.querySelectorAll('[data-viewer-framing-viewport]').length,
                  pageElements: document.querySelectorAll('[data-page-index]').length,
                  pageImages: document.querySelectorAll('[data-page-index] img').length,
                  completeImages: [...document.querySelectorAll('[data-page-index] img')].filter((image) => image.complete).length,
                  nonzeroImages: [...document.querySelectorAll('[data-page-index] img')].filter((image) => image.naturalWidth > 0 && image.naturalHeight > 0).length,
                  viewportWidth: Math.round(viewportBounds?.width ?? 0),
                  viewportHeight: Math.round(viewportBounds?.height ?? 0),
                  workspaceWidth: Math.round(workspaceBounds?.width ?? 0),
                  workspaceHeight: Math.round(workspaceBounds?.height ?? 0),
                  rootWidth: Math.round(rootBounds?.width ?? 0),
                  rootHeight: Math.round(rootBounds?.height ?? 0),
                  macosShellWidth: Math.round(macosShellBounds?.width ?? 0),
                  macosShellHeight: Math.round(macosShellBounds?.height ?? 0),
                  reviewShellWidth: Math.round(reviewShellBounds?.width ?? 0),
                  reviewShellHeight: Math.round(reviewShellBounds?.height ?? 0),
                  viewportChildren: viewport?.childElementCount ?? 0
                });
                """,
                arguments: [:],
                in: nil,
                in: .page
            ) { [weak self] result in
                switch result {
                case let .success(value): self?.diagnostic("readiness-snapshot: \(String(describing: value))")
                case let .failure(error): self?.diagnostic("readiness-snapshot-failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func installPackagedResources() {
        guard let pdfiumData, let workerData else {
            diagnostic("executable-resource-install-invalid")
            helperDidFail()
            return
        }
        schemeHandler.loadDocument { [weak self] result in
            DispatchQueue.main.async {
                guard let self, !self.closed else { return }
                guard case let .success(documentData) = result else {
                    self.diagnostic("document-install-invalid")
                    self.helperDidFail()
                    return
                }
                self.installBlob(role: "pdfium", mime: "application/wasm", data: pdfiumData) { installed in
                    self.pdfiumData = nil
                    guard installed else {
                        self.diagnostic("pdfium-install-failed")
                        self.helperDidFail()
                        return
                    }
                    self.installBlob(role: "worker", mime: "application/javascript", data: workerData) { installed in
                        self.workerData = nil
                        guard installed else {
                            self.diagnostic("worker-install-failed")
                            self.helperDidFail()
                            return
                        }
                        self.installBlob(
                            role: "document",
                            mime: "application/pdf",
                            data: documentData,
                            source: self.bridge.documentResourceURL
                        ) { installed in
                            self.schemeHandler.releaseDocumentCache()
                            guard installed else {
                                self.diagnostic("document-install-failed")
                                self.helperDidFail()
                                return
                            }
                            self.diagnostic("packaged-resources-installed")
                            self.sendBootstrap()
                        }
                    }
                }
            }
        }
    }

    private func installBlob(
        role: String,
        mime: String,
        data: Data,
        source: String? = nil,
        completion: @escaping (Bool) -> Void
    ) {
        installBlobChunk(role: role, mime: mime, data: data, source: source, offset: 0, completion: completion)
    }

    private func installBlobChunk(
        role: String,
        mime: String,
        data: Data,
        source: String?,
        offset: Int,
        completion: @escaping (Bool) -> Void
    ) {
        guard !closed, !failed else { completion(false); return }
        let chunkSize = 256 * 1024
        if offset < data.count {
            let end = min(data.count, offset + chunkSize)
            let encoded = data.subdata(in: offset..<end).base64EncodedString()
            webView.callAsyncJavaScript(
                """
                const binary = atob(base64);
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
                const parts = globalThis.__PLACEKEEPER_MAC_BLOB_PARTS__ ??= {};
                (parts[role] ??= []).push(bytes);
                return bytes.length;
                """,
                arguments: ["base64": encoded, "role": role],
                in: nil,
                in: .page
            ) { [weak self] result in
                guard let self else { return }
                guard case let .success(value) = result, (value as? NSNumber)?.intValue == end - offset else {
                    completion(false)
                    return
                }
                self.installBlobChunk(
                    role: role,
                    mime: mime,
                    data: data,
                    source: source,
                    offset: end,
                    completion: completion
                )
            }
            return
        }
        var arguments: [String: Any] = ["role": role, "mime": mime]
        if let source { arguments["source"] = source }
        webView.callAsyncJavaScript(
            """
            const parts = globalThis.__PLACEKEEPER_MAC_BLOB_PARTS__?.[role];
            if (!Array.isArray(parts) || parts.length === 0) return false;
            const url = URL.createObjectURL(new Blob(parts, { type: mime }));
            delete globalThis.__PLACEKEEPER_MAC_BLOB_PARTS__[role];
            if (role === 'pdfium') globalThis.__PLACEKEEPER_MAC_PDFIUM_URL__ = url;
            else if (role === 'worker') globalThis.__PLACEKEEPER_MAC_WORKER_URL__ = url;
            else globalThis.__PLACEKEEPER_MAC_DOCUMENT_RESOURCE__ = { source, url };
            return url.startsWith('blob:');
            """,
            arguments: arguments,
            in: nil,
            in: .page
        ) { result in
            guard case let .success(value) = result else { completion(false); return }
            completion(value as? Bool == true)
        }
    }

}

private final class DraggableTitlebarView: NSView {
    private weak var webView: WKWebView?

    init(frame frameRect: NSRect, webView: WKWebView) {
        self.webView = webView
        super.init(frame: frameRect)
    }

    required init?(coder: NSCoder) { nil }

    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        webView?.evaluateJavaScript("document.activeElement?.blur()")
        if event.clickCount == 2 {
            window?.performZoom(nil)
            return
        }
        window?.performDrag(with: event)
    }
}
