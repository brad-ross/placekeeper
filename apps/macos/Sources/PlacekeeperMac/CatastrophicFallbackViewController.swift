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

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 14
        stack.edgeInsets = NSEdgeInsets(top: 48, left: 48, bottom: 48, right: 48)
        let title = NSTextField(labelWithString: documentName)
        title.font = .preferredFont(forTextStyle: .title1)
        stack.addArrangedSubview(title)
        let explanation = NSTextField(labelWithString: "Placekeeper could not display this review.")
        explanation.textColor = .secondaryLabelColor
        stack.addArrangedSubview(explanation)
        for (button, action, identifier) in [
            (retryButton, #selector(retry(_:)), CatastrophicAction.retry.rawValue.lowercased()),
            (NSButton(), #selector(diagnostics(_:)), CatastrophicAction.diagnostics.rawValue.lowercased()),
            (NSButton(), #selector(closeWindow(_:)), CatastrophicAction.close.rawValue.lowercased()),
        ] {
            if button !== retryButton { button.title = identifier.capitalized }
            button.target = self
            button.action = action
            button.identifier = NSUserInterfaceItemIdentifier(identifier)
            stack.addArrangedSubview(button)
        }
        view = stack
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
