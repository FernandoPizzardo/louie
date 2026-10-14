import SwiftUI

/// A JSON highlighter that preserves the original text exactly (no
/// JSONSerialization round-trip, so key order and formatting are unchanged).
enum JSONHighlighter {
    enum Kind { case key, string, number, boolean, null, punctuation, plain }

    struct Token: Equatable {
        let text: String
        let kind: Kind
    }

    static func looksLikeJSON(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = t.first, first == "{" || first == "[" else { return false }
        return t.last == "}" || t.last == "]"
    }

    static func tokenize(_ input: String) -> [Token] {
        var tokens: [Token] = []
        let chars = Array(input)
        var i = 0
        let n = chars.count

        func hasWord(_ word: String, at index: Int) -> Bool {
            let w = Array(word)
            guard index + w.count <= n else { return false }
            for k in 0..<w.count where chars[index + k] != w[k] { return false }
            return true
        }

        func peekNonSpace(_ from: Int) -> Character? {
            var j = from
            while j < n, chars[j].isWhitespace { j += 1 }
            return j < n ? chars[j] : nil
        }

        while i < n {
            let c = chars[i]
            if c.isWhitespace {
                var j = i
                while j < n, chars[j].isWhitespace { j += 1 }
                tokens.append(Token(text: String(chars[i..<j]), kind: .plain))
                i = j
                continue
            }
            if c == "\"" {
                var j = i + 1
                var escaped = false
                while j < n {
                    let d = chars[j]
                    if escaped { escaped = false }
                    else if d == "\\" { escaped = true }
                    else if d == "\"" { j += 1; break }
                    j += 1
                }
                let text = String(chars[i..<min(j, n)])
                let kind: Kind = peekNonSpace(j) == ":" ? .key : .string
                tokens.append(Token(text: text, kind: kind))
                i = j
                continue
            }
            if c == "-" || c.isNumber {
                var j = i
                while j < n, "0123456789.eE+-".contains(chars[j]) { j += 1 }
                tokens.append(Token(text: String(chars[i..<j]), kind: .number))
                i = j
                continue
            }
            if hasWord("true", at: i) || hasWord("false", at: i) {
                let word = hasWord("true", at: i) ? "true" : "false"
                tokens.append(Token(text: word, kind: .boolean))
                i += word.count
                continue
            }
            if hasWord("null", at: i) {
                tokens.append(Token(text: "null", kind: .null))
                i += 4
                continue
            }
            // punctuation run
            var j = i
            while j < n, "{}[],:".contains(chars[j]) { j += 1 }
            if j == i { j = i + 1 } // unknown char: emit as-is
            tokens.append(Token(text: String(chars[i..<j]), kind: .punctuation))
            i = j
        }
        return tokens
    }

    static var colorMap: [Kind: Color] {
        let t = SyntaxTheme.shared
        return [.key: t.key, .string: t.string, .number: t.number,
                .boolean: t.boolean, .null: t.red, .punctuation: t.punctuation, .plain: t.plain]
    }

    /// Pretty-print JSON with 2-space indentation, preserving key order. Falls
    /// back to the original text when the input is not balanced.
    static func beautify(_ input: String) -> String {
        var items: [(String, Kind)] = []
        for t in tokenize(input) {
            if t.kind == .plain { continue }
            if t.kind == .punctuation {
                for ch in t.text { items.append((String(ch), .punctuation)) }
            } else {
                items.append((t.text, t.kind))
            }
        }
        // balance check
        var depth = 0
        for (s, k) in items where k == .punctuation {
            if s == "{" || s == "[" { depth += 1 }
            else if s == "}" || s == "]" { depth -= 1; if depth < 0 { return input } }
        }
        if depth != 0 { return input }

        var out = ""
        var indent = 0
        let unit = "  "
        var i = 0
        func newlineIndent() { out += "\n" + String(repeating: unit, count: max(indent, 0)) }

        while i < items.count {
            let (s, kind) = items[i]
            if kind == .punctuation {
                switch s {
                case "{", "[":
                    if i + 1 < items.count, items[i + 1].0 == "}" || items[i + 1].0 == "]" {
                        out += s + items[i + 1].0
                        i += 2
                        continue
                    }
                    out += s; indent += 1; newlineIndent()
                case "}", "]":
                    indent = max(indent - 1, 0); newlineIndent(); out += s
                case ",":
                    out += s; newlineIndent()
                case ":":
                    out += ": "
                default:
                    out += s
                }
            } else {
                out += s
            }
            i += 1
        }
        return out
    }

    static func attributed(_ input: String, beautify: Bool = true, weightKeys: Bool = true) -> AttributedString {
        let text = beautify ? Self.beautify(input) : input
        let colors = colorMap
        var out = AttributedString()
        for token in tokenize(text) {
            var piece = AttributedString(token.text)
            piece.foregroundColor = colors[token.kind] ?? SyntaxTheme.shared.plain
            if token.kind == .key && weightKeys {
                piece.font = .system(.body, design: .monospaced).weight(.semibold)
            }
            out.append(piece)
        }
        return out
    }
}
