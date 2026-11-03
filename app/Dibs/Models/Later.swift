import Foundation

// `dibs later list --json`: runs agents scheduled for a time or for after
// another job. Times are ms since 1970, as dibs writes them.
struct LaterList: Decodable, Sendable {
    var jobs: [LaterRun]
}

struct LaterRun: Decodable, Sendable, Identifiable, Hashable {
    var id: String
    var state: String
    var res: [String]
    var who: String
    var purpose: String?
    var cmd: String?
    var when: String?
    var at: Double?
    var fired: Double?
    var ended: Double?
    var code: Int?

    // Scheduled, or started and not yet ended: cancel still means something.
    var active: Bool { ["scheduled", "waiting", "running"].contains(state) }

    var what: String { purpose.flatMap { $0.isEmpty ? nil : $0 } ?? cmd ?? id }

    // "deploy, at 02:00 AM", or how it ended: the same words as the web page.
    func side(now: Date) -> String {
        let res = res.joined(separator: ", ")
        if state == "scheduled" { return "\(res), \(when ?? "after another job")" }
        if let ended { return "\(res), ended \(Span.ago(now.timeIntervalSince(Date(ms: ended))))" }
        if let fired { return "\(res), started \(Span.ago(now.timeIntervalSince(Date(ms: fired))))" }
        return res
    }

    // Running first, then waiting, then by when they're due.
    static func order(_ a: LaterRun, _ b: LaterRun) -> Bool {
        let rank = ["running": 0, "waiting": 1, "scheduled": 2]
        return (rank[a.state] ?? 3, a.at ?? .infinity) < (rank[b.state] ?? 3, b.at ?? .infinity)
    }
}
