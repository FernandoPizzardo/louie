// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Louie",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "Louie", targets: ["Louie"]),
    ],
    targets: [
        .executableTarget(
            name: "Louie",
            path: "Sources/Louie"
        ),
        .testTarget(
            name: "LouieTests",
            dependencies: ["Louie"],
            path: "Tests/LouieTests"
        ),
    ]
)
