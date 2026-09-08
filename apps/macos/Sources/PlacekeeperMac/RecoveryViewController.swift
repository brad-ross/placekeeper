import AppKit
@preconcurrency import WebKit

struct RecoveryDecisionGate {
    private(set) var settled = false

    mutating func accept(_ body: Any, isMainFrame: Bool, source: URL?, expectedSource: URL) -> String? {
        guard !settled, isMainFrame, source == expectedSource,
              let message = body as? [String: Any], Set(message.keys) == ["decision"],
              let decision = message["decision"] as? String,
              ["resume", "discard", "fork"].contains(decision) else { return nil }
        settled = true
        return decision
    }

    mutating func fail() { settled = true }
}

@MainActor
private final class RecoveryContentView: NSView {
    override var isFlipped: Bool { true }
}

@MainActor
private final class RecoveryWindow: NSWindow {
    // Keep this transparent gutter in sync with macos-recovery.css.
    static let shadowInset: CGFloat = 24
    private var controls: [NSWindow.ButtonType: NSButton] = [:]

    func installControls(in view: NSView) {
        let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for (index, type) in types.enumerated() {
            guard let button = NSWindow.standardWindowButton(type, for: [.titled, .closable, .miniaturizable]) else { continue }
            let size = button.frame.size
            button.target = self
            switch type {
            case .closeButton: button.action = #selector(performClose(_:))
            case .miniaturizeButton: button.action = #selector(miniaturize(_:))
            default: button.action = #selector(zoom(_:)); button.isEnabled = false
            }
            controls[type] = button
            button.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(button)
            NSLayoutConstraint.activate([
                button.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: Self.shadowInset + 23 + CGFloat(index) * 20),
                button.centerYAnchor.constraint(equalTo: view.topAnchor, constant: Self.shadowInset + 30),
                button.widthAnchor.constraint(equalToConstant: size.width),
                button.heightAnchor.constraint(equalToConstant: size.height),
            ])
        }
    }

    override func standardWindowButton(_ type: NSWindow.ButtonType) -> NSButton? {
        controls[type] ?? super.standardWindowButton(type)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    override func performClose(_ sender: Any?) { close() }
    override func cancelOperation(_ sender: Any?) { close() }
    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        // Borderless windows otherwise disable the standard Close command.
        if menuItem.action == #selector(performClose(_:)) { return true }
        return super.validateMenuItem(menuItem)
    }
}

@MainActor
final class RecoveryViewController: NSWindowController, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    let windowID: String
    private let onDecision: (String) -> Void
    private let onClose: () -> Void
    private let onUnavailable: () -> Void
    private let webView: WKWebView
    private let recoveryURL: URL
    private var gate = RecoveryDecisionGate()
    private var resolved = false
    private var failed = false
    private var loaded = false
    private var shouldShow = false
    private var loadTimeout: Task<Void, Never>?

    init(windowID: String, documentName: String, packagedRoot: URL,
         onDecision: @escaping (String) -> Void, onClose: @escaping () -> Void,
         onUnavailable: @escaping () -> Void) {
        self.windowID = windowID
        self.onDecision = onDecision
        self.onClose = onClose
        self.onUnavailable = onUnavailable
        recoveryURL = URL(string: "placekeeper-recovery://bundle/recovery.html")!
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(RecoverySchemeHandler(root: packagedRoot), forURLScheme: "placekeeper-recovery")
        webView = WKWebView(frame: .zero, configuration: configuration)
        let window = RecoveryWindow(
            contentRect: NSRect(x: 0, y: 0, width: 414 + 2 * RecoveryWindow.shadowInset, height: 228),
            styleMask: [.borderless, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = documentName
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = false
        window.isMovableByWindowBackground = true
        webView.setValue(false, forKey: "drawsBackground")
        super.init(window: window)
        window.delegate = self
        let content = RecoveryContentView(frame: window.contentLayoutRect)
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        window.contentView = content
        window.installControls(in: content)
        window.center()
        webView.navigationDelegate = self
        configuration.userContentController.add(self, name: "placekeeperRecovery")
        loadTimeout = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            guard let self, !self.loaded, !self.resolved else { return }
            self.unavailable()
        }
        webView.load(URLRequest(url: recoveryURL))
    }

    required init?(coder: NSCoder) { nil }

    func show() {
        shouldShow = true
        guard loaded, !resolved else { return }
        NSApplication.shared.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func failDecision() {
        failed = true
        gate.fail()
        if loaded {
            webView.evaluateJavaScript("window.dispatchEvent(new Event('placekeeper-recovery-failed'))", completionHandler: nil)
        }
    }

    func resolve() {
        resolved = true
        close()
    }

    func windowWillClose(_ notification: Notification) {
        gate.fail()
        loadTimeout?.cancel()
        webView.stopLoading()
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "placekeeperRecovery")
        if !resolved { onClose() }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "placekeeperRecovery", message.frameInfo.isMainFrame,
              message.frameInfo.request.url == recoveryURL, !resolved else { return }
        if let body = message.body as? [String: Any], Set(body.keys) == ["height"],
           let height = body["height"] as? Double, height.isFinite, (120...600).contains(height),
           let window {
            let oldFrame = window.frame
            let size = NSSize(width: oldFrame.width, height: ceil(height))
            window.setFrame(NSRect(x: oldFrame.minX, y: oldFrame.midY - size.height / 2,
                                   width: size.width, height: size.height), display: true)
            return
        }
        if let body = message.body as? [String: Any], Set(body.keys) == ["ready"],
           body["ready"] as? Bool == true, !loaded {
            loaded = true
            loadTimeout?.cancel()
            if failed { failDecision() }
            if shouldShow { show() }
            return
        }
        guard let decision = gate.accept(message.body, isMainFrame: message.frameInfo.isMainFrame,
                                         source: message.frameInfo.request.url, expectedSource: recoveryURL) else { return }
        onDecision(decision)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true
            && navigationAction.request.url == recoveryURL ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { unavailable() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { unavailable() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { unavailable() }

    private func unavailable() {
        guard !resolved else { return }
        resolve()
        onUnavailable()
    }
}

private final class RecoverySchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL
    private let contentTypes = [
        "/recovery.html": "text/html",
        "/assets/recovery.js": "text/javascript",
        "/assets/recovery.css": "text/css",
    ]

    init(root: URL) { self.root = root.resolvingSymlinksInPath().standardizedFileURL }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.httpMethod == "GET", let url = task.request.url,
              url.scheme == "placekeeper-recovery", url.host == "bundle",
              let contentType = contentTypes[url.path] else {
            task.didFailWithError(URLError(.unsupportedURL)); return
        }
        let file = root.appendingPathComponent(String(url.path.dropFirst())).resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let bytes = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist)); return
        }
        task.didReceive(URLResponse(url: url, mimeType: contentType, expectedContentLength: bytes.count, textEncodingName: "utf-8"))
        task.didReceive(bytes)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
