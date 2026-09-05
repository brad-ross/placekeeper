import Foundation

let macShellProtocolVersion = 1

struct ShellReadinessFence: Equatable {
    private(set) var shellRevision: Int?
    private(set) var routingCommitted = false
    private(set) var orderedVisible = false
    private(set) var visibleShellRevision: Int?

    mutating func shellReady(revision: Int) -> Bool {
        guard revision >= 0 else { return false }
        shellRevision = revision
        return routingCommitted
    }

    mutating func commitRouting() -> Bool {
        guard !routingCommitted, shellRevision != nil else { return false }
        routingCommitted = true
        return true
    }

    mutating func didOrderVisible() {
        orderedVisible = true
    }

    mutating func confirmPaint(revision: Int) -> Bool {
        guard routingCommitted, orderedVisible, let shellRevision, revision >= shellRevision else { return false }
        visibleShellRevision = revision
        return true
    }
}

enum InitialWindowPlacementPolicy {
    static func shouldCenter(hasRestoredFrame: Bool) -> Bool { !hasRestoredFrame }
}

struct DragRect: Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var isValid: Bool {
        [x, y, width, height].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0
    }
}

struct DragRegionSet: Equatable, Sendable {
    let revision: Int
    let geometryIdentity: String
    let regions: [DragRect]
}

struct DragRegionFence {
    private(set) var currentRevision = -1
    private(set) var regions: [DragRect] = []
    var geometryIdentity: String
    var transitionInProgress = false {
        didSet { if transitionInProgress { regions = [] } }
    }

    mutating func apply(_ candidate: DragRegionSet) -> Bool {
        guard !transitionInProgress, candidate.geometryIdentity == geometryIdentity,
              candidate.revision > currentRevision, candidate.regions.count <= 32,
              candidate.regions.allSatisfy(\.isValid) else {
            regions = []
            return false
        }
        currentRevision = candidate.revision
        regions = candidate.regions
        return true
    }

    mutating func rolloverGeometryIdentity(to identity: String) {
        geometryIdentity = identity
        currentRevision = -1
        regions = []
        transitionInProgress = false
    }
}

enum MacPageBridgeMessageType: String, CaseIterable {
    case shellReady = "shell-ready"
    case documentReady = "document-ready"
    case runtimeMessage = "runtime-message"
    case runtimeError = "runtime-error"
    case commandSnapshot = "command-snapshot"
    case visibleShellReady = "visible-shell-ready"
    case dragRegions = "drag-regions"

    static func parse(_ body: [String: Any]) -> MacPageBridgeMessageType? {
        guard body["protocolVersion"] as? Int == macShellProtocolVersion,
              let raw = body["type"] as? String else { return nil }
        return Self(rawValue: raw)
    }
}

enum MacRuntimeErrorStage: String {
    case runtime
}

enum MacPageBridgeDiagnosticEvent: String, CaseIterable {
    case shellReadyAccepted = "page-shell-ready-accepted"
    case documentReadyAccepted = "page-document-ready-accepted"
    case runtimeMessageAccepted = "page-runtime-message-accepted"
    case runtimeErrorAccepted = "page-runtime-error-accepted"
    case commandSnapshotAccepted = "page-command-snapshot-accepted"
    case visibleShellReadyAccepted = "page-visible-shell-ready-accepted"
    case visibleShellReadyRejected = "page-visible-shell-ready-rejected"
    case dragRegionsAccepted = "page-drag-regions-accepted"
    case dragRegionsRejected = "page-drag-regions-rejected"

    static let allFixedNames = Set(allCases.map(\.rawValue))
}

enum MacSchemePolicy {
    private static let opaqueID = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,128}$")
    private static let manifestKey = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")

    static func bundleKey(for url: URL) -> String? {
        let raw = url.absoluteString.lowercased()
        guard !raw.contains("/../"), !raw.contains("%2e"), !raw.contains("%2f"), !raw.contains("%5c"),
              url.scheme == "placekeeper-app", url.host == "bundle", url.user == nil,
              url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { return nil }
        let key = String(url.path.dropFirst())
        guard !key.isEmpty, !key.contains("//"), !key.split(separator: "/").contains(".."),
              fullMatch(manifestKey, key) else { return nil }
        return key
    }

    static func resourceIdentity(for url: URL) -> (id: String, generation: Int)? {
        let raw = url.absoluteString.lowercased()
        guard !raw.contains("%2f"), !raw.contains("%5c"),
              url.scheme == "placekeeper-resource", url.host == "document", url.user == nil,
              url.password == nil, url.port == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.queryItems?.map(\.name) == ["generation", "role"],
              components.queryItems?[1].value == "document",
              let generationText = components.queryItems?[0].value,
              generationText.range(of: "^[1-9][0-9]{0,8}$", options: .regularExpression) != nil,
              let generation = Int(generationText) else { return nil }
        let identity = String(url.path.dropFirst())
        return fullMatch(opaqueID, identity) ? (identity, generation) : nil
    }

    static func permitsInWebView(_ url: URL) -> Bool {
        bundleKey(for: url) != nil || resourceIdentity(for: url) != nil
    }

    private static func fullMatch(_ expression: NSRegularExpression, _ value: String) -> Bool {
        expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))?.range.length == value.utf16.count
    }
}

enum ChildEnvironmentPolicy {
    private static let allowed = Set([
        "HOME", "LANG", "LC_ALL", "PATH", "TMPDIR", "PLACEKEEPER_RUNTIME_ROOT",
        "PLACEKEEPER_CONTROL_SOCKET", "PLACEKEEPER_BUILD_IDENTITY", "PLACEKEEPER_WINDOW_ID",
        "PLACEKEEPER_ATTEMPT_ID", "PLACEKEEPER_APP_INSTANCE_ID", "PLACEKEEPER_HELPER_ID",
        "PLACEKEEPER_MAC_DEVELOPMENT_ROOT", "PLACEKEEPER_DAEMON_IDENTITY",
        "PLACEKEEPER_MAC_DEVELOPMENT_HTTP_PORT",
        "PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY",
        "PLACEKEEPER_PDFIUM_WASM",
    ])

    static func minimal(from source: [String: String]) -> [String: String] {
        source.filter { allowed.contains($0.key) }
    }
}

struct PackagedHelperBuildIdentity: Equatable {
    let daemonIdentity: String
    let installArtifactIdentity: String
}

enum PackagedHelperEnvironmentPolicy {
    private static let digest = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")

    static func parseBuildIdentity(_ data: Data) -> PackagedHelperBuildIdentity? {
        guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == Set([
                "managementProtocolVersion", "daemonIdentity", "installArtifactIdentity",
              ]),
              value["managementProtocolVersion"] as? Int == 1,
              let daemonIdentity = value["daemonIdentity"] as? String,
              let installArtifactIdentity = value["installArtifactIdentity"] as? String,
              fullMatch(digest, daemonIdentity), fullMatch(digest, installArtifactIdentity) else { return nil }
        return .init(
            daemonIdentity: daemonIdentity,
            installArtifactIdentity: installArtifactIdentity
        )
    }

    static func merging(
        source: [String: String],
        resources: URL,
        identity: PackagedHelperBuildIdentity,
        allowDevelopmentOverrides: Bool
    ) -> [String: String] {
        var result = source
        let bundled = [
            "PLACEKEEPER_RUNTIME_ROOT": resources.path,
            "PLACEKEEPER_DAEMON_IDENTITY": identity.daemonIdentity,
            "PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY": identity.installArtifactIdentity,
            "PLACEKEEPER_PDFIUM_WASM": resources.appendingPathComponent("pdfium/pdfium.wasm").path,
        ]
        for (key, value) in bundled where !allowDevelopmentOverrides || result[key] == nil {
            result[key] = value
        }
        return result
    }

    static func resolve(
        source: [String: String],
        resources: URL?,
        allowDevelopmentOverrides: Bool
    ) -> [String: String]? {
        guard let resources,
              let data = try? Data(contentsOf: resources.appendingPathComponent("build-identity.json")),
              let identity = parseBuildIdentity(data) else {
            return allowDevelopmentOverrides ? source : nil
        }
        return merging(
            source: source,
            resources: resources,
            identity: identity,
            allowDevelopmentOverrides: allowDevelopmentOverrides
        )
    }

    private static func fullMatch(_ expression: NSRegularExpression, _ value: String) -> Bool {
        expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))?.range.length
            == value.utf16.count
    }
}

protocol ReviewHelperProcess: AnyObject {
    var windowID: String { get }
    var isRunning: Bool { get }
    func terminate()
}

final class ReviewHelperSupervisor {
    private var helpers: [String: ReviewHelperProcess] = [:]

    var activeWindowIDs: [String] { helpers.keys.sorted() }

    func attach(_ helper: ReviewHelperProcess) -> Bool {
        guard helpers[helper.windowID] == nil else { return false }
        helpers[helper.windowID] = helper
        return true
    }

    func helperDied(windowID: String) {
        helpers.removeValue(forKey: windowID)
    }

    func close(windowID: String) {
        let helper = helpers.removeValue(forKey: windowID)
        helper?.terminate()
    }
}

struct HelperDetachLedger {
    private var helperIDsByWindow: [String: String] = [:]

    mutating func register(windowID: String, helperID: String) -> Bool {
        guard helperIDsByWindow[windowID] == nil, windowID.count >= 8, helperID.count >= 8 else { return false }
        helperIDsByWindow[windowID] = helperID
        return true
    }

    mutating func takeHelperID(windowID: String) -> String? {
        helperIDsByWindow.removeValue(forKey: windowID)
    }
}

enum LifecycleDetachReason: String, Equatable {
    case eof
    case parentDeath
    case controlledExit
}

struct AppLifecycleLane: Equatable {
    private(set) var registered = false
    private(set) var activeWindows = Set<String>()
    private(set) var detachReason: LifecycleDetachReason?

    mutating func register(processID: Int32, startIdentity: String, buildIdentity: String) -> Bool {
        guard !registered, processID > 0, startIdentity.count >= 8, buildIdentity.count >= 8 else { return false }
        registered = true
        detachReason = nil
        return true
    }

    mutating func noteWindow(_ id: String, active: Bool) -> Bool {
        guard registered else { return false }
        if active { activeWindows.insert(id) } else { activeWindows.remove(id) }
        return true
    }

    mutating func detach(_ reason: LifecycleDetachReason) {
        registered = false
        activeWindows.removeAll()
        if detachReason == nil { detachReason = reason }
    }
}

enum CatastrophicAction: String, CaseIterable {
    case retry = "Retry"
    case diagnostics = "Diagnostics"
    case close = "Close"
}

struct ResourceVault {
    struct Document {
        let id: String
        let generation: Int
        let bytes: Data
    }

    private(set) var document: Document?

    mutating func install(_ candidate: Document) -> Bool {
        guard candidate.generation > 0, candidate.id.count >= 8,
              candidate.bytes.starts(with: Data("%PDF".utf8)), candidate.bytes.count <= 512 * 1024 * 1024 else { return false }
        document = candidate
        return true
    }

    func read(id: String, generation: Int) -> Data? {
        guard let document, document.id == id, document.generation == generation else { return nil }
        return document.bytes
    }

    mutating func invalidate() { document = nil }
}
