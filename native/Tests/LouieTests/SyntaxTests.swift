import XCTest
@testable import Louie

final class SyntaxTests: XCTestCase {

    // MARK: JSON

    func testJSONTokenizerPreservesTextExactly() {
        let json = """
        {
          "id": 42,
          "name": "Louie \\"the monkey\\"",
          "ok": true,
          "missing": null,
          "nested": { "list": [1, 2.5, -3e4] }
        }
        """
        let tokens = JSONHighlighter.tokenize(json)
        XCTAssertEqual(tokens.map(\.text).joined(), json, "highlighting must not reorder or alter text")
    }

    func testJSONClassifiesKeysAndValues() {
        let tokens = JSONHighlighter.tokenize(#"{"a": "b", "n": 1, "t": true, "z": null}"#)
        let keys = tokens.filter { $0.kind == .key }.map(\.text)
        XCTAssertEqual(keys, ["\"a\"", "\"n\"", "\"t\"", "\"z\""])
        XCTAssertEqual(tokens.first { $0.text == "\"b\"" }?.kind, .string)
        XCTAssertEqual(tokens.first { $0.text == "1" }?.kind, .number)
        XCTAssertEqual(tokens.first { $0.text == "true" }?.kind, .boolean)
        XCTAssertEqual(tokens.first { $0.text == "null" }?.kind, .null)
    }

    func testJSONLooksLikeJSON() {
        XCTAssertTrue(JSONHighlighter.looksLikeJSON("  {\"a\":1} "))
        XCTAssertTrue(JSONHighlighter.looksLikeJSON("[1,2,3]"))
        XCTAssertFalse(JSONHighlighter.looksLikeJSON("hello"))
        XCTAssertFalse(JSONHighlighter.looksLikeJSON("<a/>"))
    }

    func testJSONAttributedBeautifiesAndKeepsPlainText() {
        let json = #"{"b":1,"a":[2,3]}"#
        let attr = JSONHighlighter.attributed(json)
        let pretty = JSONHighlighter.beautify(json)
        XCTAssertEqual(String(attr.characters), pretty)
        XCTAssertEqual(String(attr.characters), """
        {
          "b": 1,
          "a": [
            2,
            3
          ]
        }
        """)
    }

    func testJSONBeautifyPreservesKeyOrderAndStructure() {
        let json = #"{"z":1,"a":{"m":[true,false,null],"n":"s"},"e":{},"r":[]}"#
        let out = JSONHighlighter.beautify(json)
        XCTAssertEqual(out, """
        {
          "z": 1,
          "a": {
            "m": [
              true,
              false,
              null
            ],
            "n": "s"
          },
          "e": {},
          "r": []
        }
        """)
        // key order is preserved (no alphabetical reordering)
        XCTAssertLessThan(out.range(of: "\"z\"")!.lowerBound, out.range(of: "\"a\"")!.lowerBound)
    }

    func testJSONBeautifyFallsBackOnUnbalancedInput() {
        let broken = #"{"a": 1"#
        XCTAssertEqual(JSONHighlighter.beautify(broken), broken)
    }

    func testJSONBeautifyIsIdempotent() {
        let json = #"{"a":[1,{"b":2}],"c":"d"}"#
        let once = JSONHighlighter.beautify(json)
        XCTAssertEqual(JSONHighlighter.beautify(once), once)
    }

    // MARK: HTML

    private func flattened(_ html: String) -> String {
        HTMLHighlighter.formatted(html).map(\.text).joined()
    }

    func testHTMLFormattingOnlyChangesWhitespace() {
        let html = #"<!doctype html><html><head><title>T</title></head><body><div class="a" id='b'>Hi <b>there</b></div><!-- c --><img src="x.png"></body></html>"#
        XCTAssertEqual(HTMLHighlighter.nonWhitespace(flattened(html)),
                       HTMLHighlighter.nonWhitespace(html),
                       "formatting must not add, drop or reorder markup/text")
    }

    func testHTMLIndentsNestedTags() {
        let html = "<div><section><p>x</p></section></div>"
        let lines = flattened(html).split(separator: "\n").map(String.init)
        // find the line containing <p>
        let pLine = try? XCTUnwrap(lines.first { $0.contains("<p>") })
        XCTAssertNotNil(pLine)
        XCTAssertTrue(pLine!.hasPrefix("    "), "expected 4-space indent, got: \(pLine!)")
    }

    func testHTMLClassifiesCommentsDoctypeAndAttributes() {
        let tokens = HTMLHighlighter.formatted("<!doctype html><!-- hi --><a href=\"x\" download>go</a>")
        XCTAssertEqual(tokens.first?.kind, .doctype)
        XCTAssertTrue(tokens.contains { $0.kind == .comment && $0.text.contains("hi") })
        XCTAssertTrue(tokens.contains { $0.kind == .tagName && $0.text == "a" })
        XCTAssertTrue(tokens.contains { $0.kind == .attributeName && $0.text == "href" })
        XCTAssertTrue(tokens.contains { $0.kind == .attributeValue && $0.text == "\"x\"" })
        XCTAssertTrue(tokens.contains { $0.kind == .attributeName && $0.text == "download" })
    }

    func testHTMLKeepsScriptContentVerbatim() {
        let html = "<script>if (a < b) { go(); }</script>"
        let raw = HTMLHighlighter.formatted(html).first { $0.kind == .raw }?.text
        XCTAssertEqual(raw, "if (a < b) { go(); }")
    }

    func testHTMLVoidAndSelfClosingDoNotIndent() {
        let tokens = HTMLHighlighter.formatted("<div><br><img src=\"x\"><hr/></div>")
        let divIndent = tokens.first { $0.text == "div" }
        XCTAssertNotNil(divIndent)
        // The next lines should not accumulate indentation from void elements.
        let imgLine = flattened("<div><br><img src=\"x\"><hr/></div>")
            .split(separator: "\n").map(String.init).first { $0.contains("img") }
        XCTAssertEqual(imgLine?.prefix(2), "  ", "void elements must not increase indent: \(imgLine ?? "nil")")
    }

    func testHTMLLooksLikeHTML() {
        XCTAssertTrue(HTMLHighlighter.looksLikeHTML("<!doctype html><html></html>"))
        XCTAssertTrue(HTMLHighlighter.looksLikeHTML("<?xml version=\"1.0\"?><a/>"))
        XCTAssertFalse(HTMLHighlighter.looksLikeHTML("{\"json\":true}"))
        XCTAssertFalse(HTMLHighlighter.looksLikeHTML("plain text"))
    }
}
