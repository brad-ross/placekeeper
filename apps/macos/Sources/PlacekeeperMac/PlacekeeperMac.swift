import AppKit
import Foundation
import UniformTypeIdentifiers

@MainActor
final class PlacekeeperAppDelegate: NSObject, NSApplicationDelegate {
    private struct HelperLaunchCommand {
        let executable: URL
        let argumentPrefix: [String]
    }

    private struct RecoveryAttempt {
        let controller: RecoveryViewController
        let source: URL
        let packagedRoot: URL
        let attemptID: String
        let runtimeID: String
        let helper: SupervisedReviewHelper
        let packagedAssets: PackagedReviewAssets?
        let offerID: String
        let offerExpiresAt: String
    }

    private var controllers: [PlacekeeperWindowController] = []
    private var recoveryAttempts: [String: RecoveryAttempt] = [:]
    private var fallbackWindows: [NSWindow] = []
    private var launchCoordinator = LaunchCoordinator()
    private var windowRegistry = DocumentWindowRegistry()
    private let restorationStore = WindowRestorationStore()
    private var restoredFrames: [String: NSRect] = [:]
    private let helperSupervisor = ReviewHelperSupervisor()
    private let appInstanceID = "app_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private var lifecycleControl: AppLifecycleControlClient?
    private var lifecycleRegistered = false
    private var terminating = false
    private var helperCommand: HelperLaunchCommand?
    private var openPanelPresented = false
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"
    private lazy var menuCoordinator = MenuCoordinator(
        activeWindow: { [weak self] in self?.activeDocumentWindow },
        openDocument: { [weak self] in self?.showOpenPanel() },
        openURL: { [weak self] url in self?.enqueueLaunchURLs([url]) }
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        diagnostic("application-did-finish-launching")
        NSWindow.allowsAutomaticWindowTabbing = false
        menuCoordinator.install()
        enqueueLaunchURLs(CommandLine.arguments.dropFirst().map { URL(fileURLWithPath: $0) })
        if launchCoordinator.pending.isEmpty {
            let restored = restorationStore.load()
            for record in restored {
                restoredFrames[record.sourceURL.standardizedFileURL.path] = NSRectFromString(record.frame)
            }
            enqueueLaunchURLs(restored.map(\.sourceURL))
        }
        let pendingSource = launchCoordinator.pending.first?.sourceURL
        let pendingDocumentName = pendingSource?.lastPathComponent ?? "Placekeeper"
        guard let helperCommand = resolveHelperCommand(),
              let lifecycle = AppLifecycleControlClient(
                appInstanceID: appInstanceID,
                executable: helperCommand.executable,
                argumentPrefix: helperCommand.argumentPrefix,
                baseEnvironment: ProcessInfo.processInfo.environment,
                onExit: { [weak self] in Task { @MainActor in self?.lifecycleDidFail() } }
              ) else {
            diagnostic("lifecycle-helper-launch-failed")
            presentCatastrophicFallback(documentName: pendingDocumentName, sourceURL: pendingSource)
            return
        }
        self.helperCommand = helperCommand
        lifecycleControl = lifecycle
        let rawBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "development"
        let safeBuild = rawBuild.replacingOccurrences(
            of: "[^A-Za-z0-9_-]", with: "_", options: .regularExpression
        )
        let buildIdentity = "build_" + (safeBuild.isEmpty ? "development" : String(safeBuild.prefix(100)))
        let startIdentity = "start_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        guard lifecycle.request(type: "register-app", fields: [
            "processId": Int(ProcessInfo.processInfo.processIdentifier),
            "startIdentity": startIdentity,
            "buildIdentity": buildIdentity,
        ], completion: { [weak self] reply in
            Task { @MainActor in
                guard let self else { return }
                guard reply == .acknowledged else {
                    self.diagnostic("lifecycle-registration-failed")
                    self.presentCatastrophicFallback(documentName: pendingDocumentName, sourceURL: pendingSource)
                    return
                }
                self.lifecycleRegistered = true
                self.diagnostic("lifecycle-registered")
                let launches = self.launchCoordinator.markReady()
                launches.forEach(self.open)
                if launches.isEmpty, self.launchCoordinator.pending.isEmpty { self.showOpenPanel() }
            }
        }) else {
            diagnostic("lifecycle-registration-write-failed")
            lifecycle.terminate()
            lifecycleControl = nil
            presentCatastrophicFallback(documentName: pendingDocumentName, sourceURL: pendingSource)
            return
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        enqueueLaunchURLs(urls)
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        enqueueLaunchURLs(filenames.map { URL(fileURLWithPath: $0) })
        sender.reply(toOpenOrPrint: .success)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if let key = sender.keyWindow ?? controllers.last?.window ?? recoveryAttempts.values.first?.controller.window {
            sender.activate(ignoringOtherApps: true)
            key.makeKeyAndOrderFront(nil)
        } else {
            showOpenPanel()
        }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        persistRestorableWindows()
        guard lifecycleRegistered, let lifecycleControl else {
            self.lifecycleControl?.terminate()
            return
        }
        if !lifecycleControl.request(type: "detach", fields: ["reason": "controlled-exit"], completion: { _ in
            lifecycleControl.terminate()
        }) {
            lifecycleControl.terminate()
        }
    }

    private func enqueueLaunchURLs(_ urls: [URL]) {
        let intents = urls.compactMap(NativeOpenIntent.parse)
        launchCoordinator.enqueue(intents).forEach(open)
    }

    private func open(_ intent: NativeOpenIntent) {
        diagnostic("window-bootstrap-requested")
        guard sendActivity(
            activeWindows: reportedActiveWindowCount,
            bootstrappingWindows: launchCoordinator.inFlightCount,
            completion: { [weak self] accepted in
            Task { @MainActor in
                guard let self else { return }
                if accepted { self.beginOpen(intent) }
                else {
                    self.diagnostic("window-bootstrap-activity-rejected")
                    self.finishLaunch(intent)
                    self.presentCatastrophicFallback(documentName: intent.sourceURL.lastPathComponent, sourceURL: intent.sourceURL)
                }
            }
        }) else {
            finishLaunch(intent)
            presentCatastrophicFallback(documentName: intent.sourceURL.lastPathComponent, sourceURL: intent.sourceURL)
            return
        }
    }

    private func beginOpen(_ intent: NativeOpenIntent) {
        diagnostic("window-bootstrap-admitting")
        let source = intent.sourceURL
        if case let .placekeeperLink(link) = intent.kind, !confirmPlacekeeperLink(link, source: source) {
            finishLaunch(intent)
            return
        }
        let packagedRoot = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_WEB_ROOT"]
            .map(URL.init(fileURLWithPath:))
            ?? Bundle.main.resourceURL?.appendingPathComponent("MacWeb")
        guard let packagedRoot, source.isFileURL else {
            finishLaunch(intent)
            presentCatastrophicFallback(documentName: source.lastPathComponent, sourceURL: source)
            return
        }
        let packagedAssets = Task { await PackagedReviewAssets.load(from: packagedRoot) }
        let windowID = "window_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let attemptID = "attempt_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let helperID = "helper_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let runtimeID = "runtime_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        guard let helperCommand,
              let helper = SupervisedReviewHelper(
                appInstanceID: appInstanceID,
                helperID: helperID,
                windowID: windowID,
                attemptID: attemptID,
                executable: helperCommand.executable,
                argumentPrefix: helperCommand.argumentPrefix,
                baseEnvironment: ProcessInfo.processInfo.environment,
                onExit: { [weak self] failedWindowID in
                    Task { @MainActor in
                        self?.helperDidExit(windowID: failedWindowID)
                    }
                }
              ), helperSupervisor.attach(helper) else {
            finishLaunch(intent)
            presentCatastrophicFallback(documentName: source.lastPathComponent, sourceURL: source)
            return
        }
        let canonicalSource = source.standardizedFileURL.resolvingSymlinksInPath()
        let request: (type: String, fields: [String: Any])
        switch intent.kind {
        case .document:
            request = ("admit", ["sourcePath": canonicalSource.path])
        case let .placekeeperLink(link):
            request = ("admit-link", ["link": link, "confirmed": true])
        }
        guard helper.request(
            type: request.type,
            fields: request.fields,
            completion: { [weak self, weak helper] reply in
                Task { @MainActor in
                    guard let self, let helper else { return }
                    let assets = await packagedAssets.value
                    self.diagnostic("window-bootstrap-admission-received")
                    self.handleAdmission(
                        reply,
                        windowID: windowID,
                        intent: intent,
                        packagedRoot: packagedRoot,
                        attemptID: attemptID,
                        runtimeID: runtimeID,
                        helper: helper,
                        packagedAssets: assets
                    )
                }
            }
        ) != nil else {
            helperSupervisor.close(windowID: windowID)
            finishLaunch(intent)
            presentCatastrophicFallback(documentName: source.lastPathComponent, sourceURL: source)
            return
        }
    }

    private func handleAdmission(
        _ reply: MacReviewHelperReply?,
        windowID: String,
        intent: NativeOpenIntent,
        packagedRoot: URL,
        attemptID: String,
        runtimeID: String,
        helper: SupervisedReviewHelper,
        packagedAssets: PackagedReviewAssets?
    ) {
        let source = intent.sourceURL
        finishLaunch(intent)
        switch reply {
        case let .admitted(admission):
            guard let packagedAssets else {
                helperSupervisor.close(windowID: windowID)
                updateActivity()
                presentCatastrophicFallback(documentName: source.lastPathComponent, sourceURL: source)
                return
            }
            NSDocumentController.shared.noteNewRecentDocumentURL(source)
            if let existingWindowID = windowRegistry.matchingWindow(
                canonicalReviewID: admission.projection.sessionID
            ), let existing = controllers.first(where: { $0.windowID == existingWindowID }) {
                releaseCandidate(helper, windowID: windowID)
                windowRegistry.noteKey(windowID: existingWindowID)
                existing.focus()
                return
            }
            installDocumentWindow(
                windowID: windowID,
                source: source,
                packagedRoot: packagedRoot,
                attemptID: attemptID,
                runtimeID: runtimeID,
                helper: helper,
                admission: admission,
                packagedAssets: packagedAssets
            )
        case let .recoveryOffered(offerID, offerExpiresAt):
            let controller = RecoveryViewController(
                windowID: windowID,
                documentName: source.lastPathComponent,
                onDecision: { [weak self] decision in self?.recover(windowID: windowID, decision: decision) },
                onClose: { [weak self] in self?.closeRecovery(windowID: windowID) }
            )
            recoveryAttempts[windowID] = .init(
                controller: controller,
                source: source,
                packagedRoot: packagedRoot,
                attemptID: attemptID,
                runtimeID: runtimeID,
                helper: helper,
                packagedAssets: packagedAssets,
                offerID: offerID,
                offerExpiresAt: offerExpiresAt
            )
            updateActivity()
            controller.show()
        default:
            helperSupervisor.close(windowID: windowID)
            updateActivity()
            presentCatastrophicFallback(documentName: source.lastPathComponent, sourceURL: source)
        }
    }

    private func recover(windowID: String, decision: String) {
        guard let recovery = recoveryAttempts[windowID] else { return }
        let fields: [String: Any] = [
            "decision": decision,
            "offer": ["id": recovery.offerID, "expiresAt": recovery.offerExpiresAt],
            "idempotencyKey": "operation_" + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
        ]
        guard recovery.helper.request(type: "recover", fields: fields, completion: { [weak self] reply in
            Task { @MainActor in
                guard let self, let recovery = self.recoveryAttempts[windowID] else { return }
                guard case let .admitted(admission)? = reply else {
                    recovery.controller.failDecision()
                    return
                }
                guard let packagedAssets = recovery.packagedAssets else {
                    recovery.controller.resolve()
                    self.recoveryAttempts.removeValue(forKey: windowID)
                    self.helperSupervisor.close(windowID: windowID)
                    self.updateActivity()
                    self.presentCatastrophicFallback(
                        documentName: recovery.source.lastPathComponent,
                        sourceURL: recovery.source
                    )
                    return
                }
                recovery.controller.resolve()
                self.recoveryAttempts.removeValue(forKey: windowID)
                self.installDocumentWindow(
                    windowID: windowID,
                    source: recovery.source,
                    packagedRoot: recovery.packagedRoot,
                    attemptID: recovery.attemptID,
                    runtimeID: recovery.runtimeID,
                    helper: recovery.helper,
                    admission: admission,
                    packagedAssets: packagedAssets
                )
            }
        }) != nil else {
            recovery.controller.failDecision()
            return
        }
    }

    private func closeRecovery(windowID: String) {
        guard recoveryAttempts.removeValue(forKey: windowID) != nil else { return }
        helperSupervisor.close(windowID: windowID)
        updateActivity()
    }

    private func installDocumentWindow(
        windowID: String,
        source: URL,
        packagedRoot: URL,
        attemptID: String,
        runtimeID: String,
        helper: SupervisedReviewHelper,
        admission: MacReviewAdmission,
        packagedAssets: PackagedReviewAssets
    ) {
        let controller = PlacekeeperWindowController(
            windowID: windowID,
            documentURL: source,
            packagedRoot: packagedRoot,
            attemptID: attemptID,
            runtimeID: runtimeID,
            helper: helper,
            admission: admission,
            packagedAssets: packagedAssets,
            restoredFrame: restoredFrames.removeValue(forKey: source.standardizedFileURL.path),
            onBecameKey: { [weak self] keyWindowID in self?.windowRegistry.noteKey(windowID: keyWindowID) },
            onCommandSnapshot: { [weak self] _ in self?.menuCoordinator.refresh() },
            onRetry: { [weak self] failedWindowID in self?.retryDocumentWindow(windowID: failedWindowID) },
            onDiagnostics: { [weak self] in self?.showDiagnostics() },
            onClose: { [weak self] closedWindowID in
                guard let self else { return }
                self.helperSupervisor.close(windowID: closedWindowID)
                self.windowRegistry.remove(windowID: closedWindowID)
                self.controllers.removeAll { $0.windowID == closedWindowID }
                self.persistRestorableWindows()
                _ = self.sendActivity(
                    activeWindows: self.reportedActiveWindowCount,
                    bootstrappingWindows: self.launchCoordinator.inFlightCount
                )
            }
        )
        guard windowRegistry.register(
            windowID: windowID,
            canonicalReviewID: admission.projection.sessionID,
            documentDigest: admission.digest
        ) else {
            helperSupervisor.close(windowID: windowID)
            presentCatastrophicFallback(documentName: source.lastPathComponent, sourceURL: source)
            return
        }
        controllers.append(controller)
        persistRestorableWindows()
        diagnostic("document-window-starting")
        updateActivity()
        controller.start()
    }

    private func finishLaunch(_ intent: NativeOpenIntent) {
        let next = launchCoordinator.finish(intent)
        _ = sendActivity(
            activeWindows: reportedActiveWindowCount,
            bootstrappingWindows: launchCoordinator.inFlightCount
        )
        next.forEach(open)
    }

    private func releaseCandidate(_ helper: SupervisedReviewHelper, windowID: String) {
        let sent = helper.request(type: "release", fields: [:]) { [weak self] _ in
            Task { @MainActor in self?.helperSupervisor.close(windowID: windowID) }
        }
        if sent == nil { helperSupervisor.close(windowID: windowID) }
    }

    private var reportedActiveWindowCount: Int {
        max(
            controllers.count + recoveryAttempts.count + launchCoordinator.inFlightCount,
            helperSupervisor.activeWindowIDs.count
        )
    }

    private var activeDocumentWindow: PlacekeeperWindowController? {
        controllers.first(where: { $0.window?.isKeyWindow == true })
    }

    private func updateActivity() {
        _ = sendActivity(
            activeWindows: reportedActiveWindowCount,
            bootstrappingWindows: launchCoordinator.inFlightCount
        )
    }

    private func persistRestorableWindows() {
        restorationStore.save(controllers.compactMap(\.restorationRecord))
    }

    private func helperDidExit(windowID: String) {
        controllers.first { $0.windowID == windowID }?.helperDidFail()
        helperSupervisor.helperDied(windowID: windowID)
        updateActivity()
    }

    private func retryDocumentWindow(windowID: String) {
        guard let controller = controllers.first(where: { $0.windowID == windowID }) else { return }
        let source = controller.documentURL
        controller.window?.performClose(nil)
        enqueueLaunchURLs([source])
    }

    private func showDiagnostics() {
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "development"
        let safeBuild = build.replacingOccurrences(
            of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression
        )
        let alert = NSAlert()
        alert.messageText = "Placekeeper Diagnostics"
        alert.informativeText = "Schema: 1\nShell: native-recovery\nBuild: \(String(safeBuild.prefix(100)))"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func confirmPlacekeeperLink(_ _: String, source: URL) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Open this Placekeeper link?"
        alert.informativeText = "The link requests \(source.lastPathComponent). Placekeeper will verify the PDF before opening it."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.keyEquivalent = "\r"
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func showOpenPanel() {
        guard lifecycleRegistered, !openPanelPresented else { return }
        openPanelPresented = true
        let panel = NSOpenPanel()
        panel.title = "Open a PDF in Placekeeper"
        panel.prompt = "Open"
        panel.allowedContentTypes = [.pdf]
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.begin { [weak self] response in
            Task { @MainActor in
                guard let self else { return }
                self.openPanelPresented = false
                if response == .OK { self.enqueueLaunchURLs(panel.urls) }
            }
        }
    }

    @discardableResult
    private func sendActivity(
        activeWindows: Int,
        bootstrappingWindows: Int,
        completion: ((Bool) -> Void)? = nil
    ) -> Bool {
        guard lifecycleRegistered, let lifecycleControl else { completion?(false); return false }
        return lifecycleControl.request(type: "activity", fields: [
            "activeWindows": activeWindows,
            "bootstrappingWindows": bootstrappingWindows,
        ], completion: { reply in completion?(reply == .acknowledged) })
    }

    private func lifecycleDidFail() {
        guard lifecycleRegistered, !terminating else { return }
        lifecycleRegistered = false
        diagnostic("lifecycle-helper-failed")
        for controller in controllers {
            controller.helperDidFail()
            helperSupervisor.close(windowID: controller.windowID)
        }
        for (windowID, recovery) in recoveryAttempts {
            recovery.controller.failDecision()
            helperSupervisor.close(windowID: windowID)
        }
    }

    private func resolveHelperCommand() -> HelperLaunchCommand? {
        let environment = ProcessInfo.processInfo.environment
        if let helperPath = environment["PLACEKEEPER_MAC_REVIEW_HELPER"], helperPath.hasPrefix("/") {
            return .init(executable: URL(fileURLWithPath: helperPath), argumentPrefix: [])
        }
        if let nodePath = environment["PLACEKEEPER_MAC_NODE"], nodePath.hasPrefix("/"),
           let servicePath = environment["PLACEKEEPER_MAC_SERVICE_ENTRY"], servicePath.hasPrefix("/") {
            return .init(
                executable: URL(fileURLWithPath: nodePath),
                argumentPrefix: [servicePath]
            )
        }
        guard let resources = Bundle.main.resourceURL else { return nil }
        let node = resources.appendingPathComponent("node/bin/node")
        let service = resources.appendingPathComponent("service/main.js")
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: service.path) else { return nil }
        return .init(executable: node, argumentPrefix: [service.path])
    }

    private func diagnostic(_ message: String) {
        guard diagnosticsEnabled,
              let bytes = "[PlacekeeperMac] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(bytes)
    }

    private func presentCatastrophicFallback(documentName: String, sourceURL: URL? = nil) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = documentName
        window.isReleasedWhenClosed = false
        window.contentViewController = CatastrophicFallbackViewController(
            documentName: documentName,
            retryEnabled: sourceURL != nil && lifecycleRegistered,
            onRetry: { [weak self] in
                guard let sourceURL else { return }
                self?.enqueueLaunchURLs([sourceURL])
            },
            onDiagnostics: { [weak self] in self?.showDiagnostics() },
            onClose: { [weak self] closingWindow in
                closingWindow?.close()
                self?.fallbackWindows.removeAll { $0 === closingWindow }
            }
        )
        fallbackWindows.append(window)
        window.center()
        window.makeKeyAndOrderFront(nil)
    }
}

@main
@MainActor
struct PlacekeeperMac {
    static func main() {
        let application = NSApplication.shared
        let delegate = PlacekeeperAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.activate(ignoringOtherApps: true)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}
