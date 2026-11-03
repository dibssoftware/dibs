import Foundation

// A line of `dibs service status`: "web       running (pid 812)            the page and MCP server ...".
struct ServiceRow: Sendable, Hashable, Identifiable {
    var name: String
    var state: String
    var what: String
    var id: String { name }

    var running: Bool { state.hasPrefix("running") }
    var installed: Bool { !state.hasPrefix("not installed") }

    // Columns are two or more spaces apart; the relay's own status line has no name and is skipped.
    static func list(_ out: String) -> [ServiceRow] {
        out.split(separator: "\n").compactMap { line in
            let parts = line.components(separatedBy: "  ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard parts.count >= 3, !line.hasPrefix(" ") else { return nil }
            return ServiceRow(name: parts[0], state: parts[1], what: parts[2...].joined(separator: " "))
        }
    }
}

// `dibs sims --json`: the private simulators behind sim-own, and room for more.
struct SimPool: Decodable, Sendable {
    struct Room: Decodable, Sendable {
        var per: Double?
        var fits: Int?
        var max: Int?
        var inUse: Int?
    }
    struct Device: Decodable, Sendable, Identifiable {
        var name: String
        var res: String?
        var who: String?
        var since: Double?
        var lastUsed: Double?
        var lastWho: String?
        var state: String?
        private var leaseField: Lenient<Double>?
        var inUse: Bool { leaseField?.value != nil }
        var id: String { name }

        enum CodingKeys: String, CodingKey { case name, res, who, since, lastUsed, lastWho, state, leaseField = "lease" }
    }
    var room: [String: Room]
    var devices: [Device]
}
