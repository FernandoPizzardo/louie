import SwiftUI

/// The breakpoint editor: a modal that appears when a rule suspends a
/// transaction so the request (or response) can be inspected, edited, resumed
/// or dropped before it continues on its way.
///
/// Everything is held in local `@State` while the sheet is open; nothing is
/// posted to the engine until Continue (with edits) or Abort is pressed.
struct BreakpointView: View {
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let hit: BreakpointHit

    // Editable state, seeded from the hit.
    @State private var method = "GET"
    @State private var url = ""
    @State private var reqHeaders: [HeaderRow] = []
    @State private var reqBody = ""
    @State private var status = 200
    @State private var resHeaders: [HeaderRow] = []
    @State private var resBody = ""
    @State private var showRawBody = false

    private let mono = Font.system(.body, design: .monospaced)

    /// One editable header line. Kept as an array so ordering/duplicates survive
    /// the round-trip through SwiftUI's `ForEach`.
    struct HeaderRow: Identifiable, Equatable {
        let id = UUID()
        var name: String
        var value: String
    }

    private var isRequest: Bool { hit.phase == "request" }
    private var currentTitle: String { isRequest ? "Request" : "Response" }
    private var otherTitle: String { isRequest ? "Response" : "Request" }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if isRequest { requestEditor } else { responseEditor }
                    readOnlySummary
                }
                .padding(14)
            }
            Divider()
            actionBar
        }
        .frame(minWidth: 760, minHeight: 580)
        .onAppear(perform: seed)
        .onChange(of: hit.id) { _, _ in seed() }
    }

    // MARK: header

    private var headerBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "pause.circle.fill")
                .foregroundStyle(.orange)
                .font(.title2)
            VStack(alignment: .leading, spacing: 2) {
                Text("Breakpoint · \(currentTitle)")
                    .font(.headline)
                Text(hit.summary.summaryLine)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if let remaining = secondsRemaining {
                Text("auto-continues in \(remaining)s")
                    .font(.caption)
                    .foregroundStyle(remaining <= 10 ? .red : .secondary)
            }
            if store.pendingBreakpoints.count > 1 {
                Text("\(store.pendingBreakpoints.count) queued")
                    .font(.caption)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .glassEffect(.regular, in: .capsule)
            }
        }
        .padding(12)
    }

    /// Seconds until the engine releases the transaction on its own.
    private var secondsRemaining: Int? {
        guard let deadline = hit.deadline else { return nil }
        let ms = deadline - Date().timeIntervalSince1970 * 1000
        return ms > 0 ? Int((ms / 1000).rounded(.up)) : nil
    }

    // MARK: request editor

    private var requestEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Picker("", selection: $method) {
                    ForEach(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"], id: \.self) {
                        Text($0).tag($0)
                    }
                }
                .labelsHidden()
                .frame(width: 110)
                TextField("https://host/path", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .font(mono)
            }
            headerEditor(title: "Request headers", rows: $reqHeaders)
            bodyEditor(title: "Request body", text: $reqBody,
                       editable: hit.request.body?.editable ?? true,
                       kind: hit.request.body?.type ?? "empty")
        }
    }

    // MARK: response editor

    private var responseEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Text("Status").foregroundStyle(.secondary)
                TextField("200", value: $status, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                    .font(mono)
                Text(statusText(status)).foregroundStyle(.secondary).font(.caption)
                Spacer()
            }
            headerEditor(title: "Response headers", rows: $resHeaders)
            bodyEditor(title: "Response body", text: $resBody,
                       editable: hit.response.body?.editable ?? true,
                       kind: hit.response.body?.type ?? "empty")
        }
    }

    // MARK: shared editors

    private func headerEditor(title: String, rows: Binding<[HeaderRow]>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Button("Add header") {
                    rows.wrappedValue.append(HeaderRow(name: "", value: ""))
                }
                .controlSize(.small)
            }
            if rows.wrappedValue.isEmpty {
                Text("(none)").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(rows.wrappedValue.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    TextField("name", text: rows[i].name)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                        .frame(width: 220)
                    TextField("value", text: rows[i].value)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.caption, design: .monospaced))
                    Button(role: .destructive) {
                        rows.wrappedValue.remove(at: i)
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                }
            }
        }
    }

    private func bodyEditor(title: String, text: Binding<String>, editable: Bool, kind: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.headline)
                if kind == "binary" { Text("binary — read only").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if editable {
                    Text("\(text.wrappedValue.utf8.count) B").font(.caption).foregroundStyle(.secondary)
                    Button("Format JSON") { formatJSON(text) }
                        .controlSize(.small)
                        .disabled(!JSONHighlighter.looksLikeJSON(text.wrappedValue))
                }
            }
            if kind == "empty" {
                Text("(empty)").font(mono).foregroundStyle(.secondary)
            } else if editable {
                TextEditor(text: text)
                    .font(mono)
                    .frame(minHeight: 170)
                    .padding(6)
                    .background(SyntaxTheme.shared.background)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(SyntaxTheme.shared.currentLine, lineWidth: 1))
            } else {
                ScrollView {
                    Text(text.wrappedValue)
                        .font(mono)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 120)
                .background(SyntaxTheme.shared.background)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    /// The side of the transaction that is not being edited, shown read-only for
    /// context (Charles shows both panes at once).
    private var readOnlySummary: some View {
        GroupBox("\(otherTitle) (not editable in this phase)") {
            VStack(alignment: .leading, spacing: 4) {
                if isRequest {
                    Text("Status \(hit.response.status ?? 0)").font(.caption).foregroundStyle(.secondary)
                    Text(summarize(hit.response.headers)).font(.system(.caption, design: .monospaced))
                } else {
                    Text("\(hit.request.method ?? "") \(hit.request.url ?? "")")
                        .font(.system(.caption, design: .monospaced))
                    Text(summarize(hit.request.headers)).font(.system(.caption2, design: .monospaced))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func summarize(_ headers: [String: String]?) -> String {
        guard let headers, !headers.isEmpty else { return "(no headers)" }
        return headers.keys.sorted().prefix(12).map { "\($0): \(headers[$0] ?? "")" }.joined(separator: "\n")
    }

    // MARK: actions

    private var actionBar: some View {
        HStack(spacing: 10) {
            Button("Abort", role: .destructive) {
                Task {
                    await store.abortBreakpoint(hit.id)
                    dismissIfDone()
                }
            }
            Spacer()
            Button("Continue") {
                Task {
                    await store.continueBreakpoint(hit.id)
                    dismissIfDone()
                }
            }
            .keyboardShortcut(.defaultAction)
            Button("Continue with edits") {
                Task {
                    await store.applyBreakpointEdit(hit.id, edit: makeEdit())
                    dismissIfDone()
                }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut("e", modifiers: [.command])
        }
        .padding(12)
    }

    private func dismissIfDone() {
        if store.editingBreakpoint == nil { dismiss() }
    }

    /// Build the edit payload from the state that matches this phase.
    private func makeEdit() -> BreakpointEdit {
        if isRequest {
            return BreakpointEdit(
                request: BreakpointEdit.Request(
                    method: method,
                    url: url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : url,
                    headers: dictionary(from: reqHeaders),
                    body: bodyPayload(reqBody, original: hit.request.body)),
                response: nil)
        }
        return BreakpointEdit(
            request: nil,
            response: BreakpointEdit.Response(
                status: status,
                headers: dictionary(from: resHeaders),
                body: bodyPayload(resBody, original: hit.response.body)))
    }

    /// Send the body only when it actually changed, so a binary or oversized
    /// body is never round-tripped by accident.
    private func bodyPayload(_ text: String, original: BreakpointBody?) -> BreakpointBody? {
        guard let original, original.editable == true else { return nil }
        guard text != original.text else { return nil }
        return BreakpointBody(type: text.isEmpty ? "empty" : "text", text: text)
    }

    private func dictionary(from rows: [HeaderRow]) -> [String: String]? {
        var out: [String: String] = [:]
        for r in rows {
            let name = r.name.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { continue }
            out[name] = r.value
        }
        return out.isEmpty ? nil : out
    }

    private func seed() {
        method = hit.request.method ?? "GET"
        url = hit.request.url ?? ""
        reqHeaders = rows(from: hit.request.headers)
        reqBody = hit.request.body?.text ?? ""
        status = hit.response.status ?? 200
        resHeaders = rows(from: hit.response.headers)
        resBody = hit.response.body?.text ?? ""
    }

    private func rows(from headers: [String: String]?) -> [HeaderRow] {
        (headers ?? [:]).keys.sorted().map { HeaderRow(name: $0, value: headers?[$0] ?? "") }
    }

    private func formatJSON(_ text: Binding<String>) {
        let data = Data(text.wrappedValue.utf8)
        guard let obj = try? JSONSerialization.jsonObject(with: data),
              let pretty = try? JSONSerialization.data(withJSONObject: obj,
                                                       options: [.prettyPrinted, .sortedKeys]),
              let s = String(data: pretty, encoding: .utf8) else { return }
        text.wrappedValue = s
    }

    private func statusText(_ code: Int) -> String {
        HTTPURLResponse.localizedString(forStatusCode: code).capitalized
    }
}
