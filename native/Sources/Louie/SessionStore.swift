import Foundation
import Observation

/// Holds the live session table and the selected transaction's detail.
@MainActor
@Observable
final class SessionStore {
    private(set) var rows: [TransactionSummary] = []
    private(set) var detail: TransactionDetail?
    private(set) var recording = true
    private(set) var connected = false

    var filter = ""
    var onlySSL = false
    var selectedID: Int?

    private var control: ControlClient?
    private var eventsTask: Task<Void, Never>?

    var filtered: [TransactionSummary] {
        rows.filter { s in
            if onlySSL && s.sslProxied != true { return false }
            guard !filter.isEmpty else { return true }
            let hay = "\(s.host ?? "")\(s.path ?? "")\(s.method ?? "")\(s.statusText)".lowercased()
            return hay.contains(filter.lowercased())
        }
    }

    // MARK: lifecycle

    func attach(_ control: ControlClient) {
        self.control = control
        Task { await reload() }
        startEvents()
    }

    func detach() {
        eventsTask?.cancel()
        eventsTask = nil
        control = nil
        rows = []
        detail = nil
        selectedID = nil
        connected = false
    }

    func reload() async {
        guard let control else { return }
        if let list: [TransactionSummary] = try? await control.getJSON("/api/transactions", as: [TransactionSummary].self) {
            rows = list
        }
        if let status: EngineStatus = try? await control.getJSON("/api/status", as: EngineStatus.self),
           let rec = status.recording {
            recording = rec
        }
    }

    func select(_ id: Int?) async {
        selectedID = id
        guard let id, let control else { detail = nil; return }
        detail = try? await control.getJSON("/api/transaction/\(id)", as: TransactionDetail.self)
    }

    func clear() async {
        guard let control else { return }
        try? await control.post("/api/clear", json: [:])
    }

    func setRecording(_ on: Bool) async {
        guard let control else { return }
        try? await control.post("/api/recording", json: ["on": on])
    }

    // MARK: SSE

    private func startEvents() {
        guard let control else { return }
        let base = control.baseURL
        let token = control.token
        connected = false
        eventsTask = Task { [weak self] in
            var req = URLRequest(url: base.appendingPathComponent("events"))
            if let token { req.setValue(token, forHTTPHeaderField: "x-charles-token") }
            req.timeoutInterval = 3600
            do {
                let (bytes, _) = try await URLSession.shared.bytes(for: req)
                await MainActor.run { self?.connected = true }
                var event = ""
                for try await line in bytes.lines {
                    if line.hasPrefix("event:") {
                        event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                    } else if line.hasPrefix("data:") {
                        let json = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        await MainActor.run { self?.handle(event: event, json: json) }
                    }
                }
            } catch {
                await MainActor.run { self?.connected = false }
            }
        }
    }

    private func handle(event: String, json: String) {
        let data = Data(json.utf8)
        switch event {
        case "tx":
            if let s = try? JSONDecoder().decode(TransactionSummary.self, from: data) { upsert(s) }
        case "clear":
            rows = []; detail = nil; selectedID = nil
        case "recording":
            if let e = try? JSONDecoder().decode(RecordingEvent.self, from: data) { recording = e.on }
        default:
            break
        }
    }

    private func upsert(_ s: TransactionSummary) {
        if let idx = rows.firstIndex(where: { $0.id == s.id }) {
            rows[idx] = s
        } else {
            rows.append(s)
        }
        if selectedID == s.id {
            Task { await select(s.id) }
        }
    }
}
