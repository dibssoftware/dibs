import Foundation

// What deserves a notification, worked out from one poll. Kept free of
// UserNotifications so the rules can be tested against fixtures.
struct Alert: Sendable, Equatable {
    typealias Kind = Need.Kind

    var kind: Kind
    var key: String
    var title: String
    var body: String
}

enum Alerts {
    // Never more than one notification per kind per minute.
    static let gap: TimeInterval = 60

    // Only what needs the person notifies; the line moving along never does.
    static func candidates(_ needs: [Need]) -> [Alert] {
        needs.map { Alert(kind: $0.kind, key: $0.id, title: $0.title, body: $0.detail) }
    }
}

// Decides which candidates become a notification: each alert once, and per
// kind at most one notification a minute. Alerts held back by the limit stay
// unsent and go out together in the next one.
struct AlertGate: Sendable {
    private(set) var sent: Set<String> = []
    private(set) var lastSent: [Alert.Kind: Date] = [:]

    mutating func pass(_ candidates: [Alert], now: Date, enabled: Set<Alert.Kind> = Set(Alert.Kind.allCases)) -> [Alert.Kind: [Alert]] {
        // Something that left and comes back later is new again.
        sent.formIntersection(candidates.map(\.key))
        var out: [Alert.Kind: [Alert]] = [:]
        for kind in Alert.Kind.allCases {
            let fresh = candidates.filter { $0.kind == kind && !sent.contains($0.key) }
            guard !fresh.isEmpty else { continue }
            if let last = lastSent[kind], now.timeIntervalSince(last) < Alerts.gap { continue }
            sent.formUnion(fresh.map(\.key))
            guard enabled.contains(kind) else { continue }
            lastSent[kind] = now
            out[kind] = fresh
        }
        return out
    }
}
