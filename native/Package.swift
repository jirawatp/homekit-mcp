// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HomeKitBridgeCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "BridgeCore", targets: ["BridgeCore"]), .executable(name: "BridgeFixture", targets: ["BridgeFixture"])],
    targets: [
        .target(name: "BridgeCore"),
        .executableTarget(name: "BridgeFixture", dependencies: ["BridgeCore"]),
        .testTarget(name: "BridgeCoreTests", dependencies: ["BridgeCore"])
    ]
)
