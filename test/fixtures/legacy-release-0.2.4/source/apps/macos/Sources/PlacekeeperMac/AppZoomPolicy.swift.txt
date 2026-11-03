import CoreFoundation
import Foundation

/// Application presentation scale, independent of each document's PDF zoom.
enum AppZoomPolicy {
    static let levels: [Double] = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]
    static let defaultScale: Double = 1

    static func validatedScale(_ value: Any?) -> Double {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite,
              levels.contains(number.doubleValue) else { return defaultScale }
        return number.doubleValue
    }

    static func increased(_ scale: Double) -> Double {
        let current = validatedScale(scale)
        return levels.first { $0 > current } ?? levels[levels.count - 1]
    }

    static func decreased(_ scale: Double) -> Double {
        let current = validatedScale(scale)
        return levels.last { $0 < current } ?? levels[0]
    }
}

final class AppZoomStore {
    static let preferenceKey = "Placekeeper.AppZoom.v1"
    private let defaults: UserDefaults
    private(set) var scale: Double

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        scale = AppZoomPolicy.validatedScale(defaults.object(forKey: Self.preferenceKey))
    }

    func setScale(_ value: Double) {
        scale = AppZoomPolicy.validatedScale(value)
        defaults.set(scale, forKey: Self.preferenceKey)
    }

    func zoomIn() { setScale(AppZoomPolicy.increased(scale)) }
    func zoomOut() { setScale(AppZoomPolicy.decreased(scale)) }
    func reset() { setScale(AppZoomPolicy.defaultScale) }
}
