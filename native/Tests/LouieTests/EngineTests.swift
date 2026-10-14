import XCTest
@testable import Louie

final class EngineTests: XCTestCase {
    func testEngineInfoDecodesHandshake() throws {
        let json = """
        {"pid":42,"proxyPort":8888,"bindHost":"127.0.0.1","controlPort":51000,
         "token":"abc","caCertPath":"/tmp/ca.crt","configFile":"/tmp/config.json"}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(EngineInfo.self, from: json)
        XCTAssertEqual(info.proxyPort, 8888)
        XCTAssertEqual(info.controlPort, 51000)
        XCTAssertEqual(info.token, "abc")
        XCTAssertEqual(info.baseURL.absoluteString, "http://127.0.0.1:51000")
    }

    func testEngineInfoDecodesNullToken() throws {
        let json = """
        {"pid":1,"proxyPort":8888,"bindHost":"127.0.0.1","controlPort":1,
         "token":null,"caCertPath":"/tmp/ca.crt","configFile":"/tmp/c.json"}
        """.data(using: .utf8)!
        let info = try JSONDecoder().decode(EngineInfo.self, from: json)
        XCTAssertNil(info.token)
    }

    @MainActor
    func testEngineStartsAndReportsReady() async throws {
        guard FileManager.default.fileExists(atPath: EngineController().enginePath) else {
            throw XCTSkip("engine not found at \(EngineController().enginePath)")
        }
        let engine = EngineController()
        engine.proxyPort = 18987
        engine.start()
        // Wait up to 8s for the engine handshake.
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            if engine.info != nil { break }
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertEqual(engine.status, .running, "engine status: \(engine.status.label); log: \(engine.log.suffix(5).joined(separator: " | "))")
        let info = try XCTUnwrap(engine.info)
        XCTAssertEqual(info.proxyPort, 18987)
        XCTAssertGreaterThan(info.controlPort, 0)

        // Control API answers with the token.
        let control = try XCTUnwrap(engine.control)
        let list: [String] = try await control.getJSON("/api/transactions", as: [String].self)
        XCTAssertTrue(list.isEmpty)

        engine.stop()
    }

    /// End-to-end: a request through the proxy is visible via the control API.
    @MainActor
    func testProxyRecordsTransactionVisibleOverControlAPI() async throws {
        let engine = EngineController()
        guard FileManager.default.fileExists(atPath: engine.enginePath) else {
            throw XCTSkip("engine not found")
        }
        // A tiny local origin so the test needs no network.
        let origin = Process()
        origin.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        origin.arguments = ["node", "-e",
            "require('http').createServer((q,s)=>s.end('hello')).listen(18990,'127.0.0.1')"]
        try origin.run()
        defer { origin.terminate() }

        engine.proxyPort = 18989
        engine.start()
        defer { engine.stop() }   // never leak the child process on failure
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, engine.info == nil {
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        let info = try XCTUnwrap(engine.info)

        // Proxy a request to the origin.
        let curl = Process()
        curl.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        curl.arguments = ["-s", "--noproxy", "", "-x", "http://127.0.0.1:\(info.proxyPort)",
                          "http://127.0.0.1:18990/hello"]
        let out = Pipe(); curl.standardOutput = out
        try curl.run(); curl.waitUntilExit()
        let body = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertEqual(body, "hello")

        let control = try XCTUnwrap(engine.control)
        let list: [TransactionSummary] = try await control.getJSON("/api/transactions", as: [TransactionSummary].self)
        XCTAssertGreaterThanOrEqual(list.count, 1)
        XCTAssertEqual(list.last?.host, "127.0.0.1")

        engine.stop()
    }

    /// Saving config through the control API (what the Tools editor does) must
    /// change engine behavior. Verifies blockAction=drop blocks a request.
    @MainActor
    func testSavingConfigChangesEngineBehavior() async throws {
        let engine = EngineController()
        guard FileManager.default.fileExists(atPath: engine.enginePath) else {
            throw XCTSkip("engine not found")
        }
        engine.configFile = NSTemporaryDirectory() + "charles-test-\(UUID().uuidString).json"
        engine.proxyPort = 18993

        let origin = Process()
        origin.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        origin.arguments = ["node", "-e",
            "require('http').createServer((q,s)=>s.end('hello')).listen(18994,'127.0.0.1')"]
        try origin.run()
        defer { origin.terminate() }

        engine.start()
        defer { engine.stop() }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, engine.info == nil {
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        let info = try XCTUnwrap(engine.info)
        let control = try XCTUnwrap(engine.control)

        // Before: the request reaches the origin.
        let before = try runCurl(proxy: info.proxyPort)
        XCTAssertTrue(before.ok, "expected the request to succeed before blocking")

        // Save the config the editor would save: blocklist + drop.
        var cfg = ToolConfig()
        cfg.enabled.blocklist = true
        cfg.blockAction = "drop"
        cfg.blocklist = [Location(host: "127.0.0.1", port: 18994)]
        try await control.postData("/api/config", JSONEncoder().encode(cfg))

        // Engine reflects it.
        let saved = try await control.getJSON("/api/config", as: ToolConfig.self)
        XCTAssertTrue(saved.enabled.blocklist)
        XCTAssertEqual(saved.blockAction, "drop")
        XCTAssertEqual(saved.blocklist.first?.port, 18994)

        // After: the connection is dropped (curl fails).
        let after = try runCurl(proxy: info.proxyPort)
        XCTAssertFalse(after.ok, "expected the request to be dropped after enabling blocklist")
    }

    /// The CA endpoint reports identity + trust (without mutating trust state).
    @MainActor
    func testControlAPIServesCAInfo() async throws {
        let engine = EngineController()
        guard FileManager.default.fileExists(atPath: engine.enginePath) else {
            throw XCTSkip("engine not found")
        }
        engine.configFile = NSTemporaryDirectory() + "charles-ca-\(UUID().uuidString).json"
        engine.proxyPort = 18995
        engine.start()
        defer { engine.stop() }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, engine.info == nil {
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        _ = try XCTUnwrap(engine.info)
        let control = try XCTUnwrap(engine.control)

        let ca = try await control.getJSON("/api/ca", as: CAInfo.self)
        XCTAssertNotNil(ca.fingerprintHex)
        XCTAssertEqual(ca.fingerprintHex?.count, 64)
        XCTAssertTrue(ca.fingerprintHex?.allSatisfy { $0.isHexDigit } ?? false)
        XCTAssertTrue((ca.subject ?? "").contains("Charles-Clone"), "subject: \(ca.subject ?? "nil")")
        XCTAssertTrue(ca.path.hasSuffix("ca.crt"))
    }

    /// Importing a Charles XML through the control API updates the engine config.
    @MainActor
    func testControlAPIImportsCharlesConfig() async throws {
        let engine = EngineController()
        guard FileManager.default.fileExists(atPath: engine.enginePath) else {
            throw XCTSkip("engine not found")
        }
        engine.configFile = NSTemporaryDirectory() + "charles-imp-\(UUID().uuidString).json"
        engine.proxyPort = 18996
        engine.start()
        defer { engine.stop() }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, engine.info == nil {
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        let info = try XCTUnwrap(engine.info)
        let control = try XCTUnwrap(engine.control)

        let fixture = NSTemporaryDirectory() + "charles-\(UUID().uuidString).config"
        let xml = """
        <?xml version="1.0"?><configuration><proxyConfiguration><sslLocations><locationPatterns>
        <locationMatch><location><host>imported.example.com</host><port>443</port></location></locationMatch>
        </locationPatterns></sslLocations></proxyConfiguration></configuration>
        """
        try xml.write(toFile: fixture, atomically: true, encoding: .utf8)

        let r = try await control.postJSON("/api/import/charles", json: ["path": fixture], as: ImportResult.self)
        XCTAssertTrue(r.ok, "import failed: \(r.error ?? "?")")
        XCTAssertEqual(r.summary?.sslLocations, 1)

        let cfg = try await control.getJSON("/api/config", as: ToolConfig.self)
        XCTAssertTrue(cfg.sslLocations.contains { $0.host == "imported.example.com" })
        _ = info
    }

    /// Regression for the "engine exited with code 127" bug: with the minimal
    /// PATH a GUI app gets, the engine must still start (Node is resolved
    /// absolutely, not via PATH).
    @MainActor
    func testEngineStartsWithMinimalGUIPATH() async throws {
        let saved = ProcessInfo.processInfo.environment["PATH"]
        setenv("PATH", "/usr/bin:/bin", 1)
        defer { if let saved { setenv("PATH", saved, 1) } else { unsetenv("PATH") } }

        let engine = EngineController()
        guard FileManager.default.fileExists(atPath: engine.enginePath) else {
            throw XCTSkip("engine not found")
        }
        engine.configFile = NSTemporaryDirectory() + "charles-path-\(UUID().uuidString).json"
        engine.proxyPort = 18988
        engine.start()
        defer { engine.stop() }

        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, engine.info == nil {
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTAssertEqual(engine.status, .running, "status: \(engine.status.label); node=\(engine.nodePath)")
        XCTAssertFalse(engine.nodePath.isEmpty, "Node path must be resolved without PATH")
    }

    /// Persistence is opt-in, /api/net defaults to LAN off, and the CA listener
    /// serves only the public certificate.
    @MainActor
    func testControlAPIDeviceFeatures() async throws {
        let engine = EngineController()
        guard FileManager.default.fileExists(atPath: engine.enginePath) else { throw XCTSkip("engine not found") }
        engine.configFile = NSTemporaryDirectory() + "louie-dev-\(UUID().uuidString).json"
        engine.proxyPort = 18992
        engine.start()
        defer { engine.stop() }
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline, engine.info == nil {
            if case .failed = engine.status { break }
            try await Task.sleep(for: .milliseconds(200))
        }
        _ = try XCTUnwrap(engine.info)
        let control = try XCTUnwrap(engine.control)

        // Persistence is opt-in.
        let p0 = try await control.getJSON("/api/persist", as: PersistInfo.self)
        XCTAssertFalse(p0.enabled ?? true, "persistence must default to off")
        _ = try await control.postJSON("/api/persist", json: [:], as: OkResponse.self) // no-op keeps shape
        let p1 = try await control.postCodable("/api/persist", PersistPatch(enabled: true), as: OkResponse.self)
        XCTAssertTrue(p1.ok)
        let p2 = try await control.getJSON("/api/persist", as: PersistInfo.self)
        XCTAssertEqual(p2.enabled, true)

        // LAN off by default.
        let net = try await control.getJSON("/api/net", as: NetInfo.self)
        XCTAssertFalse(net.lanEnabled)

        // CA listener serves the cert, never the key.
        let serve = try await control.postCodable("/api/ca/serve", OnPatch(on: true), as: CAServeResult.self)
        XCTAssertTrue(serve.serving ?? false)
        if let cer = serve.cerUrl, let url = URL(string: cer) {
            let (data, _) = try await URLSession.shared.data(from: url)
            XCTAssertGreaterThan(data.count, 100)
            XCTAssertEqual(data.first, 0x30, "DER should start with 0x30")
        } else {
            XCTFail("no cerUrl: \(serve)")
        }
        _ = try await control.postCodable("/api/ca/serve", OnPatch(on: false), as: CAServeResult.self)
    }

    private func runCurl(proxy: Int) throws -> (ok: Bool, body: String) {
        let curl = Process()
        curl.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        curl.arguments = ["-s", "--noproxy", "", "-x", "http://127.0.0.1:\(proxy)",
                          "http://127.0.0.1:18994/hi"]
        let out = Pipe(); curl.standardOutput = out; curl.standardError = Pipe()
        try curl.run(); curl.waitUntilExit()
        let body = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        return (curl.terminationStatus == 0 && body == "hello", body)
    }
}
