import AppKit
import Foundation

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
        let offerID: String
        let offerExpiresAt: String
    }

    private var controllers: [PlacekeeperWindowController] = []
    private var recoveryAttempts: [String: RecoveryAttempt] = [:]
    private var fallbackWindows: [NSWindow] = []
    private let helperSupervisor = ReviewHelperSupervisor()
    private let appInstanceID = "app_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private var lifecycleControl: AppLifecycleControlClient?
    private var lifecycleRegistered = false
    private var terminating = false
    private var helperCommand: HelperLaunchCommand?
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"

    func applicationDidFinishLaunching(_ notification: Notification) {
        diagnostic("application-did-finish-launching")
        let source = CommandLine.arguments.dropFirst().first.map(URL.init(fileURLWithPath:))
        guard let helperCommand = resolveHelperCommand(),
              let lifecycle = AppLifecycleControlClient(
                appInstanceID: appInstanceID,
                executable: helperCommand.executable,
                argumentPrefix: helperCommand.argumentPrefix,
                baseEnvironment: ProcessInfo.processInfo.environment,
                onExit: { [weak self] in Task { @MainActor in self?.lifecycleDidFail() } }
              ) else {
            diagnostic("lifecycle-helper-launch-failed")
            presentCatastrophicFallback(documentName: source?.lastPathComponent ?? "No PDF selected")
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
                    self.presentCatastrophicFallback(documentName: source?.lastPathComponent ?? "No PDF selected")
                    return
                }
                self.lifecycleRegistered = true
                self.diagnostic("lifecycle-registered")
                guard let source else {
                    self.presentCatastrophicFallback(documentName: "No PDF selected")
                    return
                }
                self.open(source)
            }
        }) else {
            diagnostic("lifecycle-registration-write-failed")
            lifecycle.terminate()
            lifecycleControl = nil
            presentCatastrophicFallback(documentName: source?.lastPathComponent ?? "No PDF selected")
            return
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
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

    private func open(_ source: URL) {
        diagnostic("window-bootstrap-requested")
        guard sendActivity(activeWindows: controllers.count + 1, bootstrappingWindows: 1, completion: { [weak self] accepted in
            Task { @MainActor in
                guard let self else { return }
                if accepted { self.beginOpen(source) }
                else {
                    self.diagnostic("window-bootstrap-activity-rejected")
                    self.presentCatastrophicFallback(documentName: source.lastPathComponent)
                }
            }
        }) else {
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
    }

    private func beginOpen(_ source: URL) {
        diagnostic("window-bootstrap-admitting")
        let packagedRoot = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_WEB_ROOT"]
            .map(URL.init(fileURLWithPath:))
            ?? Bundle.main.resourceURL?.appendingPathComponent("MacWeb")
        guard let packagedRoot, source.isFileURL else {
            _ = sendActivity(activeWindows: controllers.count, bootstrappingWindows: 0)
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
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
                        self?.controllers.first { $0.windowID == failedWindowID }?.helperDidFail()
                        self?.helperSupervisor.helperDied(windowID: failedWindowID)
                    }
                }
              ), helperSupervisor.attach(helper) else {
            _ = sendActivity(activeWindows: controllers.count, bootstrappingWindows: 0)
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
        let canonicalSource = source.standardizedFileURL.resolvingSymlinksInPath()
        guard helper.request(
            type: "admit",
            fields: ["sourcePath": canonicalSource.path],
            completion: { [weak self, weak helper] reply in
                Task { @MainActor in
                    guard let self, let helper else { return }
                    self.diagnostic("window-bootstrap-admission-received")
                    self.handleAdmission(
                        reply,
                        windowID: windowID,
                        source: source,
                        packagedRoot: packagedRoot,
                        attemptID: attemptID,
                        runtimeID: runtimeID,
                        helper: helper
                    )
                }
            }
        ) != nil else {
            helperSupervisor.close(windowID: windowID)
            _ = sendActivity(activeWindows: controllers.count, bootstrappingWindows: 0)
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
    }

    private func handleAdmission(
        _ reply: MacReviewHelperReply?,
        windowID: String,
        source: URL,
        packagedRoot: URL,
        attemptID: String,
        runtimeID: String,
        helper: SupervisedReviewHelper
    ) {
        switch reply {
        case let .admitted(admission):
            installDocumentWindow(
                windowID: windowID,
                source: source,
                packagedRoot: packagedRoot,
                attemptID: attemptID,
                runtimeID: runtimeID,
                helper: helper,
                admission: admission
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
                offerID: offerID,
                offerExpiresAt: offerExpiresAt
            )
            _ = sendActivity(activeWindows: controllers.count + recoveryAttempts.count, bootstrappingWindows: 0)
            controller.show()
        default:
            helperSupervisor.close(windowID: windowID)
            _ = sendActivity(activeWindows: controllers.count + recoveryAttempts.count, bootstrappingWindows: 0)
            presentCatastrophicFallback(documentName: source.lastPathComponent)
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
                recovery.controller.resolve()
                self.recoveryAttempts.removeValue(forKey: windowID)
                self.installDocumentWindow(
                    windowID: windowID,
                    source: recovery.source,
                    packagedRoot: recovery.packagedRoot,
                    attemptID: recovery.attemptID,
                    runtimeID: recovery.runtimeID,
                    helper: recovery.helper,
                    admission: admission
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
        _ = sendActivity(activeWindows: controllers.count + recoveryAttempts.count, bootstrappingWindows: 0)
    }

    private func installDocumentWindow(
        windowID: String,
        source: URL,
        packagedRoot: URL,
        attemptID: String,
        runtimeID: String,
        helper: SupervisedReviewHelper,
        admission: MacReviewAdmission
    ) {
        let controller = PlacekeeperWindowController(
            windowID: windowID,
            documentURL: source,
            packagedRoot: packagedRoot,
            attemptID: attemptID,
            runtimeID: runtimeID,
            helper: helper,
            admission: admission,
            onClose: { [weak self] closedWindowID in
                guard let self else { return }
                self.helperSupervisor.close(windowID: closedWindowID)
                self.controllers.removeAll { $0.windowID == closedWindowID }
                _ = self.sendActivity(
                    activeWindows: self.controllers.count + self.recoveryAttempts.count,
                    bootstrappingWindows: 0
                )
            }
        )
        controllers.append(controller)
        diagnostic("document-window-starting")
        _ = sendActivity(activeWindows: controllers.count + recoveryAttempts.count, bootstrappingWindows: 0)
        controller.start()
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

    private func presentCatastrophicFallback(documentName: String) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = documentName
        window.isReleasedWhenClosed = false
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 48, left: 48, bottom: 48, right: 48)
        let title = NSTextField(labelWithString: documentName)
        title.font = .preferredFont(forTextStyle: .title1)
        stack.addArrangedSubview(title)
        for action in CatastrophicAction.allCases {
            let button = NSButton(title: action.rawValue, target: nil, action: nil)
            button.identifier = NSUserInterfaceItemIdentifier(action.rawValue.lowercased())
            stack.addArrangedSubview(button)
        }
        window.contentView = stack
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
