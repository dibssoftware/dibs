import Foundation

// dibs 0.0.80 explains the board in sentences a person who isn't technical can
// read: one line per resource, like a deli counter, and for each row who it's
// waiting for and why it moved. These are those fields. Every one is optional,
// and Plain below writes the same sentences from 0.0.70's fields when they're
// missing, so the app reads the same against either.
struct BoardLine: Decodable, Sendable {
    struct Serving: Decodable, Sendable {
        var id: Int?
        var who: String?
        var label: String?
        var purpose: String?
        var endsIn: Double?
        var endsText: String?
    }

    var res: String
    var label: String?
    var serving: [Serving]?
    var waiting: [Int]?
    var clearsIn: Double?
    var summary: String?
}

struct WaitPlain: Decodable, Sendable {
    var place: Int?
    var of: Int?
    var headline: String?
    var startsIn: Double?
    var startsText: String?
    var waitingFor: String?
    var moves: [Move]?
    // 0.0.86: what kind of wait ("line", "memory", "disk", "load", "quota"),
    // and for a wait on the machine, why raising the priority won't help.
    var family: String?
    var advice: String?

    enum CodingKeys: String, CodingKey { case place, of, headline, startsIn, startsText, waitingFor, moves, family, advice }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        place = c.lenient(.place)
        of = c.lenient(.of)
        headline = c.lenient(.headline)
        startsIn = c.lenient(.startsIn)
        startsText = c.lenient(.startsText)
        waitingFor = c.lenient(.waitingFor)
        // A move this app can't read is left out, not the whole row.
        moves = (c.lenient(.moves) as [Lenient<Move>]?)?.compactMap(\.value)
        family = c.lenient(.family)
        advice = c.lenient(.advice)
    }
}

struct Lenient<T: Decodable & Sendable>: Decodable, Sendable {
    var value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

struct HeldPlain: Decodable, Sendable {
    var headline: String?
    var endsText: String?
    var paused: String?
    // 0.0.86: "idle for 25 min, may be stuck (#12, ...)" while others wait.
    var stuck: String?
}

// One reason a waiter moved in line, as a person would say it.
struct Move: Decodable, Sendable, Hashable {
    var dir: String
    var amount: String?
    var reason: String
    // A word or two for the chip; the reason is the whole sentence. dibs
    // sends it as `label` when it has one.
    var short: String?

    enum CodingKeys: String, CodingKey { case dir, amount, reason, short = "label" }

    init(dir: String, amount: String? = nil, reason: String, short: String? = nil) {
        self.dir = dir
        self.amount = amount
        self.reason = reason
        self.short = short
    }

    // dibs writes the reason as a clause that reads after "because" ("it's
    // a short job (about 2 min)"); the terminal says it the same way. "The
    // person at this machine" is whoever is reading the app: "you".
    var sentence: String {
        let r = reason.replacingOccurrences(of: "the person at this machine", with: "you")
        return "\(up ? "Moved ahead" : "Moved back") because \(r)\(r.hasSuffix(".") ? "" : ".")"
    }

    var up: Bool { dir == "up" }
    // "Moved up: quick job", or with no short word for it, "Moved back 5 min".
    var chip: String {
        let what = (short ?? Plain.chipWord(reason)).replacingOccurrences(of: "the person", with: "you")
        if !what.isEmpty { return "\(up ? "Moved up" : "Moved back"): \(what)" }
        return "\(up ? "Moved up" : "Moved back")\(amount.map { " \($0)" } ?? "")"
    }

    // The chip's words once an arrow says which way: "quick job", "5 min".
    var word: String {
        let what = (short ?? Plain.chipWord(reason)).replacingOccurrences(of: "the person", with: "you")
        return what.isEmpty ? amount ?? (up ? "moved up" : "moved back") : what
    }
}

// One resource's line: who's using it now and who's waiting, in order.
struct Counter: Identifiable, Sendable {
    var res: String
    var name: String
    var serving: [Row]
    var waiting: [Row]
    var clearsAt: Date?
    var summary: String

    var id: String { res }
    var isFree: Bool { serving.isEmpty && waiting.isEmpty }
}

enum Plain {
    // The names the CLI gives its resources in `lines` (label).
    static func name(_ res: String) -> String {
        switch res {
        case "sim": return "Simulator"
        case "sim-own": return "Private simulators"
        case "xcode-build": return "Xcode builds"
        case "playwright": return "Browser tests"
        case "test": return "Test runs"
        case "deploy": return "Deploys"
        case "heavy": return "Heavy jobs"
        case "files": return "File locks"
        default: break
        }
        if res.hasPrefix("files:") { return "Files: \(res.dropFirst(6))" }
        if res == "quota:asc" { return "App Store Connect budget" }
        if res.hasPrefix("quota:") { return "\(res.dropFirst(6)) budget" }
        return res
    }

    // Why agents take turns on a resource, for someone who doesn't know they have to.
    static func why(_ res: String) -> String {
        switch res {
        case "sim": "Only one agent can use the iPhone simulator at a time"
        case "sim-own": "This Mac only has memory for a few private simulators at once"
        case "xcode-build": "This Mac only runs a couple of app builds at once, because each one uses a lot of memory"
        case "playwright": "This Mac only runs a couple of browser tests at once, because each one opens its own browser"
        case "test": "This Mac only runs a few test runs at once, so it doesn't slow to a crawl"
        case "deploy": "Only one deploy per project runs at a time, so two releases of it don't clash"
        case "heavy": "Only one heavy job runs at a time, so the Mac stays usable"
        default: res.hasPrefix("quota:") ? "Agents share a limited number of calls to \(name(res).replacingOccurrences(of: " budget", with: ""))"
            : "Only so many agents can use \(inSentence(res)) at once"
        }
    }

    // "the simulator", for the middle of a sentence. Plural names read fine as they are.
    static func inSentence(_ res: String) -> String {
        switch res {
        case "sim": "the simulator"
        case "sim-own", "playwright", "test", "deploy", "heavy": name(res).lowercased()
        default: name(res)
        }
    }

    // "the simulator queue", "the Xcode builds queue".
    static func queueName(_ res: String) -> String {
        res == "sim" ? "the simulator queue" : "the \(inSentence(res)) queue"
    }

    static func ordinal(_ place: Int) -> String {
        if place == 1 { return "Next" }
        let tens = place % 100
        let suffix = (11...13).contains(tens) ? "th" : ["th", "st", "nd", "rd", "th", "th", "th", "th", "th", "th"][place % 10]
        return "\(place)\(suffix)"
    }

    // "about 4 min", the way the CLI's endsText and startsText say it.
    static func about(_ seconds: TimeInterval) -> String {
        let m = Int((seconds / 60).rounded())
        if seconds < 60 { return "under a minute" }
        if m < 60 { return "about \(m) min" }
        let h = m / 60, r = m % 60
        return r == 0 ? "about \(h) hr" : "about \(h) hr \(r) min"
    }

    static func endsText(_ endsAt: Date?, isHold: Bool, now: Date) -> String {
        guard let endsAt else { return isHold ? "no set end time" : "no end time" }
        return "\(about(endsAt.timeIntervalSince(now))) left"
    }

    // A start time the forecast says has already passed tells nobody anything.
    static func startsText(_ startsAt: Date?, now: Date) -> String {
        guard let startsAt, startsAt > now else { return "unknown" }
        return about(startsAt.timeIntervalSince(now))
    }

    // "Starts in about 4 min", "Starts as soon as onboarding finishes".
    static func startsPhrase(_ text: String) -> String {
        if text == "unknown" { return "Start time not known yet" }
        if text == "now" { return "Starting now" }
        if text.hasPrefix("about") || text.hasPrefix("under") { return "Starts in \(text)" }
        return "Starts \(text)"
    }

    // The board's wait reason (0.0.70 `blocked`, with or without "blocked by ")
    // as the rest of "Waiting for ...". `ahead` is whoever is using the
    // resource now, when the reason is that it's in use.
    static func waitingFor(_ blocked: String?, kept: Bool, ahead: Row?, now: Date) -> String {
        guard var b = blocked, b != Row.keptPlace else {
            return kept ? "its agent to come back. It's keeping its place in the queue." : "nothing. It's starting now."
        }
        if b.hasPrefix("blocked by ") { b.removeFirst("blocked by ".count) }
        let (rule, detail) = b.firstIndex(of: ":").map { (String(b[..<$0]), b[b.index(after: $0)...].trimmingCharacters(in: .whitespaces)) } ?? (b, "")
        if b.hasPrefix("behind ") { return "\(b.dropFirst(7)) to go first. They're ahead in the queue." }
        switch rule {
        case "slot":
            if let ahead { return finish(ahead, now: now) }
            return "a turn on \(inSentence(detail))"
        case "reset": return "\(inSentence(detail)) to finish resetting after the last job"
        case "disk": return "more free disk space (\(detail.replacingOccurrences(of: "G", with: " GB")))"
        // The waits on the whole machine. Another machine's board names only
        // the rule; these say what the CLI's own sentences do (src/plain.mjs).
        case "swaproom": return "more free disk space for this Mac's memory to spill into. Nothing new starts until there's room"
        case "drain": return "free disk space to stop falling. Nothing new starts while it falls this fast"
        case "pressure": return "memory to free up. The Mac is short on memory, so nothing new starts until it eases"
        case "swap": return "the Mac to stop running out of memory. Nothing new starts until it settles"
        case "ram": return "more free memory on the Mac"
        case "memory", "cpu", "budget": return "room on the Mac. Other jobs are using what's set aside for agents."
        case "load": return "the Mac to cool down"
        case "idle": return "everyone else to finish. Background work goes last."
        case "files": return "another agent to finish with \(detail)"
        case "quota": return "the \(detail) limit to reset"
        // Older boards name only the resource that's in use.
        default: return detail.isEmpty && !b.contains(" ") ? "a turn on \(inSentence(b))" : b
        }
    }

    // The rule a wait reason names: "slot", "disk", "swaproom", "behind".
    // nil for a kept place or no reason.
    static func rule(_ blocked: String?) -> String? {
        guard var b = blocked, b != Row.keptPlace else { return nil }
        if b.hasPrefix("blocked by ") { b.removeFirst("blocked by ".count) }
        if b.hasPrefix("behind ") { return "behind" }
        return String(b.prefix { $0 != ":" && $0 != " " })
    }

    // Waits on the line itself: someone has the slot, or is ahead. Anything
    // else waits on the Mac (memory, disk, load) or a budget.
    static let lineRules: Set<String> = ["slot", "behind", "ahead", "files", "reset"]

    // A rule's kind, as 0.0.86 sends it in `family`.
    static func family(_ rule: String?) -> String? {
        guard let rule else { return nil }
        if lineRules.contains(rule) { return "line" }
        switch rule {
        case "disk", "swaproom", "drain": return "disk"
        case "memory", "pressure", "swap", "ram", "cpu", "budget": return "memory"
        default: return rule
        }
    }

    static func finish(_ row: Row, now: Date) -> String {
        let job = row.purpose.isEmpty ? "turn" : row.purpose
        let left = row.endsAt.map { ", \(about($0.timeIntervalSince(now))) left" } ?? ""
        return "\(row.who)'s \(job) to finish\(left)"
    }

    // A 0.0.70 rank part as a move a person would understand. dibs counts a
    // positive shift as moving up.
    static func move(_ part: Waiter.Rank.Part) -> Move {
        let up = part.shift >= 0
        let amount = about(abs(part.shift) / 1000).replacingOccurrences(of: "about ", with: "")
        let (short, reason): (String, String) = switch part.label {
        case "urgent": ("urgent", "it's urgent")
        case "high": ("high priority", "it's high priority")
        case "low": ("low priority", "it's low priority")
        case "idle": ("idle", "it's idle work")
        case "deadline": ("deadline", "it has a deadline coming up")
        case "short job": ("short job", "it's a short job")
        case "recent use": ("taking turns", "this agent used a lot in the last hour")
        case "let ahead": ("let ahead", "another agent let it go first")
        default:
            part.label.hasPrefix("holds ")
                ? ("finishing a job", "it already has \(Plain.inSentence(String(part.label.dropFirst(6)))) and needs this to finish")
                : (part.label, part.label)
        }
        return Move(dir: up ? "up" : "down", amount: amount, reason: reason, short: short)
    }

    // The CLI's moves come without a chip word; take the first few words of the reason.
    static func chipWord(_ reason: String) -> String {
        let lower = reason.lowercased()
        if lower.hasPrefix("you ") || lower.hasPrefix("the person") { return "by you" }
        var first = lower.split(whereSeparator: { ".:,(".contains($0) }).first.map(String.init) ?? lower
        for lead in ["it's ", "it is ", "a ", "an ", "the "] where first.hasPrefix(lead) { first.removeFirst(lead.count) }
        let words = first.split(separator: " ")
        return words.count <= 3 ? words.joined(separator: " ") : ""
    }

    // Who made an owner mark and why, from its label ("boosted by web-app:
    // ci is red", ownerLabel in src/override.mjs). `by` is nil for the person,
    // whom the label calls "owner".
    static func ownerBy(_ label: String) -> (by: String?, reason: String?) {
        guard let at = label.range(of: " by ") else { return (nil, nil) }
        let rest = label[at.upperBound...]
        let parts = rest.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        let by = parts[0] == "owner" || parts[0].isEmpty ? nil : parts[0]
        return (by, parts.count > 1 && !parts[1].isEmpty ? parts[1] : nil)
    }

    // The owner's changes, as moves: "you" for the person's, the agent's
    // name for an agent's.
    static func ownerMove(_ owner: String) -> Move {
        let (by, why) = ownerBy(owner)
        let who = by ?? "you"
        if owner.hasPrefix("capped") {
            return Move(dir: "down", reason: "\(who) capped this agent at \(owner.split(separator: " ").dropFirst().first ?? "low") priority", short: "capped by \(who)")
        }
        let did = owner.hasPrefix("boosted") ? "let it go first" : "moved it back"
        return Move(dir: owner.hasPrefix("boosted") ? "up" : "down", reason: why.map { "\(who) \(did): \($0)" } ?? "\(who) \(did)", short: "set by \(who)")
    }

    // The agent's change to its own job (AgentBoost.label), as a move. It's
    // the agent's doing, never "you".
    static func agentMove(_ label: String) -> Move {
        guard label.hasPrefix("boosted") else { return Move(dir: "down", reason: "the agent lowered it", short: "lowered by the agent") }
        let reason = label.split(separator: ":", maxSplits: 1).dropFirst().first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return Move(dir: "up", reason: reason.isEmpty ? "the agent boosted it" : "the agent boosted it: \(reason)", short: "boosted by the agent")
    }

    // 0.0.70's pause label (src/preempt.mjs) in plain words.
    static func paused(_ label: String?) -> String? {
        guard let label else { return nil }
        if label == "paused by owner" { return "Paused by you" }
        if label.hasPrefix("paused for ") { return "Paused so \(label.dropFirst(11))'s urgent work could go first" }
        if label.contains("memory") { return "Paused while this Mac is short on memory" }
        if label.contains("disk") { return "Paused while free disk space is low" }
        return label.prefix(1).uppercased() + label.dropFirst()
    }

    static func summary(serving: Int, waiting: Int, clearsAt: Date?, now: Date) -> String {
        if serving == 0 && waiting == 0 { return "Free" }
        var s = serving == 0 ? "Nobody using it" : "\(serving) in use"
        if waiting > 0 { s += ", \(waiting) waiting" }
        if let clearsAt, clearsAt > now { s += ", clear in \(about(clearsAt.timeIntervalSince(now)))" }
        return s
    }
}

extension Board {
    // The lines, busiest first. From 0.0.80's `lines` when dibs sends them;
    // otherwise worked out from the rows, the same way.
    func counters(rows: [Row], now: Date = .now) -> [Counter] {
        guard let lines, !lines.isEmpty else { return rows.counters(now: now) }
        return lines.map { line in
            let serving = (line.serving ?? []).map { s in
                rows.first { $0.held && $0.leaseID != nil && $0.leaseID == s.id } ?? Row(serving: s, res: line.res, now: now)
            }
            let waiting = (line.waiting ?? []).enumerated().compactMap { i, id -> Row? in
                guard var row = rows.first(where: { !$0.held && $0.leaseID == id }) else { return nil }
                row.place = i + 1
                if row.waitingFor == nil {
                    row.waitingFor = Plain.waitingFor(row.blocked, kept: row.blocked == Row.keptPlace, ahead: i == 0 ? serving.first : nil, now: now)
                }
                return row
            }
            let clears = line.clearsIn.map { now.addingTimeInterval($0 / 1000) }
            return Counter(res: line.res, name: line.label ?? Plain.name(line.res), serving: serving, waiting: waiting, clearsAt: clears,
                           summary: line.summary ?? Plain.summary(serving: serving.count, waiting: waiting.count, clearsAt: clears, now: now))
        }
    }
}

extension Row {
    // A serving entry whose lease isn't in `held`, which shouldn't happen, but
    // the line should still say someone is there.
    init(serving s: BoardLine.Serving, res: String, now: Date) {
        self.init(id: "serving-\(res)-\(s.id ?? 0)", leaseID: nil, res: [res], who: s.who ?? "someone", label: s.label ?? "",
                  purpose: s.purpose ?? "", cmd: "", prio: .normal, held: true, isHold: false, paused: nil, since: now,
                  endsAt: s.endsIn.map { now.addingTimeInterval($0 / 1000) }, startsAt: nil, due: nil, blocked: nil, place: nil,
                  rank: [], owner: nil)
        endsText = s.endsText ?? Plain.endsText(endsAt, isHold: false, now: now)
    }
}

extension [Row] {
    // One counter per resource. A job that needs two resources is in both
    // lines. Busiest first: the longest line, then the most in use, then by name.
    func counters(now: Date = .now) -> [Counter] {
        var order: [String] = []
        var serving: [String: [Row]] = [:], waiting: [String: [Row]] = [:]
        for row in self {
            for r in row.res {
                if serving[r] == nil { order.append(r); serving[r] = []; waiting[r] = [] }
                if row.held { serving[r]!.append(row) } else { waiting[r]!.append(row) }
            }
        }
        return order.map { r in
            let inLine = waiting[r]!.enumerated().map { i, row in
                var row = row
                row.place = i + 1
                if row.waitingFor == nil {
                    // Only the first in line waits on whoever is using it now.
                    let ahead = i == 0 ? serving[r]!.min { ($0.endsAt ?? .distantFuture) < ($1.endsAt ?? .distantFuture) } : nil
                    row.waitingFor = Plain.waitingFor(row.blocked, kept: row.blocked == Row.keptPlace, ahead: ahead, now: now)
                }
                return row
            }
            let using = serving[r]!
            // Without the CLI's sum of everyone's turns, only a line nobody is
            // waiting in has a time it clears: when the last one using it ends.
            let ends = using.compactMap(\.endsAt)
            let clearsAt = inLine.isEmpty && !using.isEmpty && ends.count == using.count ? ends.max() : nil
            return Counter(res: r, name: Plain.name(r), serving: using, waiting: inLine, clearsAt: clearsAt,
                           summary: Plain.summary(serving: using.count, waiting: inLine.count, clearsAt: clearsAt, now: now))
        }
        .sorted {
            if $0.waiting.count != $1.waiting.count { return $0.waiting.count > $1.waiting.count }
            if $0.serving.count != $1.serving.count { return $0.serving.count > $1.serving.count }
            return $0.name < $1.name
        }
    }
}

extension Counter {
    var isFileLock: Bool { res.hasPrefix("files:") }
}

extension [Counter] {
    // A file lease is a line per file, so one agent holding thirty files made
    // thirty one-row queues. The screens show the real queues, and the file
    // locks together as one group.
    var queues: [Counter] { filter { !$0.isFileLock } }
    var fileLocks: [Counter] { filter(\.isFileLock) }

    // One job in several lines counts once.
    var runningCount: Int { Set(flatMap(\.serving).map(\.id)).count }
    var waitingCount: Int { Set(flatMap(\.waiting).map(\.id)).count }
}

extension Counter {
    // A file lease by its file's name; the whole path is on hover.
    var shortName: String { Counter.fileName(res) ?? name }

    // A file lease by the file's name; a pattern like src/** keeps the folder
    // it covers, since "**" alone says nothing.
    static func fileName(_ res: String) -> String? {
        guard res.hasPrefix("files:") else { return nil }
        let path = String(res.dropFirst(6))
        let parts = path.split(separator: "/")
        guard let last = parts.last else { return path }
        if !last.contains("*") { return String(last) }
        let folder = parts.dropLast().last { !$0.contains("*") }
        return folder.map { "\($0)/\(last)" } ?? "Every file"
    }
}
