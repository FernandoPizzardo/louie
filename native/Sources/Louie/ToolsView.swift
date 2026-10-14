import SwiftUI
import AppKit

/// Native tool editors. Each section mirrors a Charles tool; saving posts the
/// whole config subset to the engine (which replaces each section wholesale).
struct ToolsView: View {
    @Environment(ConfigStore.self) private var config
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var config = config
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Tools").font(.title2).bold()
                    Spacer()
                    if let err = config.lastError {
                        Text(err).foregroundStyle(.red).font(.caption)
                    }
                    Button("Import from Charles…") { Task { await config.importFromCharles() } }
                    Button("Cancel") { dismiss() }
                    Button("Save") { Task { await config.save(); dismiss() } }
                        .buttonStyle(.borderedProminent)
                }
                if let m = config.importMessage {
                    Text(m).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    blockListSection(config: config)
                    mapRemoteSection(config: config)
                    mapLocalSection(config: config)
                    rewriteSection(config: config)
                    throttleSection(config: config)
                    sslSection(config: config)
                    noCacheSection(config: config)
                }
                .padding(14)
            }
        }
        .frame(minWidth: 720, minHeight: 560)
        .task { if !config.loaded { await config.load() } }
    }

    // MARK: Block List

    private func blockListSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            ForEach(config.draft.blocklist.indices, id: \.self) { i in
                HStack {
                    TextField("host", text: Binding(
                        get: { config.draft.blocklist[i].host ?? "" },
                        set: { config.draft.blocklist[i].host = $0.isEmpty ? nil : $0 }))
                    TextField("port", text: portBinding(Binding(
                        get: { config.draft.blocklist[i].port },
                        set: { config.draft.blocklist[i].port = $0 }))).frame(width: 70)
                    TextField("path", text: Binding(
                        get: { config.draft.blocklist[i].path ?? "" },
                        set: { config.draft.blocklist[i].path = $0.isEmpty ? nil : $0 }))
                    Button(role: .destructive) { config.draft.blocklist.remove(at: i) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                }
            }
            Button("Add location") { config.draft.blocklist.append(Location()) }
        } label: {
            HStack {
                Toggle("Block List", isOn: $config.draft.enabled.blocklist)
                Spacer()
                Picker("Action", selection: $config.draft.blockAction) {
                    Text("Drop connection").tag("drop")
                    Text("Return 403 response").tag("403")
                }.frame(width: 220)
            }
        }
    }

    // MARK: Map Remote

    private func mapRemoteSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            ForEach(config.draft.mapRemote.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("From").font(.caption).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
                        TextField("host", text: binding($config.draft.mapRemote[i].from.host))
                        TextField("port", text: portBinding(Binding(get: { config.draft.mapRemote[i].from.port },
                                                          set: { config.draft.mapRemote[i].from.port = $0 }))).frame(width: 70)
                        TextField("path", text: binding($config.draft.mapRemote[i].from.path))
                    }
                    HStack {
                        Text("To").font(.caption).foregroundStyle(.secondary).frame(width: 40, alignment: .leading)
                        TextField("protocol", text: binding($config.draft.mapRemote[i].to.scheme)).frame(width: 90)
                        TextField("host", text: binding($config.draft.mapRemote[i].to.host))
                        TextField("port", text: portBinding(Binding(get: { config.draft.mapRemote[i].to.port },
                                                          set: { config.draft.mapRemote[i].to.port = $0 }))).frame(width: 70)
                        TextField("path", text: binding($config.draft.mapRemote[i].to.path))
                        TextField("query (-  deletes)", text: binding($config.draft.mapRemote[i].to.query))
                        Button(role: .destructive) { config.draft.mapRemote.remove(at: i) } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                    }
                }
            }
            Button("Add mapping") {
                config.draft.mapRemote.append(MapRemoteRule(from: Location(), to: Location()))
            }
        } label: {
            Toggle("Map Remote", isOn: $config.draft.enabled.mapRemote)
        }
    }

    // MARK: Map Local

    private func mapLocalSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            ForEach(config.draft.mapLocal.indices, id: \.self) { i in
                HStack {
                    TextField("host", text: Binding(
                        get: { config.draft.mapLocal[i].location.host ?? "" },
                        set: { config.draft.mapLocal[i].location.host = $0.isEmpty ? nil : $0 }))
                    TextField("port", text: portBinding(Binding(get: { config.draft.mapLocal[i].location.port },
                                                      set: { config.draft.mapLocal[i].location.port = $0 }))).frame(width: 70)
                    TextField("path", text: Binding(
                        get: { config.draft.mapLocal[i].location.path ?? "" },
                        set: { config.draft.mapLocal[i].location.path = $0.isEmpty ? nil : $0 }))
                    TextField("local path", text: Binding(
                        get: { config.draft.mapLocal[i].localPath },
                        set: { config.draft.mapLocal[i].localPath = $0 }))
                    Button("…") { pickLocalPath(index: i) }
                    Toggle("case", isOn: Binding(
                        get: { config.draft.mapLocal[i].caseSensitive ?? false },
                        set: { config.draft.mapLocal[i].caseSensitive = $0 }))
                    Button(role: .destructive) { config.draft.mapLocal.remove(at: i) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                }
            }
            Button("Add mapping") {
                config.draft.mapLocal.append(MapLocalRule(location: Location(), localPath: "", contentType: nil, caseSensitive: false))
            }
        } label: {
            Toggle("Map Local", isOn: $config.draft.enabled.mapLocal)
        }
    }

    // MARK: Rewrite

    private func rewriteSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            ForEach(config.draft.rewrite.indices, id: \.self) { si in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Toggle("Set", isOn: $config.draft.rewrite[si].enabled)
                        TextField("host", text: Binding(
                            get: { config.draft.rewrite[si].location?.host ?? "" },
                            set: { config.draft.rewrite[si].location = merge($0, config.draft.rewrite[si].location) }))
                        Button(role: .destructive) { config.draft.rewrite.remove(at: si) } label: { Image(systemName: "trash") }
                            .buttonStyle(.borderless)
                    }
                    ForEach(config.draft.rewrite[si].rules.indices, id: \.self) { ri in
                        HStack {
                            Picker("", selection: $config.draft.rewrite[si].rules[ri].type) {
                                Text("req").tag("request"); Text("res").tag("response"); Text("both").tag("both")
                            }.labelsHidden().frame(width: 80)
                            Picker("", selection: $config.draft.rewrite[si].rules[ri].target) {
                                Text("header").tag("header"); Text("body").tag("body")
                                Text("status").tag("status"); Text("path").tag("path")
                            }.labelsHidden().frame(width: 100)
                            TextField("name", text: Binding(
                                get: { config.draft.rewrite[si].rules[ri].name ?? "" },
                                set: { config.draft.rewrite[si].rules[ri].name = $0.isEmpty ? nil : $0 }))
                            TextField("match", text: Binding(
                                get: { config.draft.rewrite[si].rules[ri].match ?? "" },
                                set: { config.draft.rewrite[si].rules[ri].match = $0.isEmpty ? nil : $0 }))
                            TextField("replace", text: Binding(
                                get: { config.draft.rewrite[si].rules[ri].replace ?? "" },
                                set: { config.draft.rewrite[si].rules[ri].replace = $0.isEmpty ? nil : $0 }))
                            Button(role: .destructive) { config.draft.rewrite[si].rules.remove(at: ri) } label: { Image(systemName: "minus.circle") }
                                .buttonStyle(.borderless)
                        }
                    }
                    Button("Add rule") {
                        config.draft.rewrite[si].rules.append(
                            RewriteRule(type: "response", target: "body", action: "modify", name: nil, match: nil, replace: nil, flags: "g"))
                    }
                }
                .padding(.vertical, 4)
            }
            Button("Add rewrite set") {
                config.draft.rewrite.append(RewriteSet(enabled: true, location: Location(host: "*"), rules: []))
            }
        } label: {
            Toggle("Rewrite", isOn: $config.draft.enabled.rewrite)
        }
    }

    // MARK: Throttle

    private func throttleSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            HStack {
                Text("Latency (ms)")
                TextField("0", value: $config.draft.throttle.latency, format: .number).frame(width: 80)
                Text("Down (KB/s)")
                TextField("0", value: $config.draft.throttle.bandwidthDown, format: .number).frame(width: 80)
                Text("Up (KB/s)")
                TextField("0", value: $config.draft.throttle.bandwidthUp, format: .number).frame(width: 80)
            }
            Text("Empty host list applies to all requests.")
                .font(.caption).foregroundStyle(.secondary)
        } label: {
            Toggle("Throttle", isOn: $config.draft.enabled.throttle)
        }
    }

    // MARK: SSL

    private func sslSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Root CA").font(.caption).foregroundStyle(.secondary)
                    if let ca = config.ca {
                        Text(ca.trusted ? "trusted" : "not trusted")
                            .font(.caption).bold()
                            .foregroundStyle(ca.trusted ? .green : .orange)
                    }
                    Spacer()
                    Button("Refresh") { Task { await config.refreshCA() } }
                    Button("Trust in Keychain…") { Task { await config.trustCA() } }
                        .disabled(config.ca == nil)
                }
                if let ca = config.ca {
                    Text(ca.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    if let s = ca.subject { Text(s).font(.caption).lineLimit(1) }
                    if let f = ca.fingerprint {
                        Text("SHA-256 \(f)").font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
                    }
                } else {
                    Text("Start the engine to load the CA.").font(.caption).foregroundStyle(.secondary)
                }
                if let m = config.trustMessage { Text(m).font(.caption).foregroundStyle(.secondary) }
                Text("Trusting installs the root in your login keychain; macOS may ask for authorization.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Divider()
            ForEach(config.draft.sslLocations.indices, id: \.self) { i in
                HStack {
                    TextField("host", text: Binding(
                        get: { config.draft.sslLocations[i].host ?? "" },
                        set: { config.draft.sslLocations[i].host = $0.isEmpty ? nil : $0 }))
                    TextField("port", text: portBinding(Binding(get: { config.draft.sslLocations[i].port },
                                                      set: { config.draft.sslLocations[i].port = $0 }))).frame(width: 70)
                    Button(role: .destructive) { config.draft.sslLocations.remove(at: i) } label: { Image(systemName: "trash") }
                        .buttonStyle(.borderless)
                }
            }
            Button("Add SSL location") { config.draft.sslLocations.append(Location(host: "", port: 443)) }
        } label: {
            Text("SSL Proxying locations")
        }
    }

    private func noCacheSection(config: ConfigStore) -> some View {
        @Bindable var config = config
        return GroupBox {
            Text("Strip request/response caching headers.")
                .font(.caption).foregroundStyle(.secondary)
        } label: {
            Toggle("No Cache", isOn: $config.draft.enabled.noCache)
        }
    }

    // MARK: helpers

    private func binding(_ source: Binding<String?>) -> Binding<String> {
        Binding(get: { source.wrappedValue ?? "" },
                set: { source.wrappedValue = $0.isEmpty ? nil : $0 })
    }

    /// TextField binding for an optional port (String <-> Int?).
    private func portBinding(_ source: Binding<Int?>) -> Binding<String> {
        Binding(get: { source.wrappedValue.map(String.init) ?? "" },
                set: { source.wrappedValue = Int($0.trimmingCharacters(in: .whitespaces)) })
    }

    private func merge(_ host: String, _ existing: Location?) -> Location? {
        if host.isEmpty && existing == nil { return nil }
        var l = existing ?? Location()
        l.host = host.isEmpty ? nil : host
        return l
    }

    private func pickLocalPath(index: Int) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            config.draft.mapLocal[index].localPath = url.path
        }
    }
}
