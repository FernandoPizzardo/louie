import SwiftUI
import UniformTypeIdentifiers

/// Share tool configuration with a coworker.
///
/// **Export** writes a `.louie.json` profile containing the tool sections, and
/// optionally a set of captured calls. Captures are redacted by the *engine*
/// (using the same rules as local session history) before they are serialized,
/// so secrets never reach the file.
///
/// **Import** never applies anything blindly: it inspects the file first and
/// shows exactly which sections and captures it carries, then merges only the
/// sections the user ticks. A profile can switch tools on but never off, so
/// importing someone else's setup cannot disable your own.
struct ShareView: View {
    @Environment(ConfigStore.self) private var config
    @Environment(SessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    private enum Mode: String, CaseIterable { case export = "Export", importFile = "Import" }
    @State private var mode: Mode = .export

    // export
    @State private var profileName = ""
    @State private var includeCaptures = false
    @State private var includeFullBodies = false
    @State private var exportStatus: String?

    // import
    @State private var importData: Data?
    @State private var importFileName: String?
    @State private var inspect: ProfileInspect?
    @State private var selected: Set<String> = []
    @State private var importStatus: String?
    @State private var importing = false

    private let mono = Font.system(.body, design: .monospaced)

    private static let sectionLabels: [(key: String, label: String)] = [
        ("enabled", "Tool on/off switches"),
        ("blocklist", "Block List"),
        ("mapRemote", "Map Remote"),
        ("mapLocal", "Map Local"),
        ("rewrite", "Rewrite"),
        ("throttle", "Throttle"),
        ("breakpoints", "Breakpoints"),
        ("sslLocations", "SSL Proxying locations"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Picker("", selection: $mode) {
                ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if mode == .export { exportPane } else { importPane }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
        }
        .frame(minWidth: 640, minHeight: 520)
        .onAppear {
            if profileName.isEmpty {
                profileName = "\(NSFullUserName()) – shared setup"
            }
        }
    }

    // MARK: header

    private var header: some View {
        HStack {
            Image(systemName: "person.2")
                .font(.title2)
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("Share a profile").font(.headline)
                Text("Hand a coworker your tools and captured calls.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Done") { dismiss() }
        }
        .padding(12)
    }

    // MARK: export

    private var exportPane: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Name").font(.headline)
                TextField("Team staging setup", text: $profileName)
                    .textFieldStyle(.roundedBorder)
            }

            GroupBox("What gets shared") {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Self.sectionLabels, id: \.key) { item in
                        Label(item.label, systemImage: "checkmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Text("The CA key, the control-API token and your local paths are never included.")
                        .font(.caption2).foregroundStyle(.secondary).padding(.top, 4)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            GroupBox("Captured calls") {
                VStack(alignment: .leading, spacing: 8) {
                    Toggle("Include the \(store.rows.count) captured call(s) in this session", isOn: $includeCaptures)
                    if includeCaptures {
                        Text("Captures are **redacted before they are written**: Authorization, Cookie, Set-Cookie and common token/password fields are replaced. Calls held by a breakpoint are skipped.")
                            .font(.caption).foregroundStyle(.secondary)
                        Toggle("Keep bodies over the size cap", isOn: $includeFullBodies)
                            .font(.callout)
                        Text("Larger files are harder to review — prefer leaving this off when sharing broadly.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack {
                if let s = exportStatus {
                    Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer()
                Button("Save profile…") { Task { await doExport() } }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func doExport() async {
        exportStatus = nil
        guard let result = await config.exportProfile(
            name: profileName.isEmpty ? nil : profileName,
            includeCaptures: includeCaptures,
            full: includeFullBodies) else {
            exportStatus = config.lastError ?? "export failed"
            return
        }
        // A save panel is the only way to choose a destination, so ask after the
        // engine has produced (and redacted) the document.
        let panel = NSSavePanel()
        panel.nameFieldStringValue = result.fileName
        panel.allowedContentTypes = [.json]
        panel.title = "Save shared profile"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else {
            exportStatus = "Cancelled — nothing was written."
            return
        }
        do {
            try result.data.write(to: url, options: .atomic)
            exportStatus = "Saved \(url.lastPathComponent). Review it before sending — sharing is your call."
        } catch {
            exportStatus = "Could not write the file: \(error.localizedDescription)"
        }
    }

    // MARK: import

    private var importPane: some View {
        VStack(alignment: .leading, spacing: 14) {
            if inspect == nil {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Pick a `.louie.json` profile someone shared with you.")
                            .font(.callout)
                        Text("You will see what it contains before anything is applied.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Choose file…") { chooseFile() }
                            .buttonStyle(.borderedProminent)
                        if let s = importStatus {
                            Text(s).font(.caption).foregroundStyle(.red)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if let info = inspect?.info {
                GroupBox("From \(info.name ?? "unnamed profile")") {
                    VStack(alignment: .leading, spacing: 6) {
                        if let at = info.exportedAt {
                            Text("Exported \(at)\(info.louieVersion.map { " · Louie \($0)" } ?? "")")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        ForEach(Self.sectionLabels, id: \.key) { item in
                            if let count = info.sections[item.key] {
                                Toggle(isOn: binding(for: item.key)) {
                                    HStack {
                                        Text(item.label)
                                        Text(count == 1 ? "1 entry" : "\(count) entries")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if let caps = inspect?.captures, !caps.isEmpty {
                    GroupBox("Captured calls (\(caps.count))") {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(caps.prefix(40)) { c in
                                HStack(spacing: 8) {
                                    Text(c.status.map(String.init) ?? "—")
                                        .font(.system(.caption2, design: .monospaced))
                                        .frame(width: 30, alignment: .leading)
                                    Text(c.title)
                                        .font(.system(.caption, design: .monospaced))
                                        .lineLimit(1)
                                    Spacer()
                                    if let notes = c.notes, !notes.isEmpty {
                                        Text(notes.joined(separator: ", "))
                                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                            }
                            if caps.count > 40 {
                                Text("… and \(caps.count - 40) more")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Text("Captured calls are shown for reference; they are not imported into your session.")
                                .font(.caption2).foregroundStyle(.secondary).padding(.top, 4)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let warnings = importWarnings, !warnings.isEmpty {
                    GroupBox("Before you import") {
                        VStack(alignment: .leading, spacing: 4) {
                            ForEach(warnings, id: \.self) { w in
                                Label(w, systemImage: "exclamationmark.triangle")
                                    .font(.caption).foregroundStyle(.orange)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                HStack {
                    Button("Choose another…") { chooseFile() }
                    Spacer()
                    if let s = importStatus {
                        Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    Button(importing ? "Importing…" : "Import \(selected.count) section(s)") {
                        Task { await doImport() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected.isEmpty || importing)
                }
            }
        }
    }

    private var importWarnings: [String]? {
        // Surface the engine's own warnings for the sections currently selected.
        inspectWarnings.filter { w in
            !w.contains("Breakpoints") || selected.contains("breakpoints")
        }
    }

    /// Engine-side warnings are produced at apply time; we pre-compute the two
    /// that matter most by inspecting the file client-side.
    private var inspectWarnings: [String] {
        var out: [String] = []
        if selected.contains("breakpoints"), (inspect?.info?.sections["breakpoints"] ?? 0) > 0 {
            out.append("Breakpoints arrive switched off — they will pause matching traffic once enabled.")
        }
        if selected.contains("mapLocal"), (inspect?.info?.sections["mapLocal"] ?? 0) > 0 {
            out.append("Map Local paths from another machine may not exist here; requests will fall through.")
        }
        return out
    }

    private func binding(for key: String) -> Binding<Bool> {
        Binding(
            get: { selected.contains(key) },
            set: { on in
                if on { selected.insert(key) } else { selected.remove(key) }
            })
    }

    private func chooseFile() {
        importStatus = nil
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.title = "Choose a Louie profile"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard let data = try? Data(contentsOf: url) else {
            importStatus = "Could not read that file."
            return
        }
        importFileName = url.lastPathComponent
        importData = data
        Task {
            let result = await config.inspectProfile(data)
            guard let result, result.ok, let info = result.info else {
                importStatus = result?.error ?? config.lastError ?? "That is not a Louie profile."
                inspect = nil
                return
            }
            inspect = result
            // Default to everything the file actually carries.
            selected = Set(info.sections.keys.filter { key in
                Self.sectionLabels.contains { $0.key == key }
            })
        }
    }

    private func doImport() async {
        guard let data = importData else { return }
        importing = true
        defer { importing = false }
        let result = await config.importProfile(data, sections: Array(selected))
        if let r = result, r.ok {
            let applied = (r.applied ?? []).joined(separator: ", ")
            var msg = "Imported \(applied.isEmpty ? "nothing" : applied)."
            if let w = r.warnings, !w.isEmpty { msg += " " + w.joined(separator: " ") }
            importStatus = msg + " Tools reloaded."
        } else {
            importStatus = result?.error ?? config.lastError ?? "import failed"
        }
    }
}
