import Foundation

// `dibs history --json --since 7d`.
struct History: Decodable, Sendable {
    struct Resource: Decodable, Sendable {
        var busyMs: Double
        var waits: Int
        var waitMs: Double
        var p50WaitMs: Double?
        var p90WaitMs: Double?
        var peakQueue: Int?
        var timeouts: Int?
        // 0.0.86: the hours of the day most of its waiting fell in, local
        // time, as [first hour, how many]. Worked out from every wait, not
        // just the newest events.
        var mostly: [Int]?

        enum CodingKeys: String, CodingKey { case busyMs, waits, waitMs, p50WaitMs, p90WaitMs, peakQueue, timeouts, mostly }

        init(busyMs: Double, waits: Int, waitMs: Double, p50WaitMs: Double?, p90WaitMs: Double?, peakQueue: Int?, timeouts: Int?,
             mostly: [Int]? = nil) {
            self.busyMs = busyMs
            self.waits = waits
            self.waitMs = waitMs
            self.p50WaitMs = p50WaitMs
            self.p90WaitMs = p90WaitMs
            self.peakQueue = peakQueue
            self.timeouts = timeouts
            self.mostly = mostly
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            busyMs = try c.decode(Double.self, forKey: .busyMs)
            waits = try c.decode(Int.self, forKey: .waits)
            waitMs = try c.decode(Double.self, forKey: .waitMs)
            p50WaitMs = c.lenient(.p50WaitMs)
            p90WaitMs = c.lenient(.p90WaitMs)
            peakQueue = c.lenient(.peakQueue)
            timeouts = c.lenient(.timeouts)
            mostly = c.lenient(.mostly)
        }
    }
    struct Agent: Decodable, Sendable {
        var runs: Int
        var holdMs: Double
        var waitMs: Double
        var timeouts: Int?
    }
    struct Hour: Decodable, Sendable {
        var hour: Double
        var load: Double?
        var waiting: Double
        var held: Double?
        var memFree: Double?
        var diskFree: Double?
    }
    struct Event: Decodable, Sendable {
        var at: Double
        var kind: String
        var id: Int?
        var res: [String]?
        var who: String?
        // On an end: how long it held, and the command's exit code (none for a hold).
        var ms: Double?
        var code: Int?
        // A subagent's name or kind, on 0.0.86's twin events.
        var label: String?
        var agentId: String?
        // On an override: what was done ("boost", "pause", "cap", "pace",
        // ...), the priority it set and had, and why. `by` names who did it:
        // an agent's session name with `byAgent` true, or "the person".
        // 0.0.91 to 0.0.109 wrote `by: "agent"` with the name in `agent`.
        var act: String?
        var prio: String?
        var from: String?
        var by: String?
        var byAgent: Bool?
        var agent: String?
        var reason: String?

        enum CodingKeys: String, CodingKey { case at, kind, id, res, who, ms, code, label, agentId, act, prio, from, by, byAgent, agent, reason }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            at = try c.decode(Double.self, forKey: .at)
            kind = try c.decode(String.self, forKey: .kind)
            id = c.lenient(.id)
            who = c.lenient(.who)
            ms = c.lenient(.ms)
            code = c.lenient(.code)
            label = c.lenient(.label)
            agentId = c.lenient(.agentId)
            act = c.lenient(.act)
            prio = c.lenient(.prio)
            from = c.lenient(.from)
            by = c.lenient(.by)
            byAgent = c.lenient(.byAgent)
            agent = c.lenient(.agent)
            reason = c.lenient(.reason)
            // One resource or several, depending on the event.
            if let one: String = c.lenient(.res) { res = [one] } else { res = c.lenient(.res) }
        }

        // The agent that made an override, or nil for the person's.
        var changedBy: String? {
            guard kind == "override" else { return nil }
            if by == "agent" { return agent ?? who }
            guard byAgent == true else { return nil }
            // An agent's change whose name didn't come through still belongs on the list.
            return by.flatMap { $0.isEmpty ? nil : $0 } ?? "an agent"
        }

        // An agent's change, as a line: "alex-b4 boosted #4221 to
        // urgent: person waiting on the fix", "web-app paused alex-b5's
        // #12", "web-app ran dibs pace". nil for the person's.
        func agentLine(name: (String) -> String = { $0 }) -> String? {
            guard let by = changedBy, let act else { return nil }
            var job = id.map { "#\($0)" } ?? "a job"
            if let who, who != by, id != nil { job = "\(name(who))'s \(job)" }
            let did: String
            switch act {
            case "boost":
                guard let prio else { return nil }
                let (to, was) = (Prio(prio).order, Prio(from).order)
                did = "\(to < was ? "boosted" : to > was ? "lowered" : "set") \(job) to \(prio)"
            case "pause": did = "paused \(job)"
            case "resume": did = "resumed \(job)"
            case "stop": did = "stopped \(job)"
            case "cap":
                guard let who, let prio else { return nil }
                did = prio == "off" ? "took the cap off \(name(who))" : "capped \(name(who)) at \(prio)"
            default: did = "ran dibs \(act)"
            }
            guard let reason, !reason.isEmpty else { return "\(name(by)) \(did)" }
            return "\(name(by)) \(did): \(reason)"
        }
    }

    // The newest agent changes first.
    var agentChanges: [Event] { events.filter { $0.agentLine() != nil }.reversed() }

    var since: Double
    var until: Double
    var resources: [String: Resource]
    var agents: [String: Agent]
    var hourly: [Hour]
    var events: [Event]

    enum CodingKeys: String, CodingKey { case since, until, resources, agents, hourly, events }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        since = try c.decode(Double.self, forKey: .since)
        until = try c.decode(Double.self, forKey: .until)
        resources = try c.decodeIfPresent([String: Resource].self, forKey: .resources) ?? [:]
        agents = try c.decodeIfPresent([String: Agent].self, forKey: .agents) ?? [:]
        hourly = try c.decodeIfPresent([Hour].self, forKey: .hourly) ?? []
        events = c.lenient(.events) ?? []
    }

    // The resource agents spent the most time waiting for.
    var bottleneck: (name: String, stats: Resource)? {
        resources.filter { $0.value.waitMs > 0 }.max { $0.value.waitMs < $1.value.waitMs }.map { ($0.key, $0.value) }
    }

    // The hour of the week with the longest line.
    var busiestHour: Hour? {
        hourly.filter { $0.waiting > 0 }.max { $0.waiting < $1.waiting }
    }

    // When a resource's line formed: the hours dibs says most of its waiting
    // fell in, or else the busiest hour of the events, but only when the
    // events reach back over the whole range. --json sends only the newest
    // 2000 (EVENT_CAP in src/history.mjs), which on a busy week is the last
    // few hours, and "busiest hour this week" from those would be wrong.
    func busiest(for resource: String, calendar: Calendar = .current) -> String? {
        if let m = resources[resource]?.mostly, m.count == 2, m[1] > 0, m[1] < 24 {
            return m[1] == 1 ? Format.hourName(m[0]) : "\(Format.hourName(m[0])) to \(Format.hourName(m[0] + m[1]))"
        }
        guard eventsCoverRange, let hour = worstHour(for: resource, calendar: calendar) else { return nil }
        return hour.formatted(.dateTime.weekday(.abbreviated).hour())
    }

    // Whether the events go back to the start of the range: fewer than the
    // CLI's cap, or the oldest within an hour of `since`.
    static let eventCap = 2000
    var eventsCoverRange: Bool {
        events.count < Self.eventCap || (events.map(\.at).min() ?? .infinity) <= since + 3_600_000
    }

    // The hour with the most waits that started in it. A rerun that picks up
    // a kept place writes a second wait with the same id; it's still one wait.
    func worstHour(for resource: String, calendar: Calendar = .current) -> Date? {
        var counts: [Date: Int] = [:]
        var seen: Set<Int> = []
        for e in events where e.kind == "wait" && (e.res ?? []).contains(resource) {
            if let id = e.id, !seen.insert(id).inserted { continue }
            guard let hour = calendar.dateInterval(of: .hour, for: Date(ms: e.at))?.start else { continue }
            counts[hour, default: 0] += 1
        }
        return counts.max { $0.value != $1.value ? $0.value < $1.value : $0.key > $1.key }?.key
    }
}

extension History {
    // The hours of the day lines usually formed in: every hour with at least
    // half the busiest hour's waiting, first to last. The clock wraps, so the
    // span is the shortest way round that holds them all: busy at 11 PM and
    // 1 AM is 11 PM to 2 AM, not 1 AM to midnight. nil when nobody waited.
    func peakHours(calendar: Calendar = .current) -> (start: Int, hours: Int)? {
        var byHour = [Double](repeating: 0, count: 24)
        for h in hourly { byHour[calendar.component(.hour, from: Date(ms: h.hour))] += h.waiting }
        guard let top = byHour.max(), top > 0 else { return nil }
        let busy = byHour.indices.filter { byHour[$0] >= top / 2 }
        // The longest stretch of quiet hours, going round the clock, is what the span leaves out.
        var start = busy[0], gap = busy[0] + 24 - busy.last! - 1
        for (a, b) in zip(busy, busy.dropFirst()) where b - a - 1 > gap {
            gap = b - a - 1
            start = b
        }
        return (start, 24 - gap)
    }

    // The week in two or three plain sentences: where the waiting was, when,
    // and how bad it got.
    func note(days: Int, calendar: Calendar = .current) -> (headline: String, body: String) {
        let span = days == 1 ? "in the past day" : "this week"
        guard let (name, r) = bottleneck, r.waits > 0 else {
            return ("Nobody waited \(span).", "Every turn started as soon as an agent asked for it.")
        }
        var body = "Agents waited \(Plain.about(r.waitMs / 1000).replacingOccurrences(of: "about ", with: "")) in all for \(Plain.inSentence(name))"
        if let hours = peakHours(calendar: calendar), hours.hours < 24 {
            body += ", mostly between \(Format.hourName(hours.start)) and \(Format.hourName(hours.start + hours.hours))"
        }
        body += "."
        if let p50 = r.p50WaitMs, let p90 = r.p90WaitMs, r.waits > 1 {
            body += " A typical wait was \(Plain.about(p50 / 1000).replacingOccurrences(of: "about ", with: "")), and one in ten took over \(Plain.about(p90 / 1000).replacingOccurrences(of: "about ", with: ""))."
        }
        if let gaveUp = r.timeouts, gaveUp > 0 {
            body += gaveUp == 1 ? " One agent gave up waiting." : " \(gaveUp) agents gave up waiting."
        }
        let others = resources.filter { $0.key != name && $0.value.waits > 0 }.sorted { $0.value.waitMs > $1.value.waitMs }
        if let (second, s) = others.first {
            body += " Next was \(Plain.inSentence(second)), at \(Plain.about(s.waitMs / 1000).replacingOccurrences(of: "about ", with: ""))."
        }
        return ("Most of the waiting \(span) was for \(Plain.inSentence(name)).", body)
    }
}
