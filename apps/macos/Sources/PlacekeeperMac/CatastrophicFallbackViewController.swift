import AppKit

@MainActor
final class CatastrophicFallbackViewController: NSViewController {
    private let onRetry: () -> Void
    private let onDiagnostics: () -> Void
    private let onClose: (NSWindow?) -> Void
    private let retryButton: NSButton

    init(
        documentName: String,
        retryEnabled: Bool = true,
        onRetry: @escaping () -> Void,
        onDiagnostics: @escaping () -> Void,
        onClose: @escaping (NSWindow?) -> Void
    ) {
        self.onRetry = onRetry
        self.onDiagnostics = onDiagnostics
        self.onClose = onClose
        retryButton = NSButton(title: CatastrophicAction.retry.rawValue, target: nil, action: nil)
        super.init(nibName: nil, bundle: nil)
        retryButton.isEnabled = retryEnabled
        retryButton.bezelStyle = .rounded
        retryButton.controlSize = .large
        retryButton.keyEquivalent = "\r"

        let content = NSView()
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: documentName)
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.lineBreakMode = .byTruncatingMiddle
        stack.addArrangedSubview(title)
        let explanation = NSTextField(labelWithString: "Placekeeper could not display this review.")
        explanation.textColor = .secondaryLabelColor
        stack.addArrangedSubview(explanation)
        let actions = NSStackView()
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8
        let actionSpacer = NSView()
        actionSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        actions.addArrangedSubview(actionSpacer)
        for (button, action, identifier) in [
            (NSButton(), #selector(closeWindow(_:)), CatastrophicAction.close.rawValue.lowercased()),
            (NSButton(), #selector(diagnostics(_:)), CatastrophicAction.diagnostics.rawValue.lowercased()),
            (retryButton, #selector(retry(_:)), CatastrophicAction.retry.rawValue.lowercased()),
        ] {
            if button !== retryButton { button.title = identifier.capitalized }
            button.target = self
            button.action = action
            button.identifier = NSUserInterfaceItemIdentifier(identifier)
            button.bezelStyle = .rounded
            button.controlSize = .large
            actions.addArrangedSubview(button)
        }
        stack.addArrangedSubview(actions)
        content.addSubview(stack)
        let readableWidth = stack.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -56)
        readableWidth.priority = .defaultHigh
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
            readableWidth,
            title.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            actions.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        view = content
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidAppear() {
        super.viewDidAppear()
        if retryButton.isEnabled { view.window?.makeFirstResponder(retryButton) }
        NSAccessibility.post(element: view, notification: .announcementRequested, userInfo: [
            .announcement: "Placekeeper could not display this review. Retry, Diagnostics, and Close are available.",
            .priority: NSAccessibilityPriorityLevel.high.rawValue,
        ])
    }

    @objc private func retry(_ sender: Any?) { onRetry() }
    @objc private func diagnostics(_ sender: Any?) { onDiagnostics() }
    @objc private func closeWindow(_ sender: Any?) { onClose(view.window) }
}
