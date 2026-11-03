import Foundation

// One line of the board, whether it came from this machine (which has lease
// ids, so the owner can act on it) or from another machine in the group.
struct Row: Identifiable, Sendable, Hashable {
    var id: String
    var leaseID: Int?
    var res: [String]
    var who: String
    var label: String
    var purpose: String
    var cmd: String
    // The last part of the folder it runs in, when the board says.
    var project: String? = nil
    var prio: Prio
    var held: Bool
    var isHold: Bool
    var paused: String?
    var since: Date
    var endsAt: Date?
    var startsAt: Date?
    var due: Date?
    var blocked: String?
    var place: Int?
    var rank: [Waiter.Rank.Part]
    var owner: String?
    // The agent's change to its own job's priority, in the CLI's words
    // ("boosted by the agent: ci is red"). nil under the person's mark.
    var byAgent: String?
    // In plain words, from dibs 0.0.80 or worked out by Plain from the fields
    // above: "about 4 min left", "Paused by you", "about 8 min", why it's
    // waiting and why it moved.
    var endsText: String?
    var pausedText: String?
    var startsText: String?
    var waitingFor: String?
    var moves: [Move] = []
    // The kind of wait (0.0.86's family, or worked out from `blocked`):
    // "line" for a turn, else what on the Mac it waits for.
    var family: String?
    var advice: String?
    // A subagent's own name ("fix-guard"), when the job is one subagent's
    // and not its session's main agent.
    var subagent: String?
    // A running job whose processes have done nothing for a while.
    var idleFor: TimeInterval?
    // A running job that used far more memory than it asked for.
    var overAsk: Lease.OverAsk?

    var resource: String { res.joined(separator: ",") }
}

enum Prio: String, CaseIterable, Sendable, Hashable {
    case urgent, high, normal, low, idle

    init(_ raw: String?) { self = raw.flatMap(Prio.init(rawValue:)) ?? .normal }

    var title: String { rawValue.capitalized }
    // What a person would call it: "high" is how agents say important.
    var word: String {
        switch self {
        case .high: "important"
        case .low: "can wait"
        case .idle: "whenever"
        default: rawValue
        }
    }
}

// The rows that share a resource: who holds it and who waits for it, in the
// order they'll go.
struct ResourceGroup: Identifiable, Sendable {
    var resource: String
    var held: [Row]
    var waiting: [Row]
    var id: String { resource }
}

extension Row {
    static let keptPlace = "keeping its place; its agent's process is gone"
    // pauseLabel's words for the person's own pause.
    static let pausedByOwner = "paused by owner"

    // A pause made by hand, the person's ("paused by owner") or an agent's
    // ("paused by web-app"): the kind dibs resume lifts. dibs's own pauses
    // read "paused for ..." or "paused: ...".
    var pausedByHand: Bool { paused?.hasPrefix("paused by ") == true }
    // The agent that paused it by hand, or nil for the person or dibs.
    var pausedByAgent: String? {
        guard pausedByHand, paused != Row.pausedByOwner else { return nil }
        return paused.map { String($0.dropFirst("paused by ".count)) }
    }

    // A job's own name when it isn't just its agent's: a named teammate's
    // label ("spec-fixer"), or the --as name it ran under. A subagent with
    // only a kind for a label ("general-purpose") goes by its -m reason, else
    // the start of its id, as the CLI's board names it (agentLabel in src/util.mjs).
    static func subagent(label: String?, agentId: String?, who: String, agent: String?, purpose: String = "") -> String? {
        if let label, !label.isEmpty, label != who, label != agent, !genericAgents.contains(label) { return label }
        guard let agentId, !agentId.isEmpty, agentId != "main" else { return nil }
        if !purpose.isEmpty { return "\"\(purpose)\"" }
        return String(agentId.replacingOccurrences(of: #"^a(gent-?)?"#, with: "", options: .regularExpression).prefix(8))
    }

    static let genericAgents: Set<String> = ["general-purpose", "Explore", "Plan", "claude"]
}

extension Date {
    init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) }
}

extension Board {
    func rows(now: Date = .now, peerName: String? = nil) -> [Row] {
        let heldRows = held.map { l in
            Row(id: "lease-\(l.id)", leaseID: l.id, res: l.res, who: l.agent ?? l.who, label: l.label ?? "",
                purpose: l.purpose ?? "", cmd: l.cmd ?? "", prio: Prio(l.prio), held: true, isHold: l.kind == "hold",
                paused: l.pauseLabel, since: Date(ms: l.start), endsAt: l.remaining.map { now.addingTimeInterval($0 / 1000) },
                startsAt: nil, due: nil, blocked: nil, place: nil, rank: [], owner: l.owner?.label(asked: l.askedPrio),
                byAgent: l.agentBoost?.label,
                subagent: Row.subagent(label: l.label, agentId: l.agentId, who: l.who, agent: l.agent, purpose: l.purpose ?? ""),
                idleFor: l.kind == "hold" ? nil : l.idleMs.flatMap { $0 > 0 ? $0 / 1000 : nil }, overAsk: l.overAsk)
            .plain(l.plain, now: now)
            .in(l.cwd)
        }
        // Older boards say why a waiter is stuck only in the coordinator's copy
        // of this machine's rows, which come in the same order.
        let peerWaiting = peerName.flatMap { name in elsewhere?.machines?.first { $0.name == name }?.board?.waiting } ?? []
        let waitRows = waiting.enumerated().map { i, q in
            let peerRow = peerWaiting.indices.contains(i) && peerWaiting[i].who == q.who ? peerWaiting[i] : nil
            return Row(id: "wait-\(q.id)", leaseID: q.id, res: q.res, who: q.agent ?? q.who, label: q.label ?? "",
                       purpose: q.purpose ?? "", cmd: q.cmd ?? "", prio: Prio(q.prio), held: false, isHold: false,
                       paused: nil, since: Date(ms: q.enq), endsAt: nil, startsAt: q.expectStart.map(Date.init(ms:)),
                       due: q.by.map(Date.init(ms:)), blocked: Self.reason(q.blocked, kept: q.pid == nil) ?? peerRow?.blocked,
                       place: q.place ?? i + 1, rank: q.rank?.parts ?? [], owner: q.owner?.label(asked: q.askedPrio),
                       byAgent: q.agentBoost?.label,
                       subagent: Row.subagent(label: q.label, agentId: q.agentId, who: q.who, agent: q.agent, purpose: q.purpose ?? ""))
            .plain(q.plain, now: now)
            .in(q.cwd)
        }
        return heldRows + waitRows
    }

    // This machine's reasons come without the "blocked by " the board prints;
    // put it back so every row reads the same.
    static func reason(_ blocked: String?, kept: Bool) -> String? {
        guard let blocked else { return kept ? Row.keptPlace : nil }
        return blocked.hasPrefix("behind ") || blocked.hasPrefix("blocked by ") ? blocked : "blocked by \(blocked)"
    }

    // The group's other machines, without this one.
    func peers(excluding name: String?) -> [Peer] {
        (elsewhere?.machines ?? []).filter { $0.name != name }.sorted { $0.name < $1.name }
    }
}

extension Peer {
    func rows(now: Date = .now) -> [Row] {
        guard let board else { return [] }
        // Their durations were measured `age` ago.
        let then = now.addingTimeInterval(-(age ?? 0) / 1000)
        let heldRows = board.held.enumerated().map { i, l in
            Row(id: "\(name)-held-\(i)", leaseID: nil, res: l.res, who: l.who, label: l.label ?? "", purpose: l.purpose ?? "",
                cmd: l.cmd ?? "", prio: Prio(l.prio), held: true, isHold: l.cmd == nil, paused: l.paused,
                since: then.addingTimeInterval(-l.for / 1000), endsAt: l.left.map { then.addingTimeInterval($0 / 1000) },
                startsAt: nil, due: nil, blocked: nil, place: nil, rank: [], owner: l.owner, byAgent: l.byAgent,
                subagent: Row.subagent(label: l.label, agentId: nil, who: l.who, agent: nil))
            .plain(nil as HeldPlain?, now: now)
        }
        let waitRows = board.waiting.enumerated().map { i, q in
            Row(id: "\(name)-wait-\(i)", leaseID: nil, res: q.res, who: q.who, label: q.label ?? "", purpose: q.purpose ?? "",
                cmd: "", prio: Prio(q.prio), held: false, isHold: false, paused: nil,
                since: then.addingTimeInterval(-q.waited / 1000), endsAt: nil,
                startsAt: q.in.map { then.addingTimeInterval($0 / 1000) }, due: q.due.map { then.addingTimeInterval($0 / 1000) },
                blocked: q.blocked ?? (q.kept == true ? Row.keptPlace : nil), place: i + 1, rank: [], owner: q.owner, byAgent: q.byAgent,
                subagent: Row.subagent(label: q.label, agentId: nil, who: q.who, agent: nil))
            .plain(nil as WaitPlain?, now: now)
        }
        return heldRows + waitRows
    }
}

extension Row {
    // The CLI's sentences when it sends them, else Plain's from the 0.0.70 fields.
    func plain(_ p: HeldPlain?, now: Date) -> Row {
        var row = self
        row.endsText = p?.endsText ?? Plain.endsText(endsAt, isHold: isHold, now: now)
        // "The person at this machine" is whoever is reading this.
        row.pausedText = paused == nil ? nil : (p?.paused ?? Plain.paused(paused))?.replacingOccurrences(of: "the person at this machine", with: "you")
        return row
    }

    func plain(_ p: WaitPlain?, now: Date) -> Row {
        var row = self
        // dibs's own forecast replaces the raw expectStart, and a null one
        // means it can't say: a wait on memory or disk, or behind a job with
        // no known end. expectStart still holds a guess then, which read as
        // "Any moment" for jobs that had waited 14 minutes.
        if let p { row.startsAt = p.startsIn.map { now.addingTimeInterval($0 / 1000) } }
        row.startsText = p?.startsText ?? Plain.startsText(row.startsAt, now: now)
        row.waitingFor = p?.waitingFor
        row.family = p?.family ?? Plain.family(Plain.rule(blocked))
        row.advice = p?.advice
        if let moves = p?.moves {
            row.moves = moves
        } else {
            // The owner's or the agent's change says it better than the priority it set.
            let mark = owner.map(Plain.ownerMove) ?? byAgent.map(Plain.agentMove)
            let parts = mark == nil ? rank : rank.filter { Prio(rawValue: $0.label) == nil }
            row.moves = (mark.map { [$0] } ?? []) + parts.map(Plain.move)
        }
        return row
    }
}

extension [Row] {
    // Resources with a line first, longest line first; then the rest by name.
    func groupedByResource() -> [ResourceGroup] {
        var groups: [String: ResourceGroup] = [:]
        for row in self {
            var g = groups[row.resource] ?? ResourceGroup(resource: row.resource, held: [], waiting: [])
            if row.held { g.held.append(row) } else { g.waiting.append(row) }
            groups[row.resource] = g
        }
        return groups.values.sorted {
            $0.waiting.count != $1.waiting.count ? $0.waiting.count > $1.waiting.count : $0.resource < $1.resource
        }
    }
}

extension Row {
    // How far through its turn, when dibs knows how long the turn is.
    func progress(at now: Date) -> Double? {
        guard let endsAt else { return nil }
        let total = endsAt.timeIntervalSince(since)
        return total > 0 ? min(1, max(0, now.timeIntervalSince(since) / total)) : 1
    }

    // "14 min left", or how long it's had it when dibs doesn't know the end.
    func left(at now: Date) -> String {
        if let endsAt { return endsAt > now ? "\(Span.of(endsAt.timeIntervalSince(now))) left" : "Finishing" }
        return "For \(Span.of(now.timeIntervalSince(since)))"
    }

    // When it should start, in as few words as the row can say it.
    func starts(at now: Date) -> String {
        if let startsAt { return startsAt > now.addingTimeInterval(30) ? "In \(Span.of(startsAt.timeIntervalSince(now)))" : "Any moment" }
        if let text = startsText, text.hasPrefix("as soon as ") {
            return "After " + text.dropFirst(11).replacingOccurrences(of: " finishes", with: "")
        }
        return startsText == "unknown" ? "Not known yet" : "Later"
    }

    // The same, to follow "web-app is next,": "in 4 min", "after onboarding".
    func startsPhrase(at now: Date) -> String {
        let s = starts(at: now)
        return s == "Not known yet" ? "start time not known yet" : s.prefix(1).lowercased() + s.dropFirst()
    }
}

extension Row {
    // The row with its folder's last part, from the board's cwd.
    func `in`(_ cwd: String?) -> Row {
        var r = self
        r.project = cwd.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0).lastPathComponent }
        return r
    }
}
