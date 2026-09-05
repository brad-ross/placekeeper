import AppKit
import Foundation

enum MacReviewCommand: String, CaseIterable {
    case undo
    case redo
    case navigateBack = "navigate-back"
    case navigateForward = "navigate-forward"
    case find
    case openAnnotations = "open-annotations"
    case saveOptions = "save-options"
    case fitWidth = "fit-width"
}

struct MacCommandPresentation: Equatable {
    let command: MacReviewCommand
    let label: String
    let enabled: Bool
    let shortcut: String?
}

struct MacCommandSnapshot: Equatable {
    enum FocusContext: String { case review, editable, dialog }

    let revision: Int
    let focusContext: FocusContext
    let commands: [MacReviewCommand: MacCommandPresentation]

    static func parse(_ value: [String: Any]) -> MacCommandSnapshot? {
        guard Set(value.keys) == Set([
            "protocolVersion", "type", "runtimeId", "attemptId", "revision", "focusContext", "commands",
        ]), value["protocolVersion"] as? Int == 1, value["type"] as? String == "command-snapshot",
              let revision = value["revision"] as? Int, revision >= 0,
              let focus = (value["focusContext"] as? String).flatMap(FocusContext.init),
              let rawCommands = value["commands"] as? [[String: Any]],
              rawCommands.count == MacReviewCommand.allCases.count else { return nil }
        var commands: [MacReviewCommand: MacCommandPresentation] = [:]
        for raw in rawCommands {
            let allowedKeys = raw["shortcut"] == nil
                ? Set(["id", "label", "enabled"])
                : Set(["id", "label", "enabled", "shortcut"])
            guard Set(raw.keys) == allowedKeys,
                  let id = (raw["id"] as? String).flatMap(MacReviewCommand.init), commands[id] == nil,
                  let label = safeText(raw["label"], maximum: 80),
                  let enabled = raw["enabled"] as? Bool else { return nil }
            let shortcut: String?
            if raw["shortcut"] == nil { shortcut = nil }
            else {
                guard let value = safeText(raw["shortcut"], maximum: 40) else { return nil }
                shortcut = value
            }
            commands[id] = .init(command: id, label: label, enabled: enabled, shortcut: shortcut)
        }
        guard commands.count == MacReviewCommand.allCases.count else { return nil }
        return .init(revision: revision, focusContext: focus, commands: commands)
    }

    private static func safeText(_ value: Any?, maximum: Int) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= maximum,
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        return value
    }
}

@MainActor
final class MenuCoordinator: NSObject, NSMenuItemValidation, NSMenuDelegate {
    private let activeWindow: () -> PlacekeeperWindowController?
    private let openDocument: () -> Void
    private let openURL: (URL) -> Void
    private let recentMenu = NSMenu(title: "Open Recent")

    init(
        activeWindow: @escaping () -> PlacekeeperWindowController?,
        openDocument: @escaping () -> Void,
        openURL: @escaping (URL) -> Void
    ) {
        self.activeWindow = activeWindow
        self.openDocument = openDocument
        self.openURL = openURL
    }

    func install() {
        let main = NSMenu(title: "Main Menu")
        main.addItem(appMenu())
        main.addItem(fileMenu())
        main.addItem(editMenu())
        main.addItem(viewMenu())
        let window = windowMenu()
        main.addItem(window)
        main.addItem(helpMenu())
        NSApplication.shared.mainMenu = main
        NSApplication.shared.windowsMenu = window.submenu
    }

    func refresh() { NSApplication.shared.mainMenu?.update() }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let raw = menuItem.representedObject as? String,
              let command = MacReviewCommand(rawValue: raw),
              let controller = activeWindow(), let snapshot = controller.commandSnapshot,
              let presentation = snapshot.commands[command] else {
            return menuItem.action != #selector(invokeReviewCommand(_:))
        }
        menuItem.title = presentation.label
        if snapshot.focusContext == .editable, command == .undo || command == .redo {
            let selector = command == .undo ? Selector(("undo:")) : Selector(("redo:"))
            return NSApplication.shared.target(forAction: selector, to: nil, from: menuItem) != nil
        }
        return presentation.enabled
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === recentMenu else { return }
        menu.removeAllItems()
        let urls = NSDocumentController.shared.recentDocumentURLs.filter(\.isFileURL).prefix(10)
        for url in urls {
            let item = NSMenuItem(title: url.deletingPathExtension().lastPathComponent, action: #selector(openRecent(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = url
            menu.addItem(item)
        }
        if urls.isEmpty { menu.addItem(NSMenuItem(title: "No Recent Documents", action: nil, keyEquivalent: "")) }
        menu.addItem(.separator())
        let clear = NSMenuItem(title: "Clear Menu", action: #selector(clearRecent(_:)), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)
    }

    @objc private func invokeReviewCommand(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String,
              let command = MacReviewCommand(rawValue: raw), let controller = activeWindow() else { return }
        if controller.commandSnapshot?.focusContext == .editable, command == .undo || command == .redo {
            let selector = command == .undo ? Selector(("undo:")) : Selector(("redo:"))
            _ = NSApplication.shared.sendAction(selector, to: nil, from: sender)
            return
        }
        _ = controller.invokeCommand(command)
    }

    @objc private func chooseDocument(_ sender: Any?) { openDocument() }
    @objc private func openRecent(_ sender: NSMenuItem) {
        if let url = sender.representedObject as? URL { openURL(url) }
    }
    @objc private func clearRecent(_ sender: Any?) { NSDocumentController.shared.clearRecentDocuments(sender) }

    private func appMenu() -> NSMenuItem {
        let root = NSMenuItem()
        let menu = NSMenu(title: "Placekeeper")
        menu.addItem(NSMenuItem(title: "About Placekeeper", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Hide Placekeeper", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"))
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        menu.addItem(hideOthers)
        menu.addItem(NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Placekeeper", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        root.submenu = menu
        return root
    }

    private func fileMenu() -> NSMenuItem {
        let root = NSMenuItem()
        let menu = NSMenu(title: "File")
        let open = NSMenuItem(title: "Open…", action: #selector(chooseDocument(_:)), keyEquivalent: "o")
        open.target = self
        menu.addItem(open)
        let recent = NSMenuItem(title: "Open Recent", action: nil, keyEquivalent: "")
        recentMenu.delegate = self
        recent.submenu = recentMenu
        menu.addItem(recent)
        menu.addItem(.separator())
        menu.addItem(commandItem(.saveOptions, key: "s", modifiers: [.command, .option]))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        root.submenu = menu
        return root
    }

    private func editMenu() -> NSMenuItem {
        let root = NSMenuItem()
        let menu = NSMenu(title: "Edit")
        menu.addItem(commandItem(.undo, key: "z"))
        menu.addItem(commandItem(.redo, key: "z", modifiers: [.command, .shift]))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        menu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        menu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        menu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        menu.addItem(.separator())
        menu.addItem(commandItem(.find, key: "f"))
        root.submenu = menu
        return root
    }

    private func viewMenu() -> NSMenuItem {
        let root = NSMenuItem()
        let menu = NSMenu(title: "View")
        menu.addItem(commandItem(.navigateBack, key: "["))
        menu.addItem(commandItem(.navigateForward, key: "]"))
        menu.addItem(.separator())
        menu.addItem(commandItem(.fitWidth, key: "0"))
        menu.addItem(commandItem(.openAnnotations, key: ""))
        menu.addItem(.separator())
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        menu.addItem(fullScreen)
        root.submenu = menu
        return root
    }

    private func windowMenu() -> NSMenuItem {
        let root = NSMenuItem()
        let menu = NSMenu(title: "Window")
        menu.addItem(NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
        menu.addItem(NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""))
        root.submenu = menu
        return root
    }

    private func helpMenu() -> NSMenuItem {
        let root = NSMenuItem()
        let menu = NSMenu(title: "Help")
        let item = NSMenuItem(title: "Placekeeper Help", action: nil, keyEquivalent: "?")
        item.isEnabled = false
        menu.addItem(item)
        root.submenu = menu
        return root
    }

    private func commandItem(
        _ command: MacReviewCommand,
        key: String,
        modifiers: NSEvent.ModifierFlags = [.command]
    ) -> NSMenuItem {
        let item = NSMenuItem(title: command.rawValue, action: #selector(invokeReviewCommand(_:)), keyEquivalent: key)
        item.target = self
        item.representedObject = command.rawValue
        item.keyEquivalentModifierMask = modifiers
        return item
    }
}
