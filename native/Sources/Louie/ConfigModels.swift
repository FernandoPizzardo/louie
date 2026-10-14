import Foundation

/// Mirrors the engine's `enabled` map. All tools default to off.
struct Enabled: Codable, Equatable {
    var blocklist = false
    var mapRemote = false
    var mapLocal = false
    var rewrite = false
    var throttle = false
    var noCache = false

    enum CodingKeys: String, CodingKey { case blocklist, mapRemote, mapLocal, rewrite, throttle, noCache }

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        blocklist = try c.decodeIfPresent(Bool.self, forKey: .blocklist) ?? false
        mapRemote = try c.decodeIfPresent(Bool.self, forKey: .mapRemote) ?? false
        mapLocal = try c.decodeIfPresent(Bool.self, forKey: .mapLocal) ?? false
        rewrite = try c.decodeIfPresent(Bool.self, forKey: .rewrite) ?? false
        throttle = try c.decodeIfPresent(Bool.self, forKey: .throttle) ?? false
        noCache = try c.decodeIfPresent(Bool.self, forKey: .noCache) ?? false
    }
}

/// A location pattern: full regex match against `scheme://host:port/path?query`.
/// Optional fields become wildcards (like Charles' <locationMatch>). Note the
/// engine calls the scheme field `protocol`.
struct Location: Codable, Equatable, Hashable {
    var host: String?
    var port: Int?
    var path: String?
    var query: String?
    var scheme: String?

    enum CodingKeys: String, CodingKey { case host, port, path, query, scheme = "protocol" }

    init(host: String? = nil, port: Int? = nil, path: String? = nil,
         query: String? = nil, scheme: String? = nil) {
        self.host = host; self.port = port; self.path = path
        self.query = query; self.scheme = scheme
    }
}

struct MapRemoteRule: Codable, Equatable, Hashable {
    var from: Location
    var to: Location
}

struct MapLocalRule: Codable, Equatable, Hashable {
    var location: Location
    var localPath: String
    var contentType: String?
    var caseSensitive: Bool?
}

struct RewriteRule: Codable, Equatable, Hashable {
    var type: String        // "request" | "response" | "both"
    var target: String      // "header" | "body" | "status" | "path"
    var action: String?     // "modify" | "add" | "remove"
    var name: String?
    var match: String?
    var replace: String?
    var flags: String?
}

struct RewriteSet: Codable, Equatable, Hashable {
    var enabled: Bool
    var location: Location?
    var rules: [RewriteRule]
}

struct Throttle: Codable, Equatable {
    var latency: Int = 0
    var bandwidthDown: Int = 0
    var bandwidthUp: Int = 0
    var hosts: [Location] = []

    enum CodingKeys: String, CodingKey { case latency, bandwidthDown, bandwidthUp, hosts }

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        latency = try c.decodeIfPresent(Int.self, forKey: .latency) ?? 0
        bandwidthDown = try c.decodeIfPresent(Int.self, forKey: .bandwidthDown) ?? 0
        bandwidthUp = try c.decodeIfPresent(Int.self, forKey: .bandwidthUp) ?? 0
        hosts = try c.decodeIfPresent([Location].self, forKey: .hosts) ?? []
    }
}

/// The subset of the engine config the Tools UI manages. Saving posts exactly
/// these keys; the engine's `Object.assign(config, body)` replaces each section
/// wholesale, so the whole section is always sent.
struct ToolConfig: Codable, Equatable {
    var enabled = Enabled()
    var blockAction = "drop"
    var blocklist: [Location] = []
    var mapRemote: [MapRemoteRule] = []
    var mapLocal: [MapLocalRule] = []
    var rewrite: [RewriteSet] = []
    var throttle = Throttle()
    var sslLocations: [Location] = []

    enum CodingKeys: String, CodingKey {
        case enabled, blockAction, blocklist, mapRemote, mapLocal, rewrite, throttle, sslLocations
    }

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Enabled.self, forKey: .enabled) ?? Enabled()
        blockAction = try c.decodeIfPresent(String.self, forKey: .blockAction) ?? "drop"
        blocklist = try c.decodeIfPresent([Location].self, forKey: .blocklist) ?? []
        mapRemote = try c.decodeIfPresent([MapRemoteRule].self, forKey: .mapRemote) ?? []
        mapLocal = try c.decodeIfPresent([MapLocalRule].self, forKey: .mapLocal) ?? []
        rewrite = try c.decodeIfPresent([RewriteSet].self, forKey: .rewrite) ?? []
        throttle = try c.decodeIfPresent(Throttle.self, forKey: .throttle) ?? Throttle()
        sslLocations = try c.decodeIfPresent([Location].self, forKey: .sslLocations) ?? []
    }
}
