import SwiftUI

/// The transaction inspector: Request / Response / Notes tabs, with syntax
/// highlighting for JSON and HTML (and a rendered HTML preview).
struct InspectorView: View {
    @Environment(SessionStore.self) private var store
    @State private var tab = 0
    @State private var htmlPreview = false

    private let mono = Font.system(.body, design: .monospaced)

    var body: some View {
        VStack(spacing: 0) {
            if let d = store.detail {
                GlassTabs(titles: ["Request", "Response", "Notes"], selection: $tab)
                    .padding(.horizontal, 10)
                    .padding(.top, 10)
                summary(d)
                Divider()
                switch tab {
                case 0: requestBody(d)
                case 1: responseBody(d)
                default: notes(d)
                }
            } else {
                Spacer()
                Text(store.selectedID == nil ? "Select a transaction" : "Loading…")
                    .foregroundStyle(.secondary)
                Spacer()
            }
        }
        .onChange(of: store.selectedID) { _, id in
            htmlPreview = false
            Task { await store.select(id) }
        }
    }

    // MARK: header

    private func summary(_ d: TransactionDetail) -> some View {
        HStack {
            Text(badge(d)).font(.system(.caption, design: .monospaced))
            Text(d.summaryLine).font(.system(.caption, design: .monospaced)).lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
    }

    private func badge(_ d: TransactionDetail) -> String {
        if d.tunneled == true { return "TUNNEL" }
        if d.error != nil { return "ERROR" }
        return "\(d.status ?? 0)"
    }

    // MARK: tabs

    private func requestBody(_ d: TransactionDetail) -> some View {
        bodyPane(headers: d.requestHeaders, body: d.requestBody,
                 contentType: d.requestHeaders["content-type"]?.description)
    }

    private func responseBody(_ d: TransactionDetail) -> some View {
        bodyPane(headers: d.responseHeaders, body: d.responseBody,
                 contentType: d.responseHeaders["content-type"]?.description)
    }

    private func bodyPane(headers: [String: HeaderValue], body: BodyPreview, contentType: String?) -> some View {
        let kind = bodyKind(body, contentType: contentType)
        return VStack(alignment: .leading, spacing: 0) {
            if kind == .html {
                Picker("", selection: $htmlPreview) {
                    Text("Source").tag(false)
                    Text("Preview").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 200)
                .padding(.horizontal, 10).padding(.top, 8)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    sectionTitle("Headers")
                    headerList(headers)
                    sectionTitle("Body")
                    switch kind {
                    case .empty:
                        Text("(empty)").foregroundStyle(.secondary).font(mono)
                    case .json:
                        highlighted(JSONHighlighter.attributed(body.text))
                    case .html:
                        if htmlPreview {
                            HTMLPreview(html: body.text)
                                .frame(minHeight: 240)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            highlighted(HTMLHighlighter.attributed(body.text))
                        }
                    case .text:
                        codePane(Text(body.text).font(mono).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
        }
    }

    private func highlighted(_ s: AttributedString) -> some View {
        codePane(Text(s)
            .font(mono)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading))
    }

    /// Dracula code surface: fixed dark background so token colors keep contrast.
    private func codePane<V: View>(_ content: V) -> some View {
        content
            .padding(10)
            .background(SyntaxTheme.shared.background)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(SyntaxTheme.shared.currentLine, lineWidth: 1))
    }

    private func notes(_ d: TransactionDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if (d.notes ?? []).isEmpty {
                    Text("No tools touched this transaction.").foregroundStyle(.secondary)
                } else {
                    ForEach(d.notes ?? []) { n in
                        HStack(alignment: .top, spacing: 8) {
                            Text(n.tool)
                                .font(.caption).bold()
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .glassEffect(.regular, in: .capsule)
                            Text(n.text).font(.callout).textSelection(.enabled)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(10)
        }
    }

    // MARK: helpers

    enum BodyKind { case empty, json, html, text }

    private func bodyKind(_ b: BodyPreview, contentType: String?) -> BodyKind {
        if b.text.isEmpty { return .empty }
        let ct = (contentType ?? "").lowercased()
        if ct.contains("json") || JSONHighlighter.looksLikeJSON(b.text) { return .json }
        if ct.contains("html") || ct.contains("xml") || HTMLHighlighter.looksLikeHTML(b.text) { return .html }
        return .text
    }

    private func sectionTitle(_ s: String) -> some View {
        Text(s).font(.headline)
    }

    private func headerList(_ h: [String: HeaderValue]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(h.keys.sorted(), id: \.self) { k in
                Text("\(k): \(h[k]!.description)")
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}
