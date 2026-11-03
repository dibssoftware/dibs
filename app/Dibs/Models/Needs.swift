import Foundation

// What the person might need to do something about. Agents wait in line all
// day and that's fine; these are the few cases worth their attention: an
// agent asking them something, a deploy held up, an important job stuck, a
// disk too full for work to start. Everything else is the line doing its job.
struct Need: Identifiable, Sendable {
    enum Kind: String, CaseIterable, Sendable {
        // idle: a running job that looks stuck while others wait for it.
        // account: a browser of a dibs account this Mac is on waits for its key (Settings).
        case question, note, ship, stuck, idle, disk, account
    }

    var kind: Kind
    var id: String
    var title: String
    var detail: String
    var since: Date
    var question: Question?
    var row: Row?
    var line: String?
    // The conversation it belongs to, by the name `dibs tell` takes.
    var thread: String?
}

enum Needs {
    // A deploy is usually someone shipping; two minutes held up is worth a look.
    static let shipAfter: TimeInterval = 120
    // An urgent or important job past ten minutes in line has lost its head start.
    static let importantAfter: TimeInterval = 600
    // Anything else gets half an hour before it's the person's business.
    static let anyAfter: TimeInterval = 1800
    // A running job whose processes have done nothing this long while others
    // wait is probably orphaned. The same 20 minutes dibs uses to call a run
    // "may be stuck" (STUCK_AFTER in src/plain.mjs): past a simulator boot or
    // a test timeout, short enough to matter to whoever is waiting.
    static let idleAfter: TimeInterval = 1200

    // name: an agent as the person knows it, its session's title when it has one.
    static func items(counters: [Counter], questions: [Question], threads: [AgentThread] = [], now: Date,
                      name: (String) -> String = { $0 }) -> [Need] {
        func thread(of agent: String) -> String? { threads.first { $0.agent == agent && $0.isMain }?.to ?? threads.first { $0.agent == agent }?.to }
        var out = questions.filter { $0.state == .open }.map { q in
            Need(kind: .question, id: "q-\(q.id)", title: "\(name(q.agent ?? q.who)) is asking", detail: q.text, since: q.askedDate, question: q,
                 thread: thread(of: q.agent ?? q.who))
        }
        // Notes the person hasn't read: the newest `unread` of the agent's own
        // messages. dibs's notices to the agent sit in the thread too, but
        // they're for the agent and the CLI doesn't count them.
        for t in threads where t.unread > 0 {
            let unseen = t.messages.filter { $0.from == "agent" && $0.kind != "delivered" }.suffix(t.unread)
            for note in unseen where note.kind == "note" || note.kind == "message" {
                out.append(Need(kind: .note, id: "note-\(t.to)-\(note.id)", title: "\(name(t.name)) says", detail: note.text,
                                since: note.atDate, thread: t.to))
            }
        }
        var full: [(Row, String)] = []
        var seen: Set<String> = []
        for counter in counters where !counter.waiting.isEmpty {
            // A job holding the line that looks stuck: what the person can
            // most usefully do something about, so it comes first.
            for row in counter.serving where isIdle(row) && seen.insert(row.id).inserted {
                out.append(idle(row, counter, now: now, name: name))
            }
        }
        for counter in counters {
            var long: [Row] = []
            // A job in two lines is one job: it shows once, from the first line it's in.
            for row in counter.waiting where seen.insert(row.id).inserted {
                let waited = now.timeIntervalSince(row.since)
                let why = row.waitingFor.map { "Waiting for \($0.hasSuffix(".") ? String($0.dropLast()) : $0)." } ?? ""
                let important = row.prio == .urgent || row.prio == .high
                if isDisk(row) {
                    full.append((row, counter.res))
                } else if isShip(row) && waited >= shipAfter {
                    out.append(Need(kind: .ship, id: "ship-\(row.id)", title: "\(name(row.who)) can't ship yet",
                                    detail: join(row.purpose, why), since: row.since, row: row, line: counter.res))
                } else if important && waited >= importantAfter {
                    out.append(stuck(row, counter, waited: waited, now: now, name: name))
                } else if waited >= anyAfter {
                    long.append(row)
                }
            }
            // Ordinary jobs waiting a long time are one thing about the line,
            // not one thing per job: a long line is one problem. Its id is the
            // line's either way, so a line going from one long wait to two and
            // back is still the same thing to notify about or clear.
            if let first = long.min(by: { $0.since < $1.since }) {
                let waited = minutes(now.timeIntervalSince(first.since))
                var need = long.count == 1
                    ? stuck(first, counter, waited: now.timeIntervalSince(first.since), now: now, name: name)
                    : Need(kind: .stuck, id: "", title: "\(long.count) agents have been waiting over half an hour",
                           detail: "\(Plain.why(counter.res)), so they're taking turns. \(name(first.who)) has waited longest, \(waited). "
                               + "They all start by themselves. If one of them is more urgent, open the queue and let it go first.",
                           since: first.since, line: counter.res)
                need.id = "long-\(counter.res)"
                out.append(need)
            }
        }
        if let (first, res) = full.first {
            let who = full.map { r in r.0.subagent.map { "\(name(r.0.who)) \u{00B7} \($0)" } ?? name(r.0.who) }
                .reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            let (title, detail) = disk(first, who: who)
            out.append(Need(kind: .disk, id: "disk", title: title, detail: detail,
                            since: full.map(\.0.since).min() ?? now, row: first, line: res))
        }
        return out
    }

    // Waiting on disk space: too little free (disk), too little for the
    // Mac's memory to spill into (swaproom), or falling fast (drain).
    static func isDisk(_ row: Row) -> Bool {
        if row.family == "disk" { return true }
        if let rule = Plain.rule(row.blocked) { return Plain.family(rule) == "disk" }
        return (row.waitingFor ?? "").contains("disk space")
    }

    // Shipping is a turn on deploy, or an App Store Connect upload to
    // TestFlight. Words in any other job's purpose don't count: a test run
    // "for the deploy blocker" isn't shipping.
    static func isShip(_ row: Row) -> Bool {
        if row.res.contains(where: { $0 == "deploy" || $0.hasPrefix("deploy-") || $0.hasPrefix("deploy:") }) { return true }
        return row.res.contains("quota:asc") && "\(row.purpose) \(row.cmd)".lowercased().contains("testflight")
    }

    // Waiting on the Mac or a budget, not behind someone: going first can't help.
    static func waitsOnMac(_ row: Row) -> Bool {
        row.family.map { $0 != "line" && $0 != "idle" } ?? false
    }

    // A running job that has done nothing for a while (paused ones are idle on purpose).
    static func isIdle(_ row: Row) -> Bool {
        row.held && !row.isHold && row.pausedText == nil && (row.idleFor ?? 0) >= idleAfter
    }

    // What to say about the disk: how much there is, how much it needs, and
    // what the person can do.
    static func disk(_ row: Row, who: [String]) -> (title: String, detail: String) {
        let w = row.waitingFor ?? ""
        let start = who.count == 1 ? "it starts on its own" : "they start on their own"
        if Plain.rule(row.blocked) == "drain" || w.hasPrefix("free disk to stop falling") || w.hasPrefix("free disk space to stop falling") {
            let fell = number(w, #"fell ([\d.]+) GB"#)
            return ("The disk is filling up fast",
                    "\(fell.map { "Free disk space fell \(gb($0)) in the last 5 minutes. " } ?? "")"
                        + "Something on this Mac is writing a lot, so new work waits until it stops. "
                        + "\(list(who)) \(who.count == 1 ? "is" : "are") waiting. Free up some space and \(start).")
        }
        let free = number(w, #"([\d.]+) GB free"#)
        let need = number(w, #"needs ([\d.]+) GB"#) ?? number(w, #"until ([\d.]+) GB is free"#)
        let title = "The disk is too full for \(list(who)) to start"
        if let free, let need, need > free {
            return (title, "\(gb(free)) is free, and starting needs \(gb(need)). "
                        + "Free up at least \(gb((need - free).rounded(.up))) and \(start).")
        }
        let space = w.firstIndex(of: "(").map { String(w[w.index(after: $0)...].dropLast()) }
        return (title, (space.map { "\($0.prefix(1).uppercased() + $0.dropFirst()). " } ?? "")
                    + "Free up some space and \(start).")
    }

    private static func number(_ text: String, _ pattern: String) -> Double? {
        guard let r = try? NSRegularExpression(pattern: pattern),
              let m = r.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let g = Range(m.range(at: 1), in: text) else { return nil }
        return Double(text[g])
    }

    private static func gb(_ n: Double) -> String {
        n == n.rounded() ? "\(Int(n)) GB" : String(format: "%.1f GB", n)
    }

    // A running job that looks stuck, holding up the line behind it.
    private static func idle(_ row: Row, _ counter: Counter, now: Date, name: (String) -> String) -> Need {
        let me = name(row.who)
        let n = counter.waiting.count
        let others = n == 1 ? "\(name(counter.waiting[0].who)) is" : "\(n) others are"
        let job = row.purpose.isEmpty ? "Its job" : "Its job (\(row.purpose))"
        return Need(kind: .idle, id: "idle-\(row.id)", title: "\(me)'s job looks stuck",
                    detail: "\(job) hasn't done anything for \(minutes(row.idleFor ?? 0)), and \(others) waiting for \(Plain.inSentence(counter.res)). "
                        + "If \(me) has stopped working on it, stop it so the next one can start. If it's still working, leave it.",
                    since: now.addingTimeInterval(-(row.idleFor ?? 0)), row: row, line: counter.res)
    }

    // One agent waiting too long, said for someone who has never heard of a
    // queue or a file lock: what's happening, why it has to be that way, and
    // whether they need to do anything.
    private static func stuck(_ row: Row, _ counter: Counter, waited: TimeInterval, now: Date, name: (String) -> String) -> Need {
        let me = name(row.who)
        let holder = counter.serving.first.map { name($0.who) }
        let left = counter.serving.first?.endsAt.map { max(0, $0.timeIntervalSince(now)) }
        let starts = left.map { $0 < 60 ? "It starts by itself any moment now." : "It starts by itself in about \(minutes($0)), when the other one is done." }
            ?? "It starts by itself as soon as the other one is done."
        let title: String
        let detail: String
        if waitsOnMac(row), let w = row.waitingFor {
            // Not a turn: the Mac itself (memory, disk, load) or a budget.
            // dibs's own sentence says what, better than a guess from the line.
            title = "\(me) has been waiting \(minutes(waited)) to start"
            detail = "It's waiting for \(w.hasSuffix(".") ? String(w.dropLast()) : w). It starts by itself. "
                + "Letting it go first won't help, since it isn't waiting behind another agent."
        } else if let file = Counter.fileName(counter.res) {
            title = "Two agents need the same file"
            detail = "\(me) wants to change \(file), but \(holder ?? "another agent") is changing it right now. "
                + "\(me) waits so neither one overwrites the other's work. \(starts) You don't need to do anything."
        } else if let holder {
            title = "\(me) has been waiting \(minutes(waited)) for its turn"
            detail = "\(Plain.why(counter.res)), and \(holder) is using it now. \(starts) "
                + "If \(me)'s work is more urgent, you can let it go first."
        } else {
            title = "\(me) has been waiting \(minutes(waited)) to start"
            detail = "This Mac is too busy for more work right now, so new work waits until it calms down. "
                + "It starts by itself. You don't need to do anything unless it's urgent."
        }
        return Need(kind: .stuck, id: "stuck-\(row.id)", title: title, detail: detail, since: row.since, row: row, line: counter.res)
    }

    private static func minutes(_ t: TimeInterval) -> String {
        Plain.about(t).replacingOccurrences(of: "about ", with: "")
    }

    private static func join(_ purpose: String, _ rest: String) -> String {
        let p = purpose.isEmpty ? "" : purpose.prefix(1).uppercased() + purpose.dropFirst() + ". "
        return (p + rest).trimmingCharacters(in: .whitespaces)
    }

    static func list(_ names: [String]) -> String {
        names.count <= 2 ? names.joined(separator: " and ") : names.dropLast().joined(separator: ", ") + " and " + names.last!
    }
}

// The one sentence at the top: does anything need the person, and is
// everything else okay.
struct Status: Sendable, Equatable {
    var headline: String
    var detail: String

    static func of(counters: [Counter], needs: Int, now: Date = .now) -> Status {
        let headline = needs == 0 ? "Nothing needs you" : needs == 1 ? "1 thing needs you" : "\(needs) things need you"
        let working = Set(counters.flatMap(\.serving).filter { $0.pausedText == nil }.map(\.who)).count
        var parts = [working == 0 ? "Nobody's working right now." : working == 1 ? "1 agent working." : "\(working) agents working."]
        let lines = counters.filter { !$0.waiting.isEmpty }.sorted { $0.waiting.count > $1.waiting.count }
        // A job in two lines is one job waiting.
        let total = Set(lines.flatMap(\.waiting).map(\.id)).count
        if let top = lines.first {
            if total == top.waiting.count {
                let clear = top.clearsAt.flatMap { $0 > now ? ", clear in \(Plain.about($0.timeIntervalSince(now)))" : nil } ?? ""
                parts.append("\(total) waiting for \(Plain.inSentence(top.res))\(clear).")
            } else {
                parts.append("\(total) waiting, most for \(Plain.inSentence(top.res)).")
            }
        } else if working > 0 {
            parts.append("Nobody's waiting.")
        }
        return Status(headline: headline, detail: parts.joined(separator: " "))
    }
}
