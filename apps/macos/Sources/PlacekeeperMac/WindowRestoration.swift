import AppKit
import Foundation

struct RestorableDocumentWindow: Equatable {
    let sourcePath: String
    let frame: String
    let page: Int?
    let zoom: Double?

    var sourceURL: URL { URL(fileURLWithPath: sourcePath) }

    static func parse(_ value: Any) -> RestorableDocumentWindow? {
        guard let record = value as? [String: Any],
              Set(record.keys).isSubset(of: ["sourcePath", "frame", "page", "zoom"]),
              Set(["sourcePath", "frame"]).isSubset(of: record.keys),
              let sourcePath = record["sourcePath"] as? String,
              sourcePath.hasPrefix("/"), sourcePath.utf8.count <= 16 * 1024,
              sourcePath.lowercased().hasSuffix(".pdf"), !sourcePath.contains("\0"),
              let frame = record["frame"] as? String, frame.utf8.count <= 256,
              validFrame(NSRectFromString(frame)) else { return nil }
        let page = record["page"] as? Int
        if let page, page < 1 { return nil }
        let zoom = record["zoom"] as? Double
        if let zoom, !zoom.isFinite || zoom < 0.1 || zoom > 64 { return nil }
        return .init(sourcePath: sourcePath, frame: frame, page: page, zoom: zoom)
    }

    var propertyList: [String: Any] {
        var value: [String: Any] = [
            "sourcePath": sourcePath,
            "frame": frame,
        ]
        if let page { value["page"] = page }
        if let zoom { value["zoom"] = zoom }
        return value
    }

    private static func validFrame(_ frame: NSRect) -> Bool {
        [frame.origin.x, frame.origin.y, frame.width, frame.height].allSatisfy(\.isFinite)
            && frame.width >= 480 && frame.height >= 320
            && frame.width <= 16_384 && frame.height <= 16_384
    }
}

struct WindowRestorationStore {
    private let defaults: UserDefaults
    private let key = "Placekeeper.RestorableDocumentWindows.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> [RestorableDocumentWindow] {
        guard let values = defaults.array(forKey: key), values.count <= 32 else { return [] }
        return values.compactMap(RestorableDocumentWindow.parse)
    }

    func save(_ records: [RestorableDocumentWindow]) {
        defaults.set(records.prefix(32).map(\.propertyList), forKey: key)
    }
}
