import Foundation

// dibs calls it the pace; the app calls it speed. quiet, normal and max are
// the CLI's names.
struct Speed: Sendable {
    var pace: String
    init(_ pace: String) { self.pace = pace }

    static let all = [Speed("quiet"), Speed("normal"), Speed("max")]

    var title: String {
        switch pace {
        case "quiet": "Calm"
        case "max": "Fast"
        default: pace.capitalized
        }
    }

    var line: String {
        switch pace {
        case "quiet": "Keeps the fan quiet. Fewer jobs run at once, so lines move slower."
        case "normal": "A few jobs at once, and more when this Mac is sitting idle."
        case "max": "Uses the whole Mac. Lines move fastest, and you'll hear the fan."
        case "off": "config.json decides, with no limit on load."
        default: ""
        }
    }
}

// `dibs pace --json`: the pace in force, the knobs it sets on this machine,
// and what each pace would set. A knob dibs has no value for is null.
struct PaceInfo: Decodable, Sendable {
    struct Knobs: Decodable, Sendable, Equatable {
        var cores: Int?
        var budget: String?
        var maxLoad: Double?
        var coolLoad: Double?
        var roomyLoad: Double?
        var roomyMemFree: Double?
    }

    var pace: String?
    var knobs: Knobs
    // Knobs config.json sets by hand, which win over the pace.
    var pinned: [String]
    var paces: [String: Knobs]

    enum CodingKeys: String, CodingKey { case pace, knobs, pinned, paces }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pace = c.lenient(.pace)
        knobs = try c.decode(Knobs.self, forKey: .knobs)
        pinned = c.lenient(.pinned) ?? []
        paces = c.lenient(.paces) ?? [:]
    }

    // One line per pace, in the CLI's order.
    var lines: [(name: String, line: String)] {
        ["quiet", "normal", "max"].compactMap { name in
            paces[name].map { (name, Self.describe($0)) }
        }
    }

    static func describe(_ k: Knobs) -> String {
        // dibs counts cores as running jobs are measured using them (0.0.80), so max can count more than the Mac has.
        var s = "Jobs keep up to \(k.cores.map(String.init) ?? "-") cores busy and use up to \(k.budget.map { $0.replacingOccurrences(of: "G", with: " GB") } ?? "-") of memory at once"
        if let l = k.maxLoad { s += ", and new work waits once the load passes \(l.formatted())" }
        if let r = k.roomyLoad, r > 0 { s += ". The limits lift while the Mac is mostly idle." } else { s += ". The limits always apply." }
        return s
    }
}

// `dibs guard status --json`: whether the Claude Code hook is in settings.json,
// on which tools, how it rewrites, and the subagent limit (null: no limit).
struct GuardStatus: Decodable, Sendable {
    struct Matcher: Decodable, Sendable, Equatable {
        var event: String
        var matcher: String?
    }
    struct Subagents: Decodable, Sendable, Equatable { var slots: Int }

    var installed: Bool
    var file: String
    var command: String?
    // False for an older install that lacks file leases or the subagent limit.
    var complete: Bool
    var matchers: [Matcher]
    var rewrite: String
    var subagents: Subagents?

    // "Bash, Edit, Write ..." and "Agent, Task" from the PreToolUse matchers.
    var tools: [String] {
        matchers.filter { $0.event == "PreToolUse" }.compactMap(\.matcher).flatMap { $0.split(separator: "|").map(String.init) }
    }

    var rewriteLine: String {
        rewrite == "bypass" ? "Rewrites commands in bypassPermissions sessions, blocks them otherwise."
            : "Rewrites commands in \"\(rewrite)\" mode, blocks them otherwise."
    }
}
