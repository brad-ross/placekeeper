// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PlacekeeperMac",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "PlacekeeperMac", targets: ["PlacekeeperMac"])],
    targets: [
        .executableTarget(name: "PlacekeeperMac"),
        .testTarget(name: "PlacekeeperMacTests", dependencies: ["PlacekeeperMac"]),
    ]
)
