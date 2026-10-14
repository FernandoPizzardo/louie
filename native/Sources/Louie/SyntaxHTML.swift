import SwiftUI

/// An HTML (and XML) tokenizer, formatter, and syntax highlighter.
///
/// Formatting only changes whitespace: re-indenting never adds, drops, or
/// reorders markup or text (verified by a test that compares the two streams
/// with all whitespace removed).
enum HTMLHighlighter {
    enum Kind {
        case doctype, comment, punctuation, tagName, attributeName, attributeValue, text, raw
    }

    static let voidElements: Set<String> = [
        "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "param", "source", "track", "wbr",
    ]
    static let rawElements: Set<String> = ["script", "style", "textarea", "title"]

    static func looksLikeHTML(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard t.hasPrefix("<") else { return false }
        if t.hasPrefix("<?xml") { return true }        // treat XML as markup too
        return t.hasPrefix("<!doctype") || t.hasPrefix("<html") || (t.contains(">") && t.contains("<"))
    }

    // MARK: scanning helpers

    private static func matches(_ a: [Character], _ i: Int, _ s: String) -> Bool {
        let sc = Array(s)
        guard i + sc.count <= a.count else { return false }
        for k in 0..<sc.count where a[i + k] != sc[k] { return false }
        return true
    }

    private static func find(_ a: [Character], _ i: Int, _ s: String) -> Int? {
        let sc = Array(s)
        guard !sc.isEmpty, i + sc.count <= a.count else { return nil }
        var j = i
        while j + sc.count <= a.count {
            if matches(a, j, s) { return j }
            j += 1
        }
        return nil
    }

    // MARK: format

    /// Returns the token stream with indentation; whitespace-only differences.
    static func formatted(_ input: String) -> [(text: String, kind: Kind)] {
        var out: [(text: String, kind: Kind)] = []
        let a = Array(input)
        let n = a.count
        var i = 0
        var depth = 0
        var atLineStart = true
        let indentUnit = "  "

        func emit(_ s: String, _ k: Kind) {
            guard !s.isEmpty else { return }
            out.append((s, k))
            atLineStart = false
        }
        func newline() {
            out.append(("\n", .punctuation))
            out.append((String(repeating: indentUnit, count: max(depth, 0)), .punctuation))
            atLineStart = true
        }
        func startLine() { if !atLineStart { newline() } else { atLineStart = false } }

        while i < n {
            if a[i] == "<" {
                // comment
                if matches(a, i, "<!--") {
                    startLine()
                    let end = find(a, i + 4, "-->")
                    let stop = end == nil ? n : end! + 3
                    emit(String(a[i..<stop]), .comment)
                    i = stop
                    continue
                }
                // doctype / declaration
                if matches(a, i, "<!") || matches(a, i, "<?") {
                    startLine()
                    let end = find(a, i, ">")
                    let stop = end == nil ? n : end! + 1
                    emit(String(a[i..<stop]), .doctype)
                    i = stop
                    continue
                }
                // end tag
                if matches(a, i, "</") {
                    depth = max(depth - 1, 0)
                    startLine()
                    emit("</", .punctuation)
                    i += 2
                    var name = ""
                    while i < n, a[i] != ">" { name.append(a[i]); i += 1 }
                    emit(name, .tagName)
                    if i < n { emit(">", .punctuation); i += 1 }
                    continue
                }
                // start tag
                if i + 1 < n, a[i + 1].isLetter || a[i + 1] == "!" {
                    startLine()
                    emit("<", .punctuation)
                    i += 1
                    var name = ""
                    while i < n, !a[i].isWhitespace, a[i] != ">", a[i] != "/" { name.append(a[i]); i += 1 }
                    emit(name, .tagName)
                    let lowerName = name.lowercased()
                    var selfClosing = false
                    // attributes
                    while i < n {
                        if a[i].isWhitespace {
                            emit(" ", .punctuation); i += 1; continue
                        }
                        if matches(a, i, "/>") { emit("/>", .punctuation); i += 2; selfClosing = true; break }
                        if a[i] == ">" { emit(">", .punctuation); i += 1; break }
                        // attribute name
                        var attr = ""
                        while i < n, !a[i].isWhitespace, a[i] != "=", a[i] != ">", !matches(a, i, "/>") {
                            attr.append(a[i]); i += 1
                        }
                        emit(attr, .attributeName)
                        // optional =value
                        var j = i
                        while j < n, a[j].isWhitespace { j += 1 }
                        if j < n, a[j] == "=" {
                            emit(" ", .punctuation)
                            while i < n, a[i].isWhitespace { i += 1 }
                            emit("=", .punctuation); i += 1
                            while i < n, a[i].isWhitespace { emit(" ", .punctuation); i += 1 }
                            if i < n, a[i] == "\"" || a[i] == "'" {
                                let q = a[i]; var val = String(q); i += 1
                                while i < n, a[i] != q { val.append(a[i]); i += 1 }
                                if i < n { val.append(a[i]); i += 1 }
                                emit(val, .attributeValue)
                            } else {
                                var val = ""
                                while i < n, !a[i].isWhitespace, a[i] != ">" { val.append(a[i]); i += 1 }
                                emit(val, .attributeValue)
                            }
                        }
                    }
                    // raw-text elements keep their content verbatim
                    if rawElements.contains(lowerName), !selfClosing {
                        if let close = find(a, i, "</\(lowerName)") {
                            emit(String(a[i..<close]), .raw)
                            i = close
                        }
                        depth += 1
                        continue
                    }
                    if !selfClosing, !voidElements.contains(lowerName) { depth += 1 }
                    continue
                }
                // stray '<'
                emit("<", .text); i += 1
                continue
            }
            // text run
            var j = i
            while j < n, a[j] != "<" { j += 1 }
            let raw = String(a[i..<j])
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                startLine()
                // collapse internal whitespace runs to a single space
                let collapsed = trimmed.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                emit(collapsed, .text)
            }
            i = j
        }
        return out
    }

    static var colorMap: [Kind: Color] {
        let t = SyntaxTheme.shared
        return [.doctype: t.comment, .comment: t.comment, .punctuation: t.punctuation,
                .tagName: t.tag, .attributeName: t.attribute, .attributeValue: t.string,
                .text: t.plain, .raw: t.string]
    }

    static func attributed(_ input: String, weightTags: Bool = true) -> AttributedString {
        let colors = colorMap
        var out = AttributedString()
        for token in formatted(input) {
            var piece = AttributedString(token.text)
            piece.foregroundColor = colors[token.kind] ?? SyntaxTheme.shared.plain
            if token.kind == .tagName && weightTags {
                piece.font = .system(.body, design: .monospaced).weight(.semibold)
            }
            out.append(piece)
        }
        return out
    }

    /// All non-whitespace characters, in order — used to prove formatting only
    /// changed whitespace.
    static func nonWhitespace(_ s: String) -> String {
        String(s.filter { !$0.isWhitespace })
    }
}
