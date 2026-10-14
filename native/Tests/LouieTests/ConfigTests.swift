import XCTest
@testable import Louie

final class ConfigTests: XCTestCase {
    func testToolConfigDecodesEngineConfig() throws {
        let json = """
        {"enabled":{"blocklist":true,"mapRemote":false,"mapLocal":false,"rewrite":false,"throttle":false,"noCache":false},
         "blockAction":"403",
         "blocklist":[{"host":"ads.example.com","path":"*"}],
         "mapRemote":[{"from":{"host":"a.com","path":"/api/*"},"to":{"protocol":"https","host":"b.com","port":443,"path":"/v2/","query":"k=1"}}],
         "mapLocal":[{"location":{"host":"a.com"},"localPath":"/tmp/x","caseSensitive":true}],
         "rewrite":[{"enabled":true,"location":{"host":"*"},"rules":[{"type":"response","target":"body","match":"x","replace":"y","flags":"g"}]}],
         "throttle":{"latency":100,"bandwidthDown":50,"bandwidthUp":0,"hosts":[]},
         "sslLocations":[{"host":"localhost","port":443}]}
        """.data(using: .utf8)!
        let c = try JSONDecoder().decode(ToolConfig.self, from: json)
        XCTAssertTrue(c.enabled.blocklist)
        XCTAssertEqual(c.blockAction, "403")
        XCTAssertEqual(c.blocklist.first?.host, "ads.example.com")
        XCTAssertEqual(c.mapRemote.first?.to.scheme, "https")
        XCTAssertEqual(c.mapRemote.first?.to.query, "k=1")
        XCTAssertEqual(c.mapLocal.first?.caseSensitive, true)
        XCTAssertEqual(c.rewrite.first?.rules.first?.match, "x")
        XCTAssertEqual(c.throttle.bandwidthDown, 50)
        XCTAssertEqual(c.sslLocations.first?.port, 443)
    }

    func testToolConfigRoundTripsAndOmitsNilLocationFields() throws {
        var c = ToolConfig()
        c.enabled.mapLocal = true
        c.blockAction = "drop"
        c.mapLocal = [MapLocalRule(location: Location(host: "a.com"), localPath: "/tmp/x",
                                   contentType: nil, caseSensitive: false)]
        let data = try JSONEncoder().encode(c)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let loc = ((obj?["mapLocal"] as? [[String: Any]])?.first?["location"] as? [String: Any])
        XCTAssertEqual(loc?["host"] as? String, "a.com")
        XCTAssertNil(loc?["port"])          // nil fields are omitted
        XCTAssertNil(loc?["path"])
        XCTAssertNil(loc?["protocol"])

        let back = try JSONDecoder().decode(ToolConfig.self, from: data)
        XCTAssertEqual(back, c)
    }

    func testMissingSectionsDefault() throws {
        let c = try JSONDecoder().decode(ToolConfig.self, from: Data("{}".utf8))
        XCTAssertFalse(c.enabled.rewrite)
        XCTAssertEqual(c.blockAction, "drop")
        XCTAssertTrue(c.blocklist.isEmpty)
        XCTAssertEqual(c.throttle.latency, 0)
    }

    func testCAInfoDecodes() throws {
        let json = """
        {"path":"/tmp/ca.crt","subject":"CN=Charles-Clone CA (x)","fingerprint":"AA:BB",
         "fingerprintHex":"aabb","trusted":false}
        """.data(using: .utf8)!
        let ca = try JSONDecoder().decode(CAInfo.self, from: json)
        XCTAssertEqual(ca.fingerprintHex, "aabb")
        XCTAssertFalse(ca.trusted)
        XCTAssertEqual(ca.subject, "CN=Charles-Clone CA (x)")
    }

    func testTrustResultDecodes() throws {
        let r = try JSONDecoder().decode(TrustResult.self, from: Data(#"{"ok":false,"error":"denied"}"#.utf8))
        XCTAssertFalse(r.ok)
        XCTAssertEqual(r.error, "denied")
    }

    func testImportResultDecodes() throws {
        let json = """
        {"ok":true,"source":"/x/com.xk72.charles.config","warnings":[],
         "summary":{"sslLocations":3,"blocklist":0,"mapRemote":4,"throttleHosts":3,"enabled":["mapRemote","throttle"]}}
        """.data(using: .utf8)!
        let r = try JSONDecoder().decode(ImportResult.self, from: json)
        XCTAssertTrue(r.ok)
        XCTAssertEqual(r.summary?.sslLocations, 3)
        XCTAssertEqual(r.summary?.mapRemote, 4)
        XCTAssertEqual(r.summary?.enabled, ["mapRemote", "throttle"])
    }
}
