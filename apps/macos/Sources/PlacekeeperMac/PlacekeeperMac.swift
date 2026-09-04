import AppKit
import Foundation

@MainActor
final class PlacekeeperAppDelegate: NSObject, NSApplicationDelegate {
    private var controllers: [PlacekeeperWindowController] = []
    private var fallbackWindows: [NSWindow] = []
    private let helperSupervisor = ReviewHelperSupervisor()
    private let appInstanceID = "app_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    private var lifecycleControl: AppLifecycleControlClient?
    private var lifecycleRegistered = false
    private var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let source = CommandLine.arguments.dropFirst().first.map(URL.init(fileURLWithPath:))
        guard let helperPath = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_REVIEW_HELPER"],
              let lifecycle = AppLifecycleControlClient(
                appInstanceID: appInstanceID,
                executable: URL(fileURLWithPath: helperPath),
                baseEnvironment: ProcessInfo.processInfo.environment,
                onExit: { [weak self] in Task { @MainActor in self?.lifecycleDidFail() } }
              ) else {
            presentCatastrophicFallback(documentName: source?.lastPathComponent ?? "No PDF selected")
            return
        }
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
                    self.presentCatastrophicFallback(documentName: source?.lastPathComponent ?? "No PDF selected")
                    return
                }
                self.lifecycleRegistered = true
                guard let source else {
                    self.presentCatastrophicFallback(documentName: "No PDF selected")
                    return
                }
                self.open(source)
            }
        }) else {
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
        guard sendActivity(activeWindows: controllers.count + 1, bootstrappingWindows: 1, completion: { [weak self] accepted in
            Task { @MainActor in
                guard let self else { return }
                if accepted { self.beginOpen(source) }
                else { self.presentCatastrophicFallback(documentName: source.lastPathComponent) }
            }
        }) else {
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
    }

    private func beginOpen(_ source: URL) {
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
        guard let helperPath = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_REVIEW_HELPER"],
              let helper = SupervisedReviewHelper(
                appInstanceID: appInstanceID,
                helperID: helperID,
                windowID: windowID,
                attemptID: attemptID,
                executable: URL(fileURLWithPath: helperPath),
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
                    guard case let .admitted(admission)? = reply else {
                        self.helperSupervisor.close(windowID: windowID)
                        _ = self.sendActivity(activeWindows: self.controllers.count, bootstrappingWindows: 0)
                        self.presentCatastrophicFallback(documentName: source.lastPathComponent)
                        return
                    }
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
                            _ = self.sendActivity(activeWindows: self.controllers.count, bootstrappingWindows: 0)
                        }
                    )
                    self.controllers.append(controller)
                    _ = self.sendActivity(activeWindows: self.controllers.count, bootstrappingWindows: 0)
                    controller.start()
                }
            }
        ) != nil else {
            helperSupervisor.close(windowID: windowID)
            _ = sendActivity(activeWindows: controllers.count, bootstrappingWindows: 0)
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
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
        for controller in controllers {
            controller.helperDidFail()
            helperSupervisor.close(windowID: controller.windowID)
        }
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
