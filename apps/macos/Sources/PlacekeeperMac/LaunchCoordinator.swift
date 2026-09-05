import Foundation

struct NativeOpenIntent: Equatable {
    enum Kind: Equatable {
        case document
        case placekeeperLink(String)
    }

    let sourceURL: URL
    let kind: Kind

    var routingKey: String {
        sourceURL.standardizedFileURL.resolvingSymlinksInPath().path
    }

    static func parse(_ url: URL) -> NativeOpenIntent? {
        if url.isFileURL {
            let source = url.standardizedFileURL
            guard source.pathExtension.lowercased() == "pdf" else { return nil }
            return .init(sourceURL: source, kind: .document)
        }
        let raw = url.absoluteString
        guard raw.utf8.count <= 16 * 1024, raw.hasPrefix("placekeeper:///"),
              let components = URLComponents(string: raw), components.scheme == "placekeeper",
              components.host == nil, components.user == nil, components.password == nil,
              components.port == nil, components.query == nil,
              let fragment = components.fragment, validLocationFragment(fragment),
              let path = components.percentEncodedPath.removingPercentEncoding,
              path.hasPrefix("/"), path != "/", path.lowercased().hasSuffix(".pdf"),
              !path.contains("\\"), !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
                .contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        return .init(sourceURL: URL(fileURLWithPath: path), kind: .placekeeperLink(raw))
    }

    private static func validLocationFragment(_ value: String) -> Bool {
        value.range(
            of: "^v=1&page=[1-9][0-9]*(?:&item=[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$",
            options: .regularExpression
        ) != nil || value.range(
            of: "^v=2&page=[1-9][0-9]*&mode=(?:xyz|fit-page|fit-bounding-box|fit-horizontal|fit-vertical|fit-bounding-box-horizontal|fit-bounding-box-vertical|fit-rectangle)(?:&params=[^&]+)?$",
            options: .regularExpression
        ) != nil
    }
}

struct LaunchCoordinator {
    private(set) var ready = false
    private(set) var pending: [NativeOpenIntent] = []
    private(set) var inFlightKeys = Set<String>()

    var inFlightCount: Int { inFlightKeys.count }

    mutating func enqueue(_ intents: [NativeOpenIntent]) -> [NativeOpenIntent] {
        for intent in intents {
            if let index = pending.firstIndex(where: { $0.routingKey == intent.routingKey }) {
                pending[index] = intent
            } else {
                pending.append(intent)
            }
        }
        return drain()
    }

    mutating func markReady() -> [NativeOpenIntent] {
        ready = true
        return drain()
    }

    mutating func finish(_ intent: NativeOpenIntent) -> [NativeOpenIntent] {
        inFlightKeys.remove(intent.routingKey)
        return drain()
    }

    private mutating func drain() -> [NativeOpenIntent] {
        guard ready else { return [] }
        var launched: [NativeOpenIntent] = []
        var retained: [NativeOpenIntent] = []
        for intent in pending {
            if inFlightKeys.insert(intent.routingKey).inserted {
                launched.append(intent)
            } else {
                retained.append(intent)
            }
        }
        pending = retained
        return launched
    }
}
