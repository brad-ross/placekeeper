import AppKit
import Foundation

@MainActor
final class PlacekeeperAppDelegate: NSObject, NSApplicationDelegate {
    private var controllers: [PlacekeeperWindowController] = []
    private let helperSupervisor = ReviewHelperSupervisor()
    private var lifecycleLane = AppLifecycleLane()

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = lifecycleLane.register(
            processID: ProcessInfo.processInfo.processIdentifier,
            startIdentity: "start_" + UUID().uuidString,
            buildIdentity: Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "build_development"
        )
        guard let source = CommandLine.arguments.dropFirst().first.map(URL.init(fileURLWithPath:)) else {
            presentCatastrophicFallback(documentName: "No PDF selected")
            return
        }
        open(source)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    private func open(_ source: URL) {
        let packagedRoot = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_WEB_ROOT"]
            .map(URL.init(fileURLWithPath:))
            ?? Bundle.main.resourceURL?.appendingPathComponent("MacWeb")
        guard let packagedRoot, let bytes = try? Data(contentsOf: source), bytes.starts(with: Data("%PDF".utf8)) else {
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
        let windowID = "window_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let attemptID = "attempt_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        guard let helperPath = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_REVIEW_HELPER"],
              let helper = SupervisedReviewHelper(
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
            presentCatastrophicFallback(documentName: source.lastPathComponent)
            return
        }
        let controller = PlacekeeperWindowController(
            windowID: windowID,
            documentURL: source,
            packagedRoot: packagedRoot,
            resourceID: "resource_" + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
            generation: 1,
            resourceBytes: bytes,
            onClose: { [weak self] closedWindowID in
                guard let self else { return }
                self.helperSupervisor.close(windowID: closedWindowID)
                _ = self.lifecycleLane.noteWindow(closedWindowID, active: false)
                self.controllers.removeAll { $0.windowID == closedWindowID }
            }
        )
        controllers.append(controller)
        _ = lifecycleLane.noteWindow(windowID, active: true)
        controller.start()
    }

    private func presentCatastrophicFallback(documentName: String) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = documentName
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
