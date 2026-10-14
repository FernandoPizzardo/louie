import SwiftUI

struct ContentView: View {
    @Environment(EngineController.self) private var engine
    @Environment(SessionStore.self) private var store
    @Environment(ConfigStore.self) private var config
    @State private var showTools = false

    var body: some View {
        @Bindable var engine = engine
        @Bindable var store = store

        VStack(spacing: 0) {
            header(engine: engine)
            Divider()
            toolbar(store: store)
            Divider()
            HSplitView {
                table(store: store)
                    .frame(minWidth: 420)
                InspectorView()
                    .frame(minWidth: 320)
            }
        }
        .onChange(of: engine.info) { _, info in
            if let control = engine.control {
                store.attach(control)
                config.attach(control)
            } else {
                store.detach()
                config.detach()
            }
        }
        .sheet(isPresented: $showTools) {
            ToolsView().environment(config)
        }
    }

    // MARK: header

    private func header(engine: EngineController) -> some View {
        @Bindable var engine = engine
        return HStack(spacing: 12) {
            Circle().fill(statusColor(engine.status)).frame(width: 10, height: 10)
            Text(engine.status.label).font(.headline)
            Text("· \(store.rows.count) transactions").foregroundStyle(.secondary)
            Spacer()
            HStack(spacing: 6) {
                Text("Proxy port")
                TextField("8888", value: $engine.proxyPort, format: .number)
                    .frame(width: 70).textFieldStyle(.roundedBorder)
                    .disabled(engine.status == .running || engine.status == .starting)
            }
            if engine.status == .running || engine.status == .starting {
                Button("Stop") { engine.stop() }
            } else {
                Button("Start") { engine.start() }.buttonStyle(.borderedProminent)
            }
        }
        .padding(12)
    }

    private func statusColor(_ s: EngineController.Status) -> Color {
        switch s {
        case .running: return .green
        case .starting: return .yellow
        case .failed: return .red
        case .stopped: return .secondary
        }
    }

    // MARK: toolbar

    private func toolbar(store: SessionStore) -> some View {
        @Bindable var store = store
        return HStack(spacing: 10) {
            TextField("Filter", text: $store.filter)
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 240)
            Toggle("SSL only", isOn: $store.onlySSL)
            Spacer()
            Circle().fill(store.connected ? Color.green : Color.secondary).frame(width: 8, height: 8)
            Text(store.connected ? "live" : "offline").foregroundStyle(.secondary).font(.caption)
            Button(store.recording ? "● Recording" : "○ Paused") {
                Task { await store.setRecording(!store.recording) }
            }
            Button("Tools…") { showTools = true }
            Button("Clear") { Task { await store.clear() } }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    // MARK: table

    private func table(store: SessionStore) -> some View {
        @Bindable var store = store
        return Table(store.filtered, selection: $store.selectedID) {
            TableColumn("Status") { s in
                Text(s.statusText)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(color(for: s))
            }.width(60)
            TableColumn("Method") { s in Text(s.method ?? "").font(.system(.caption, design: .monospaced)) }.width(60)
            TableColumn("Host") { s in Text(s.hostAndPort).lineLimit(1) }
            TableColumn("Path") { s in Text(s.path ?? "").lineLimit(1) }.width(min: 120)
            TableColumn("ms") { s in Text(s.durationMs.map(String.init) ?? "") }.width(50)
            TableColumn("Size") { s in Text(human(s.resSize)) }.width(70)
            TableColumn("Tools") { s in
                Text((s.notes ?? []).map(\.tool).joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }.width(min: 80)
        }
    }

    private func color(for s: TransactionSummary) -> Color {
        if s.error != nil { return .red }
        switch s.status ?? 0 {
        case 200..<300: return .green
        case 300..<400: return .blue
        case 400..<500: return .orange
        case 500...: return .red
        default: return .secondary
        }
    }
}

func human(_ n: Int?) -> String {
    guard let n, n > 0 else { return "" }
    if n > 1_048_576 { return String(format: "%.1f MB", Double(n) / 1_048_576) }
    if n > 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
    return "\(n) B"
}
