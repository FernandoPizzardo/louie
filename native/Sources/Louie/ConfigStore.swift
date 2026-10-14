import Foundation
import Observation

/// Loads and saves the tool configuration through the control API.
@MainActor
@Observable
final class ConfigStore {
    var draft = ToolConfig()
    private(set) var loaded = false
    private(set) var lastError: String?
    private(set) var ca: CAInfo?
    private(set) var trustMessage: String?
    private(set) var importMessage: String?
    private(set) var persist = PersistInfo()
    private(set) var net = NetInfo()

    private var control: ControlClient?

    func attach(_ control: ControlClient) {
        self.control = control
        Task { await load(); await refreshCA(); await loadPersist(); await refreshNet() }
    }

    func refreshNet() async {
        net = (try? await control?.getJSON("/api/net", as: NetInfo.self)) ?? NetInfo()
    }

    /// Turn LAN exposure on or off (re-binds the proxy). Off by default.
    func setLAN(_ on: Bool) async {
        _ = try? await control?.postCodable("/api/lan", OnPatch(on: on), as: OkResponse.self)
        await refreshNet()
    }

    /// Start/stop the CA-serving listener (only the public cert is served).
    func serveCA(_ on: Bool) async {
        _ = try? await control?.postCodable("/api/ca/serve", OnPatch(on: on), as: CAServeResult.self)
        await refreshNet()
    }

    func loadPersist() async {
        persist = (try? await control?.getJSON("/api/persist", as: PersistInfo.self)) ?? PersistInfo()
    }

    func setPersist(_ on: Bool) async {
        _ = try? await control?.postCodable("/api/persist", PersistPatch(enabled: on), as: OkResponse.self)
        await loadPersist()
    }

    func detach() { control = nil; loaded = false; draft = ToolConfig(); ca = nil; trustMessage = nil }

    func refreshCA() async {
        ca = try? await control?.getJSON("/api/ca", as: CAInfo.self)
    }

    /// User-initiated. macOS may prompt to authorize adding the trusted root.
    func trustCA() async {
        guard let control else { return }
        do {
            let r = try await control.postJSON("/api/ca/trust", json: [:], as: TrustResult.self)
            trustMessage = r.ok ? "Added to the keychain" : (r.error ?? "failed")
        } catch {
            trustMessage = "trust failed: \(error.localizedDescription)"
        }
        await refreshCA()
    }

    /// Import settings from the real Charles app (optionally from a specific XML).
    func importFromCharles(path: String? = nil) async {
        guard let control else { return }
        do {
            let r: ImportResult
            if let path {
                r = try await control.postJSON("/api/import/charles", json: ["path": path], as: ImportResult.self)
            } else {
                r = try await control.postJSON("/api/import/charles", json: [:], as: ImportResult.self)
            }
            if r.ok, let s = r.summary {
                var msg = "Imported \(s.sslLocations ?? 0) SSL locations, \(s.mapRemote ?? 0) Map Remote, \(s.throttleHosts ?? 0) throttle hosts"
                if let w = r.warnings, !w.isEmpty { msg += " · " + w.joined(separator: " ") }
                importMessage = msg
            } else {
                importMessage = r.error ?? "import failed"
            }
        } catch {
            importMessage = "import failed: \(error.localizedDescription)"
        }
        await load()
        await refreshCA()
    }

    func load() async {
        guard let control else { return }
        do {
            let data = try await control.getData("/api/config")
            draft = try JSONDecoder().decode(ToolConfig.self, from: data)
            loaded = true
        } catch {
            lastError = "load failed: \(error.localizedDescription)"
        }
    }

    func save() async {
        guard let control else { return }
        do {
            let data = try JSONEncoder().encode(draft)
            try await control.postData("/api/config", data)
            lastError = nil
            await load()
        } catch {
            lastError = "save failed: \(error.localizedDescription)"
        }
    }
}
