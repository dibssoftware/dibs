import Foundation

// One of dibs's alerts (src/alerts.mjs), as `dibs --json` carries them in
// `alerts`: what's wrong, its one fix, when it started and, once it's gone,
// when it went. The same list the board and the web page show.
struct DibsAlert: Decodable, Sendable, Hashable, Identifiable {
    var id: String
    // wait, memory, idle, ended, dibs or disk.
    var cause: String
    // urgent, warn or note.
    var level: String
    var title: String
    var why: String?
    var detail: String?
    var fix: String
    var job: Int?
    var who: String?
    var since: Double
    var resolvedAt: Double?
    var dismissed: Bool?

    var open: Bool { resolvedAt == nil }
    var sinceDate: Date { Date(ms: since) }
    var resolvedDate: Date? { resolvedAt.map(Date.init(ms:)) }

    // Which Settings switch turns its notification off.
    var kind: Need.Kind {
        switch cause {
        case "wait": .stuck
        case "idle": .idle
        case "disk": .disk
        case "memory": .memory
        case "ended": .ended
        default: .broken
        }
    }
}

// Which alerts become a notification: each one once, and at most one
// notification per cause every 30 minutes, so a bad afternoon doesn't nag.
// What the limit holds back goes out with the next one for that cause.
struct AlertCauseGate: Sendable {
    static let gap: TimeInterval = 30 * 60

    private(set) var sent: Set<String> = []
    private(set) var lastSent: [String: Date] = [:]

    mutating func pass(_ alerts: [DibsAlert], now: Date, enabled: Set<Need.Kind> = Set(Need.Kind.allCases)) -> [(cause: String, alerts: [DibsAlert])] {
        let open = alerts.filter(\.open)
        // One that resolved and comes back later is news again.
        sent.formIntersection(open.map(\.id))
        var out: [(cause: String, alerts: [DibsAlert])] = []
        for cause in Set(open.map(\.cause)).sorted() {
            let fresh = open.filter { $0.cause == cause && !sent.contains($0.id) }
            guard !fresh.isEmpty else { continue }
            if let last = lastSent[cause], now.timeIntervalSince(last) < Self.gap { continue }
            sent.formUnion(fresh.map(\.id))
            guard let kind = fresh.first?.kind, enabled.contains(kind) else { continue }
            lastSent[cause] = now
            out.append((cause, fresh))
        }
        return out
    }
}
