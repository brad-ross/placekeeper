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
        window.backgroundColor = .windowBackgroundColor
        super.init(window: window)
        window.delegate = self

        let content = NSView()
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Protected review found")
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.lineBreakMode = .byTruncatingTail
        stack.addArrangedSubview(title)
        status.textColor = .secondaryLabelColor
        status.maximumNumberOfLines = 2
        status.lineBreakMode = .byWordWrapping
        stack.addArrangedSubview(status)

        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        let actionSpacer = NSView()
        actionSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        actions.addArrangedSubview(actionSpacer)
        for (label, decision) in [
            ("Discard Changes", "discard"),
            ("Independent Review", "fork"),
            ("Resume", "resume"),
        ] {
            let button = NSButton(title: label, target: self, action: #selector(choose(_:)))
            button.identifier = NSUserInterfaceItemIdentifier(decision)
            button.bezelStyle = .rounded
            button.controlSize = .large
            if decision == "discard" { button.hasDestructiveAction = true }
            if decision == "resume" { button.keyEquivalent = "\r" }
            buttons.append(button)
            actions.addArrangedSubview(button)
        }
        stack.addArrangedSubview(actions)
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        window.contentView = content
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
