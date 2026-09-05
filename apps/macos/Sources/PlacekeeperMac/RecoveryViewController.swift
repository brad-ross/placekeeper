import AppKit

@MainActor
final class RecoveryViewController: NSWindowController, NSWindowDelegate {
    let windowID: String
    private let onDecision: (String) -> Void
    private let onClose: () -> Void
    private var resolved = false
    private var buttons: [NSButton] = []
    private let status = NSTextField(labelWithString: "Choose how to continue this protected review.")

    init(windowID: String, documentName: String, onDecision: @escaping (String) -> Void, onClose: @escaping () -> Void) {
        self.windowID = windowID
        self.onDecision = onDecision
        self.onClose = onClose
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 380),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = documentName
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 16
        stack.edgeInsets = NSEdgeInsets(top: 52, left: 52, bottom: 52, right: 52)
        let title = NSTextField(labelWithString: "Protected review found")
        title.font = .preferredFont(forTextStyle: .title1)
        stack.addArrangedSubview(title)
        status.alignment = .center
        stack.addArrangedSubview(status)

        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.spacing = 10
        for (label, decision) in [
            ("Resume", "resume"),
            ("Discard Changes", "discard"),
            ("Independent Review", "fork"),
        ] {
            let button = NSButton(title: label, target: self, action: #selector(choose(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(decision)
            buttons.append(button)
            actions.addArrangedSubview(button)
        }
        stack.addArrangedSubview(actions)
        window.contentView = stack
        window.center()
    }

    required init?(coder: NSCoder) { nil }

    func show() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        NSAccessibility.post(element: status, notification: .announcementRequested, userInfo: [
            .announcement: "Protected review found. Choose Resume, Discard Changes, or Independent Review.",
            .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
    }

    func failDecision() {
        status.stringValue = "That recovery choice could not be completed. Close this window and try again."
        buttons.forEach { $0.isEnabled = false }
        NSAccessibility.post(element: status, notification: .announcementRequested, userInfo: [
            .announcement: status.stringValue,
            .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
    }

    func resolve() {
        resolved = true
        close()
    }

    func windowWillClose(_ notification: Notification) {
        if !resolved { onClose() }
    }

    @objc private func choose(_ sender: NSButton) {
        guard let decision = sender.identifier?.rawValue else { return }
        buttons.forEach { $0.isEnabled = false }
        status.stringValue = "Preparing review…"
        onDecision(decision)
    }
}
