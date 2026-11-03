import Foundation

// One line agents post with `dibs progress` (src/progress.mjs), as
// `dibs progress --json` prints it. Times are ms since 1970.
struct ProgressPost: Codable, Sendable, Hashable, Identifiable {
    var at: Double
    var who: String
    var label: String?
    var task: String?
    var state: String
    var eta: Double?
    var text: String
    var project: String?
    var branch: String?

    // Two posts in the same millisecond from one agent are the same post twice.
    var id: String { "\(who)\u{0}\(at)" }
}

// An agent's task: the latest word on it, from its posts. The same rules as
// tasks() in src/progress.mjs, so the page and the app agree on what's late.
struct ProgressTask: Sendable, Hashable, Identifiable {
    // expired: still doing with no word for ProgressBoard.expireAfter, taken for dropped. Never posted, only worked out.
    enum State: String, Sendable { case doing, done, blocked, expired }

    var who: String
    var task: String?
    var project: String?
    var branch: String?
    var started: Date
    var last: Date
    var state: State
    var eta: Date?
    var text: String
    var posts: [ProgressPost]

    // A post without --task belongs to the agent's untitled task in that project.
    var id: String { "\(who)\u{0}\(task ?? "")\u{0}\(task == nil ? project ?? "" : "")" }

    var title: String { task ?? project.map { "Work in \($0)" } ?? "Untitled" }

    func late(now: Date) -> Bool { state == .doing && eta.map { $0 < now } == true }

    // "done by 8:05 PM, in 12m", or late, or how it ended.
    func when(now: Date) -> String? {
        switch state {
        case .done: return "done at \(ProgressTask.clock(last))"
        case .blocked: return "blocked since \(ProgressTask.clock(last))"
        case .expired: return "no word since \(ProgressTask.clock(last)), so taken for finished"
        case .doing:
            guard let eta else { return nil }
            let gap = eta.timeIntervalSince(now)
            return gap >= 0 ? "done by \(ProgressTask.clock(eta)), in \(ProgressTask.short(gap))"
                : "was due \(ProgressTask.clock(eta)), \(ProgressTask.short(-gap)) late"
        }
    }

    static func clock(_ d: Date) -> String { d.formatted(date: .omitted, time: .shortened) }

    // "12m", "1h 5m": the CLI's short way, without seconds, which tick too fast to read.
    static func short(_ t: TimeInterval) -> String {
        let m = Int((max(0, t) / 60).rounded(.up))
        if m < 60 { return "\(m)m" }
        return m % 60 == 0 ? "\(m / 60)h" : "\(m / 60)h \(m % 60)m"
    }
}

// Everyone who posted, the one who posted last first, each with their tasks
// newest first.
struct ProgressAgent: Sendable, Hashable, Identifiable {
    var who: String
    var label: String?
    var tasks: [ProgressTask]
    var id: String { who }
    var last: Date { tasks.first?.last ?? .distantPast }
}

enum ProgressBoard {
    // EXPIRE_AFTER in src/progress.mjs: a task still doing, quiet this long past both its last
    // post and its ETA, reads expired, so a shipped task nobody marked --done stops reading as in progress.
    static let expireAfter: TimeInterval = 3 * 3600

    static func agents(_ posts: [ProgressPost], now: Date = .now) -> [ProgressAgent] {
        var tasks: [String: ProgressTask] = [:]
        var order: [String] = []
        for p in posts.sorted(by: { $0.at < $1.at }) {
            let key = "\(p.who)\u{0}\(p.task ?? "")\u{0}\(p.task == nil ? p.project ?? "" : "")"
            let at = Date(ms: p.at)
            let state = ProgressTask.State(rawValue: p.state) ?? .doing
            if var t = tasks[key] {
                t.last = at
                t.state = state
                t.text = p.text
                if let e = p.eta { t.eta = Date(ms: e) }
                t.branch = p.branch ?? t.branch
                t.project = p.project ?? t.project
                t.posts.insert(p, at: 0)
                tasks[key] = t
            } else {
                order.append(key)
                tasks[key] = ProgressTask(who: p.who, task: p.task, project: p.project, branch: p.branch, started: at, last: at,
                                          state: state, eta: p.eta.map(Date.init(ms:)), text: p.text, posts: [p])
            }
        }
        var byAgent: [String: [ProgressTask]] = [:]
        for key in order {
            guard var t = tasks[key] else { continue }
            if t.state == .doing, now.timeIntervalSince(max(t.last, t.eta ?? t.last)) > expireAfter { t.state = .expired }
            byAgent[t.who, default: []].append(t)
        }
        let labels = Dictionary(posts.compactMap { p in p.label.map { (p.who, $0) } }, uniquingKeysWith: { _, b in b })
        return byAgent.map { who, list in
            ProgressAgent(who: who, label: labels[who], tasks: list.sorted { $0.last > $1.last })
        }
        .sorted { $0.last > $1.last }
    }
}
