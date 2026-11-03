import Foundation

// `dibs stats --json`: the same numbers the web page's Stats view draws
// (collect() in src/stats.mjs). Every field the screen can do without is
// optional, so an older or newer dibs still decodes.
struct Stats: Decodable, Sendable {
    var since: Double
    var until: Double
    var agent: String?
    var totals: Totals
    var agents: [AgentStats]
    var resources: [ResourceStats]
    var days: [Day]
    var grid: [GridRow]
    var machine: MachineStats?

    struct Held: Decodable, Sendable, Hashable {
        var label: String
        var jobs: Int?
        var ms: Double
    }

    struct Eta: Decodable, Sendable {
        var finished: Int
        var onTime: Int
        var medianLate: Double?
    }

    struct Totals: Decodable, Sendable {
        var jobs: Int
        var agents: Int?
        var runMs: Double
        var waitMs: Double
        var waitedLongerShare: Double?
        var runs: Int?
        var stopped: Int?
        var failRate: Double?
        var gaveUp: Int?
        var posts: Int?
        var eta: Eta?
        var heldBy: [Held]?
    }

    struct Named: Decodable, Sendable, Hashable {
        var name: String
        var n: Int
        var ms: Double
    }

    struct AgentStats: Decodable, Sendable, Identifiable {
        var who: String
        var jobs: Int
        var runMs: Double
        var waitMs: Double
        var waited: Int?
        var feltMedian: Double?
        var p90Wait: Double?
        var waitedLongerShare: Double?
        var runs: Int?
        var failed: Int?
        var stopped: Int?
        var failRate: Double?
        var gaveUp: Int?
        var codes: [String: Int]?
        var resources: [Named]?
        var commands: [Named]?
        var heldBy: [Held]?
        var peakMem: Double?
        var posts: Int?
        var tasksDone: Int?
        var blockedMs: Double?
        var blockedNow: Double?
        var eta: Eta?
        var id: String { who }
    }

    struct ResourceStats: Decodable, Sendable, Identifiable {
        var res: String
        var jobs: Int
        var busyMs: Double
        var utilization: Double?
        var waited: Int?
        var feltMedian: Double?
        var p90Wait: Double?
        var hours: [Double]?
        var heldBy: [Held]?
        var gaveUp: Int?
        var id: String { res }
    }

    struct Day: Decodable, Sendable, Identifiable {
        var day: Double
        var jobs: Int
        var runMs: Double
        var waitMs: Double
        var runs: Int?
        var failed: Int?
        var id: Double { day }
    }

    struct GridRow: Decodable, Sendable, Identifiable {
        var day: Double
        var run: [Double]
        var wait: [Double]
        var jobs: [Int]?
        var id: Double { day }
    }

    struct Sample: Decodable, Sendable, Identifiable {
        var at: Double
        var load: Double?
        var memFree: Double?
        var diskFree: Double?
        var id: Double { at }
    }

    struct Override: Decodable, Sendable, Identifiable, Hashable {
        var at: Double
        var act: String
        var by: String?
        var id_: Lenient<Int>?
        var who: String?
        var to: String?
        var prio: String?
        var reason: String?
        var id: String { "\(at)-\(act)" }

        enum CodingKeys: String, CodingKey { case at, act, by, id_ = "id", who, to, prio, reason }

        static func == (a: Override, b: Override) -> Bool { a.id == b.id }
        func hash(into h: inout Hasher) { h.combine(id) }

        // The web page's changeList words.
        var line: String {
            let n = id_?.value.map { "#\($0)" } ?? "a job"
            let what: String = switch act {
            case "boost": "set \(n) to \(prio ?? "?")"
            case "pause": "paused \(n)"
            case "resume": "resumed \(n)"
            case "stop": "stopped \(n)"
            case "cap": "capped \(who ?? "an agent") at \(prio ?? "?")"
            case "tell": "messaged \(to ?? "an agent")"
            case "answer": "answered a question"
            case "dismiss": "dismissed a question"
            default: act
            }
            let whose = who.flatMap { act == "cap" ? nil : " (\($0)'s)" } ?? ""
            return "\(what)\(whose)\(reason.map { ": \($0)" } ?? "")"
        }
    }

    struct MachineStats: Decodable, Sendable {
        var series: [Sample]
        var memLow: Sample?
        var loadHigh: Sample?
        var pauses: Int?
        var ownerPauses: Int?
        var dibsPauses: Int?
        var overrides: [Override]?
    }
}

extension Stats {
    // The few sentences on top: only what the numbers carry (statsLead on the web page).
    var lead: String {
        let t = totals
        var out = "\(agent ?? Self.plural(t.agents ?? 0, "agent")) ran \(Self.plural(t.jobs, "job")) for \(Span.short(ms: t.runMs)) and waited \(Span.short(ms: t.waitMs)) for turns. "
        if let w = t.waitedLongerShare { out += "\(Self.pct(w)) waited longer than they ran. " }
        if let runs = t.runs, runs > 0 { out += "\(Self.pct(t.failRate)) of runs failed\((t.stopped ?? 0) > 0 ? ", \(t.stopped!) were stopped" : ""). " }
        if let g = t.gaveUp, g > 0 { out += "\(Self.plural(g, "request")) gave up waiting. " }
        if let e = t.eta, e.finished > 0 {
            out += "\(e.onTime) of \(Self.plural(e.finished, "task")) finished by their ETA\((e.medianLate ?? 0) > 0 ? "; the late ones ran \(Span.short(ms: e.medianLate)) over" : "")."
        }
        return out.trimmingCharacters(in: .whitespaces)
    }

    static func plural(_ n: Int, _ w: String) -> String { "\(n.formatted()) \(w)\(n == 1 ? "" : "s")" }
    static func pct(_ x: Double?) -> String { x.map { "\(Int(($0 * 100).rounded()))%" } ?? "-" }
}
