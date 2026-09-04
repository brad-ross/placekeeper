import AppKit
import CryptoKit
import Foundation
@preconcurrency import WebKit

@MainActor
final class PlacekeeperWindowController: NSWindowController, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let windowID: String
    private let webView: WKWebView
    private let schemeHandler: MacSchemeHandler
    private let displayName: String
    private let resourceID: String
    private let generation: Int
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"
    private var resourceBytes: Data
    private var readiness = ShellReadinessFence()
    private var dragFence: DragRegionFence
    private var dragOverlays: [NSView] = []
    private let onClose: (String) -> Void
    private var closed = false

    init(
        windowID: String,
        documentURL: URL,
        packagedRoot: URL,
        resourceID: String,
        generation: Int,
        resourceBytes: Data,
        onClose: @escaping (String) -> Void
    ) {
        self.windowID = windowID
        self.onClose = onClose
        self.displayName = documentURL.lastPathComponent
        self.resourceID = resourceID
        self.generation = generation
        self.resourceBytes = resourceBytes
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
            resourceID: resourceID,
            generation: generation,
            resourceBytes: resourceBytes
        )
        self.schemeHandler = handler
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = contentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(handler, forURLScheme: "placekeeper-app")
        configuration.setURLSchemeHandler(handler, forURLScheme: "placekeeper-resource")
        webView = WKWebView(frame: .zero, configuration: configuration)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = displayName
        window.representedURL = documentURL
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        contentController.add(self, name: "placekeeperShell")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        let controller = NSViewController()
        controller.view = webView
        window.contentViewController = controller
        window.backgroundColor = NSColor(calibratedRed: 0.965, green: 0.949, blue: 0.918, alpha: 1)
        window.center()
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
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "placekeeperShell")
        schemeHandler.invalidate()
        installDragOverlays([])
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 48, left: 48, bottom: 48, right: 48)
        let title = NSTextField(labelWithString: displayName)
        title.font = .preferredFont(forTextStyle: .title1)
        stack.addArrangedSubview(title)
        for action in CatastrophicAction.allCases {
            stack.addArrangedSubview(NSButton(title: action.rawValue, target: nil, action: nil))
        }
        let controller = NSViewController()
        controller.view = stack
        window?.contentViewController = controller
        window?.center()
        NSApplication.shared.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        NSAccessibility.post(element: stack, notification: .announcementRequested, userInfo: [
            .announcement: "Placekeeper could not continue this review.",
            .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
    }

    func windowWillClose(_ notification: Notification) {
        guard !closed else { return }
        closed = true
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "placekeeperShell")
        schemeHandler.invalidate()
        resourceBytes.removeAll()
        installDragOverlays([])
        onClose(windowID)
    }

    func windowWillStartLiveResize(_ notification: Notification) { beginGeometryTransition() }

    func windowDidEndLiveResize(_ notification: Notification) { endGeometryTransition() }

    func windowWillEnterFullScreen(_ notification: Notification) { beginGeometryTransition() }

    func windowDidEnterFullScreen(_ notification: Notification) { endGeometryTransition() }

    func windowWillExitFullScreen(_ notification: Notification) { beginGeometryTransition() }

    func windowDidExitFullScreen(_ notification: Notification) { endGeometryTransition() }

    func windowDidChangeBackingProperties(_ notification: Notification) {
        beginGeometryTransition()
        endGeometryTransition()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        beginGeometryTransition()
        endGeometryTransition()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "placekeeperShell", let body = message.body as? [String: Any],
              body["protocolVersion"] as? Int == macShellProtocolVersion,
              let type = body["type"] as? String else { return }
        diagnostic("page-message: \(type)")
        if type == "shell-ready", let revision = body["layoutRevision"] as? Int {
            _ = readiness.shellReady(revision: revision)
            if readiness.commitRouting() {
                window?.center()
                NSApplication.shared.activate(ignoringOtherApps: true)
                window?.makeKeyAndOrderFront(nil)
                readiness.didOrderVisible()
                sendToPage(["protocolVersion": 1, "type": "commit-visible", "geometryIdentity": dragFence.geometryIdentity])
            }
            return
        }
        if type == "visible-shell-ready", let revision = body["layoutRevision"] as? Int,
           body["geometryIdentity"] as? String == dragFence.geometryIdentity {
            _ = readiness.confirmPaint(revision: revision)
            return
        }
        if type == "drag-regions", let revision = body["layoutRevision"] as? Int,
           let identity = body["geometryIdentity"] as? String,
           let transitioning = body["transitioning"] as? Bool,
           let rawRegions = body["regions"] as? [[String: Double]] {
            if transitioning {
                installDragOverlays([])
                return
            }
            let regions = rawRegions.compactMap { region -> DragRect? in
                guard let x = region["x"], let y = region["y"], let width = region["width"], let height = region["height"] else { return nil }
                return DragRect(x: x, y: y, width: width, height: height)
            }
            if regions.count == rawRegions.count, dragFence.apply(DragRegionSet(revision: revision, geometryIdentity: identity, regions: regions)) {
                installDragOverlays(regions)
            } else {
                installDragOverlays([])
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        diagnostic("navigation-finished")
        let resourceURL = "placekeeper-resource://document/\(resourceID)?generation=\(generation)&role=document"
        sendToPage([
            "protocolVersion": 1,
            "type": "bootstrap",
            "document": [
                "displayName": displayName,
                "resource": [
                    "url": resourceURL,
                    "generation": generation,
                    "mime": "application/pdf",
                    "byteLength": resourceBytes.count,
                    "digest": SHA256.hash(data: resourceBytes).map { String(format: "%02x", $0) }.joined(),
                ] as [String: Any],
            ],
            "geometry": [
                "identity": dragFence.geometryIdentity,
                "trafficLightInset": trafficLightInset(),
                "trailingInset": 12,
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
        guard let url = navigationAction.request.url, MacSchemePolicy.permitsInWebView(url) else {
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
        ) { _ in }
    }

    private func installDragOverlays(_ regions: [DragRect]) {
        dragOverlays.forEach { $0.removeFromSuperview() }
        dragOverlays.removeAll()
        for region in regions {
            let overlay = DraggableTitlebarView(frame: NSRect(
                x: region.x,
                y: webView.bounds.height - region.y - region.height,
                width: region.width,
                height: region.height
            ))
            webView.addSubview(overlay)
            dragOverlays.append(overlay)
        }
    }

    private func beginGeometryTransition() {
        dragFence.transitionInProgress = true
        installDragOverlays([])
    }

    private func endGeometryTransition() {
        dragFence.geometryIdentity = "geometry_" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))
        dragFence.transitionInProgress = false
        sendToPage([
            "protocolVersion": 1,
            "type": "geometry-changed",
            "geometry": [
                "identity": dragFence.geometryIdentity,
                "trafficLightInset": trafficLightInset(),
                "trailingInset": 12,
            ] as [String: Any],
        ])
    }

    private func trafficLightInset() -> Double {
        guard let window else { return 76 }
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton]
            .compactMap(window.standardWindowButton)
        return buttons.map { $0.frame.maxX }.max() ?? 76
    }

    private func diagnostic(_ message: String) {
        guard diagnosticsEnabled,
              let bytes = "[PlacekeeperMac] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(bytes)
    }

}

private final class DraggableTitlebarView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { self }
}

private final class MacSchemeHandler: NSObject, WKURLSchemeHandler {
    private let packagedRoot: URL
    private let manifestKeys: Set<String>
    private let resourceID: String
    private let generation: Int
    private var resourceBytes: Data

    init(packagedRoot: URL, manifestKeys: Set<String>, resourceID: String, generation: Int, resourceBytes: Data) {
        self.packagedRoot = packagedRoot.standardizedFileURL
        self.manifestKeys = manifestKeys
        self.resourceID = resourceID
        self.generation = generation
        self.resourceBytes = resourceBytes
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard urlSchemeTask.request.httpMethod == "GET", let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.unsupportedURL)); return
        }
        if let key = MacSchemePolicy.bundleKey(for: url), manifestKeys.contains(key) {
            let file = packagedRoot.appendingPathComponent(key).standardizedFileURL
            guard file.path.hasPrefix(packagedRoot.path + "/"), let bytes = try? Data(contentsOf: file) else {
                urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist)); return
            }
            respond(urlSchemeTask, url: url, bytes: bytes, mime: mimeType(for: key)); return
        }
        if let identity = MacSchemePolicy.resourceIdentity(for: url), identity.id == resourceID,
           identity.generation == generation, resourceBytes.starts(with: Data("%PDF".utf8)) {
            respond(urlSchemeTask, url: url, bytes: resourceBytes, mime: "application/pdf"); return
        }
        urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile))
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    func invalidate() { resourceBytes.removeAll() }

    private func respond(_ task: WKURLSchemeTask, url: URL, bytes: Data, mime: String) {
        let response = URLResponse(url: url, mimeType: mime, expectedContentLength: bytes.count, textEncodingName: nil)
        task.didReceive(response)
        task.didReceive(bytes)
        task.didFinish()
    }

    private func mimeType(for key: String) -> String {
        if key.hasSuffix(".html") { return "text/html" }
        if key.hasSuffix(".js") { return "text/javascript" }
        if key.hasSuffix(".css") { return "text/css" }
        if key.hasSuffix(".wasm") { return "application/wasm" }
        return "application/octet-stream"
    }
}
