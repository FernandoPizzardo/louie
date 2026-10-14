import XCTest
@testable import Louie

final class ModelsTests: XCTestCase {
    private func summaryJSON() -> Data {
        """
        {"id":1,"scheme":"https","method":"GET","host":"api.example.com","port":443,
         "path":"/v1/x","status":200,"durationMs":12,"sslProxied":true,"tunneled":false,
         "error":null,"complete":true,"reqSize":0,"resSize":12,"contentType":"application/json",
         "notes":[{"tool":"Rewrite","text":"response body rewritten"}],"start":123}
        """.data(using: .utf8)!
    }

    func testSummaryDecodesAndComputes() throws {
        let s = try JSONDecoder().decode(TransactionSummary.self, from: summaryJSON())
        XCTAssertEqual(s.statusText, "200")
        XCTAssertEqual(s.hostAndPort, "api.example.com") // 443 omitted
        XCTAssertEqual(s.notes?.first?.tool, "Rewrite")
    }

    func testSummaryErrorAndTunnelStatus() throws {
        var s = try JSONDecoder().decode(TransactionSummary.self, from: summaryJSON())
        s = try JSONDecoder().decode(TransactionSummary.self, from: """
        {"id":2,"method":"GET","host":"h","error":"boom"}
        """.data(using: .utf8)!)
        XCTAssertEqual(s.statusText, "ERR")
        s = try JSONDecoder().decode(TransactionSummary.self, from: """
        {"id":3,"method":"CONNECT","host":"h","tunneled":true}
        """.data(using: .utf8)!)
        XCTAssertEqual(s.statusText, "—")
    }

    func testDetailDecodesHeadersAndBodies() throws {
        let json = """
        {"id":1,"scheme":"http","method":"GET","host":"h","port":8080,"path":"/a",
         "status":200,"durationMs":3,"sslProxied":false,"notes":[],
         "requestHeaders":{"accept":"*/*","x-multi":["a","b"]},
         "requestBody":{"type":"empty","text":""},
         "responseHeaders":{"content-type":"application/json"},
         "responseBody":{"type":"text","text":"{\\"ok\\":true}","truncated":false}}
        """.data(using: .utf8)!
        let d = try JSONDecoder().decode(TransactionDetail.self, from: json)
        XCTAssertEqual(d.requestHeaders["x-multi"]?.description, "a, b")
        XCTAssertEqual(d.responseBody.text, "{\"ok\":true}")
        XCTAssertEqual(d.summaryLine, "GET http://h/a · 3ms")
    }
}
