import Foundation

/// A header value that may decode from a JSON string, number, or array.
enum HeaderValue: Decodable, CustomStringConvertible, Equatable {
    case one(String)
    case many([String])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { self = .one(s); return }
        if let a = try? c.decode([String].self) { self = .many(a); return }
        if let n = try? c.decode(Int.self) { self = .one(String(n)); return }
        if let b = try? c.decode(Bool.self) { self = .one(String(b)); return }
        self = .one("")
    }

    var description: String {
        switch self {
        case .one(let s): return s
        case .many(let a): return a.joined(separator: ", ")
        }
    }
}

struct BodyPreview: Decodable, Equatable {
    let type: String
    let text: String
    let truncated: Bool?
}

struct Note: Decodable, Equatable, Identifiable {
    let tool: String
    let text: String
    var id: String { tool + text }
}

/// Decodes an integer that may arrive as a JSON number or a string.
struct FlexInt: Decodable, Equatable {
    let value: Int?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let i = try? c.decode(Int.self) { value = i; return }
        if let s = try? c.decode(String.self) { value = Int(s); return }
        value = nil
    }
}

/// A row in the session table.
struct TransactionSummary: Decodable, Identifiable, Equatable {
    let id: Int
    let scheme: String?
    let method: String?
    let host: String?
    let port: FlexInt?
    let path: String?
    let status: Int?
    let durationMs: Int?
    let sslProxied: Bool?
    let tunneled: Bool?
    let error: String?
    let complete: Bool?
    let reqSize: Int?
    let resSize: Int?
    let contentType: String?
    let notes: [Note]?
    let start: Double?

    var statusText: String {
        if let error, !error.isEmpty { return "ERR" }
        if tunneled == true { return "—" }
        if let status, status > 0 { return String(status) }
        return "…"
    }
    var hostAndPort: String {
        let h = host ?? ""
        if let p = port?.value, p != 80, p != 443 { return "\(h):\(p)" }
        return h
    }
}

/// Full transaction detail for the inspector.
struct TransactionDetail: Decodable, Equatable {
    let id: Int
    let scheme: String?
    let method: String?
    let host: String?
    let port: FlexInt?
    let path: String?
    let status: Int?
    let durationMs: Int?
    let sslProxied: Bool?
    let tunneled: Bool?
    let error: String?
    let reqSize: Int?
    let resSize: Int?
    let notes: [Note]?
    let requestHeaders: [String: HeaderValue]
    let requestBody: BodyPreview
    let responseHeaders: [String: HeaderValue]
    let responseBody: BodyPreview

    var summaryLine: String {
        let s = method ?? ""
        let url = "\(scheme ?? "")://\(host ?? "")\(path ?? "")"
        return "\(s) \(url) · \(durationMs ?? 0)ms"
    }
}

struct RecordingEvent: Decodable { let on: Bool }

/// Root CA identity and trust state from `GET /api/ca`.
struct CAInfo: Decodable, Equatable {
    let path: String
    let subject: String?
    let fingerprint: String?
    let fingerprintHex: String?
    let trusted: Bool
}

/// Result of `POST /api/ca/trust`.
struct TrustResult: Decodable {
    let ok: Bool
    let error: String?
    let output: String?
}

/// Result of `POST /api/import/charles`.
struct ImportSummary: Decodable, Equatable {
    let sslLocations: Int?
    let blocklist: Int?
    let mapRemote: Int?
    let throttleHosts: Int?
    let enabled: [String]?
}

struct ImportResult: Decodable {
    let ok: Bool
    let source: String?
    let warnings: [String]?
    let summary: ImportSummary?
    let error: String?
}

/// Body for `POST /api/transaction/:id/save`.
struct SaveRequest: Encodable { let full: Bool? }

/// Response from the save endpoint: either saved, or a request to confirm when
/// the body exceeds the configured cap.
struct SaveResult: Decodable {
    let ok: Bool
    let needsConfirm: Bool?
    let size: Int?
    let cap: Int?
    let name: String?
    let path: String?
    let truncated: Bool?
    let error: String?
}

/// `GET/POST /api/persist`.
struct PersistInfo: Decodable, Equatable {
    var enabled: Bool? = nil
    var dir: String? = nil
    var maxBodyBytes: Int? = nil
    var retentionDays: Int? = nil
}
struct PersistPatch: Codable { let enabled: Bool }
struct OnPatch: Codable { let on: Bool }
struct OkResponse: Decodable { let ok: Bool }

/// `GET /api/net` — LAN + CA-serving state for device setup.
struct NetInfo: Decodable, Equatable {
    var lanEnabled: Bool = false
    var ip: String = "127.0.0.1"
    var proxyPort: Int = 8888
    var caServePort: Int = 8890
    var serving: Bool = false
    var cerUrl: String = ""
    var mobileconfigUrl: String = ""
    var proxyHost: String = ""
}

/// `POST /api/ca/serve`.
struct CAServeResult: Decodable {
    let ok: Bool
    let serving: Bool?
    let cerUrl: String?
    let mobileconfigUrl: String?
}
struct EngineStatus: Decodable {
    let proxyPort: Int?
    let webPort: Int?
    let recording: Bool?
    let count: Int?
    let leafCertsGenerated: Int?
}
