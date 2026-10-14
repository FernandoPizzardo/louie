import Foundation

/// Minimal client for the engine's loopback control API (token-authenticated).
struct ControlClient {
    let baseURL: URL
    let token: String?

    private func request(_ path: String, method: String = "GET", body: Data? = nil) -> URLRequest {
        var r = URLRequest(url: baseURL.appendingPathComponent(path))
        r.httpMethod = method
        if let token { r.setValue(token, forHTTPHeaderField: "x-charles-token") }
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    func getJSON<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
        let (data, _) = try await URLSession.shared.data(for: request(path))
        return try JSONDecoder().decode(T.self, from: data)
    }

    func post(_ path: String, json: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: json)
        _ = try await URLSession.shared.data(for: request(path, method: "POST", body: data))
    }

    func getData(_ path: String) async throws -> Data {
        let (data, _) = try await URLSession.shared.data(for: request(path))
        return data
    }

    func postData(_ path: String, _ data: Data) async throws {
        _ = try await URLSession.shared.data(for: request(path, method: "POST", body: data))
    }

    func postJSON<T: Decodable>(_ path: String, json: [String: String], as: T.Type) async throws -> T {
        let data = try JSONSerialization.data(withJSONObject: json)
        let (respData, _) = try await URLSession.shared.data(for: request(path, method: "POST", body: data))
        return try JSONDecoder().decode(T.self, from: respData)
    }
}
