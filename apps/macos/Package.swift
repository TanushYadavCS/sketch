// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SketchLocal",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "SketchLocal", targets: ["SketchLocal"])
    ],
    targets: [
        .executableTarget(
            name: "SketchLocal",
            resources: [.process("Resources")],
            linkerSettings: [.linkedFramework("Security")]
        )
    ]
)
