import SwiftUI

/// Settings: where Node and the engine live. A GUI app does not inherit the
/// login shell PATH, so an absolute Node path is required for non-standard
/// installs (nvm, asdf, Homebrew on a custom prefix, ...).
struct SettingsView: View {
    @Environment(EngineController.self) private var engine
    @Environment(ConfigStore.self) private var config
    @AppStorage("nodePath") private var nodePath = ""
    @AppStorage("enginePath") private var enginePath = ""

    var body: some View {
        @Bindable var engine = engine
        Form {
            Section("Runtime") {
                LabeledContent("Node") {
                    VStack(alignment: .leading, spacing: 2) {
                        TextField("Auto-detect", text: $nodePath)
                            .textFieldStyle(.roundedBorder)
                        Text(detectedNode)
                            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                LabeledContent("Engine") {
                    VStack(alignment: .leading, spacing: 2) {
                        TextField("Auto-detect", text: $enginePath)
                            .textFieldStyle(.roundedBorder)
                        Text(engine.enginePath)
                            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                HStack {
                    Button("Use detected Node") { nodePath = "" }
                    Button("Reveal Node") { reveal(engine.nodePath) }
                        .disabled(engine.nodePath.isEmpty)
                }
            }
            Section("Proxy") {
                LabeledContent("Proxy port") {
                    TextField("8888", value: $engine.proxyPort, format: .number)
                        .frame(width: 90)
                }
            }
            Section("Session history (MCP)") {
                Toggle("Store calls on disk", isOn: Binding(
                    get: { config.persist.enabled ?? false },
                    set: { on in Task { await config.setPersist(on) } }))
                if let dir = config.persist.dir {
                    LabeledContent("Folder") {
                        Text(dir).font(.caption).foregroundStyle(.secondary)
                            .textSelection(.enabled).lineLimit(1)
                    }
                }
                LabeledContent("Retention") {
                    Text("\(config.persist.retentionDays ?? 7) days · bodies over \(((config.persist.maxBodyBytes ?? 0) / 1024)) KB are truncated")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack {
                    Button("Copy MCP config") { copyMCPConfig() }
                    Text("Read-only history for the louie-mcp server.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .padding()
    }

    private var detectedNode: String {
        let n = engine.nodePath
        return n.isEmpty ? "Not found — install Node or set the path above."
                         : "Detected: \(n)"
    }

    private func reveal(_ path: String) {
        guard !path.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// Registration snippet for an MCP client, pointing at louie-mcp.js next to
    /// the engine.
    private func copyMCPConfig() {
        let engineDir = (engine.enginePath as NSString).deletingLastPathComponent
        let mcp = (engineDir as NSString).appendingPathComponent("louie-mcp.js")
        let snippet = """
        {
          "mcp": {
            "louie": {
              "type": "local",
              "command": ["node", "\(mcp)"],
              "enabled": true
            }
          }
        }
        """
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(snippet, forType: .string)
    }
}
