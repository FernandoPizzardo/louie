import SwiftUI

/// Settings: where Node and the engine live. A GUI app does not inherit the
/// login shell PATH, so an absolute Node path is required for non-standard
/// installs (nvm, asdf, Homebrew on a custom prefix, ...).
struct SettingsView: View {
    @Environment(EngineController.self) private var engine
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
}
