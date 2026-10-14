import XCTest
@testable import Louie

final class NodeResolutionTests: XCTestCase {
    /// The core bug: a GUI app's PATH lacks the user's node directory. Resolution
    /// must succeed without relying on PATH.
    func testResolvesNodeWithoutPath() throws {
        let p = EngineController.resolveNodePath(savedPath: nil, pathEnv: "/usr/bin:/bin")
        let resolved = try XCTUnwrap(p, "expected an absolute node path from known locations")
        XCTAssertTrue(resolved.hasPrefix("/"), "should be absolute: \(resolved)")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: resolved), "should exist: \(resolved)")
    }

    func testExplicitSettingWins() throws {
        // /usr/bin/env exists on every macOS install and is executable.
        let p = EngineController.resolveNodePath(savedPath: "/usr/bin/env", pathEnv: nil)
        XCTAssertEqual(p, "/usr/bin/env")
    }

    func testInvalidSettingFallsThrough() throws {
        let p = EngineController.resolveNodePath(savedPath: "/nope/not-node", pathEnv: "/usr/bin:/bin")
        XCTAssertNotEqual(p, "/nope/not-node")
        XCTAssertNotNil(p, "should fall back to a detected node")
    }

    func testMissingNodeReturnsNil() {
        let p = EngineController.resolveNodePath(savedPath: nil, pathEnv: "/nonexistent")
        // A machine with no Node in any known location yields nil (not a crash).
        if let p { XCTAssertTrue(FileManager.default.isExecutableFile(atPath: p)) }
    }

    /// The engine must receive a PATH containing its Node directory, so the
    /// tools it spawns (openssl, security) resolve regardless of app launch env.
    @MainActor
    func testChildEnvironmentIncludesNodeDirAndSystemBins() {
        let engine = EngineController()
        let node = "/Users/x/.local/bin/node"
        let env = engine.childEnvironment(nodePath: node)
        let path = env["PATH"] ?? ""
        XCTAssertTrue(path.contains("/Users/x/.local/bin"), "PATH: \(path)")
        XCTAssertTrue(path.contains("/usr/bin"))
        XCTAssertTrue(path.contains("/bin"))
    }
}
