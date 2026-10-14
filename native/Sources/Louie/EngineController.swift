import Foundation
import Observation
import AppKit

/// Owns the Node engine child process and publishes its lifecycle state.
@MainActor
@Observable
final class EngineController {
    enum Status: Equatable {
        case stopped
        case starting
        case running
        case failed(String)

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting…"
            case .running: return "Running"
            case .failed(let m): return "Failed: \(m)"
            }
        }
    }

    private(set) var status: Status = .stopped
    private(set) var info: EngineInfo?
    private(set) var log: [String] = []

    var proxyPort: Int = 8888

    /// The app keeps its own config so it never overwrites the CLI's
    /// ~/.charles-clone/config.json (or the real Charles app's support dir).
    var configFile: String = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("Louie/config.json").path
    }()

    private var process: Process?
    private var stdoutBuffer = Data()
    private var terminateObserver: NSObjectProtocol?

    init() {
        // Stop the child engine when the app quits, so it is never orphaned.
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.stop() }
        }
    }

    // MARK: Node resolution

    /// User override, else auto-detected absolute path to `node`.
    var nodePath: String {
        EngineController.resolveNodePath(
            savedPath: UserDefaults.standard.string(forKey: "nodePath"),
            pathEnv: ProcessInfo.processInfo.environment["PATH"]
        ) ?? ""
    }

    /// Resolve an absolute path to the `node` binary.
    ///
    /// A GUI app launched from Finder/Dock does NOT inherit the login shell PATH
    /// (only `/usr/bin:/bin:/usr/sbin:/sbin`), so relying on PATH alone yields
    /// `/usr/bin/env: node: No such file or directory` (exit 127). We therefore
    /// prefer known absolute locations.
    nonisolated static func resolveNodePath(savedPath: String?, pathEnv: String?) -> String? {
        let fm = FileManager.default
        func usable(_ p: String?) -> String? {
            guard let p, !p.isEmpty, fm.isExecutableFile(atPath: p) else { return nil }
            return p
        }
        // 1. explicit setting
        if let p = usable(savedPath) { return p }
        // 2. common absolute locations
        let home = NSHomeDirectory()
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.local/bin/node",
            "/usr/bin/node",
        ]
        for c in candidates { if let p = usable(c) { return p } }
        // 3. nvm (newest installed version)
        let nvmDir = "\(home)/.nvm/versions/node"
        if let versions = try? fm.contentsOfDirectory(atPath: nvmDir) {
            for v in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) {
                if let p = usable("\(nvmDir)/\(v)/bin/node") { return p }
            }
        }
        // 4. last resort: search the given PATH
        for dir in (pathEnv ?? "").split(separator: ":") {
            if let p = usable("\(dir)/node") { return p }
        }
        return nil
    }

    /// PATH handed to the engine (and the tools it spawns: openssl, security…),
    /// independent of how the app was launched.
    func childEnvironment(nodePath: String) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let nodeDir = (nodePath as NSString).deletingLastPathComponent
        var parts = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        if !nodeDir.isEmpty { parts.insert(nodeDir, at: 0) }
        env["PATH"] = parts.joined(separator: ":")
        return env
    }

    // MARK: engine path

    /// Resolve the engine entry point:
    /// 1. `CHARLES_CLONE_ENGINE` env var
    /// 2. `enginePath` user setting
    /// 3. `engine/bin/charles-clone.js` inside the app bundle (packaged build)
    /// 4. the development repo path
    var enginePath: String {
        if let p = ProcessInfo.processInfo.environment["CHARLES_CLONE_ENGINE"], !p.isEmpty { return p }
        if let p = UserDefaults.standard.string(forKey: "enginePath"), !p.isEmpty { return p }
        if let res = Bundle.main.resourceURL {
            let bundled = res.appendingPathComponent("engine/bin/charles-clone.js").path
            if FileManager.default.fileExists(atPath: bundled) { return bundled }
        }
        return "/Users/fernando.p_v/dev/charles/charles-clone/bin/charles-clone.js"
    }

    var control: ControlClient? {
        guard let info else { return nil }
        return ControlClient(baseURL: info.baseURL, token: info.token)
    }

    // MARK: lifecycle

    func start() {
        guard process == nil else { return }
        status = .starting
        log.removeAll()
        info = nil

        let node = nodePath
        guard !node.isEmpty else {
            status = .failed("Node.js not found. Install Node, or set its path in Settings (⌘,).")
            return
        }
        guard FileManager.default.fileExists(atPath: enginePath) else {
            status = .failed("engine not found at \(enginePath)")
            return
        }

        let controlFile = NSTemporaryDirectory() + "charles-clone-\(UUID().uuidString).json"
        let token = UUID().uuidString

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)   // absolute; no /usr/bin/env
        proc.arguments = [
            enginePath,
            "--headless",
            "--proxy", String(proxyPort),
            "--config", configFile,
            "--control-file", controlFile,
            "--token", token,
            "--exit-on-stdin-close",
        ]
        proc.environment = childEnvironment(nodePath: node)
        // A pipe we never write to: when the app exits, the read end closes and
        // the engine shuts itself down.
        proc.standardInput = Pipe()

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in
                guard let self else { return }
                if case .stopped = self.status {
                    // user-initiated stop; nothing to report
                } else if p.terminationStatus == 127 {
                    // 127 = "command not found" (e.g. Node missing).
                    self.status = .failed("Node.js not found (exit 127). Set its path in Settings (⌘,).")
                } else if p.terminationStatus != 0 {
                    self.status = .failed("engine exited with code \(p.terminationStatus)")
                } else if case .running = self.status {
                    self.status = .stopped
                } else {
                    self.status = .failed("engine exited before it was ready")
                }
                self.process = nil
            }
        }

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            Task { @MainActor in self?.consume(data, controlFile: controlFile) }
        }

        do {
            try proc.run()
            process = proc
            // Fallback: read the control file if the READY line is missed.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                if self.info == nil, let v = self.readControlFile(controlFile) { self.finishStart(with: v) }
                if self.info == nil, case .starting = self.status {
                    self.status = .failed("engine did not report ready")
                }
            }
        } catch {
            status = .failed(error.localizedDescription)
            process = nil
        }
    }

    func stop() {
        guard let proc = process else { status = .stopped; return }
        proc.terminate()
        process = nil
        info = nil
        status = .stopped
    }

    private func consume(_ data: Data, controlFile: String) {
        stdoutBuffer.append(data)
        while let nl = stdoutBuffer.firstIndex(of: 0x0A) {
            let lineData = stdoutBuffer[stdoutBuffer.startIndex..<nl]
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self)
            if !line.isEmpty { log.append(line) }
            if line.hasPrefix("CHARLES_CLONE_READY "), info == nil {
                let jsonStr = String(line.dropFirst("CHARLES_CLONE_READY ".count))
                if let d = jsonStr.data(using: .utf8), let v = try? JSONDecoder().decode(EngineInfo.self, from: d) {
                    finishStart(with: v)
                }
            }
        }
    }

    private func readControlFile(_ path: String) -> EngineInfo? {
        guard let d = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
        return try? JSONDecoder().decode(EngineInfo.self, from: d)
    }

    private func finishStart(with v: EngineInfo) {
        info = v
        status = .running
    }
}
