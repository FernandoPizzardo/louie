import Foundation

/// Handshake written by the Node engine when it is ready, and parsed by the app.
struct EngineInfo: Codable, Equatable {
    let pid: Int32
    let proxyPort: Int
    let bindHost: String
    let controlPort: Int
    let token: String?
    let caCertPath: String
    let configFile: String

    /// Base URL of the loopback control API.
    var baseURL: URL { URL(string: "http://127.0.0.1:\(controlPort)")! }
}
