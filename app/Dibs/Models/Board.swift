import Foundation

// `dibs --json`. Field names are the CLI's. Times are ms since the epoch and
// durations are ms, as dibs writes them. Anything the app can live without is
// optional, so a board from an older or newer dibs still decodes.
struct Board: Decodable, Sendable {
    var machine: Machine
    var held: [Lease]
    var waiting: [Waiter]
    var quotas: [Quota]
    var subagents: Subagents?
    var elsewhere: Elsewhere?
    // This machine as the group knows it (0.0.70 and newer).
    var me: Me?
    // Agents the owner capped, by name.
    var caps: [String: Cap]
    // One per resource, busiest first, in plain words (0.0.80 and newer).
    var lines: [BoardLine]?
    // 0.0.86: what holds every new job back right now, as the end of
    // "nothing new starts until ...", or empty; and the limits dibs starts
    // work by, in one line.
    var hold: String?
    var limits: String?
    // 0.0.178: what's wrong, each with its fix (src/alerts.mjs). nil from an older dibs.
    var alerts: [DibsAlert]?
    // Agents waiting on dibs listen (0.0.179 and newer): a message wakes them within seconds.
    var listening: [String]

    struct Cap: Decodable, Sendable { var prio: String; var at: Double? }
    struct Me: Decodable, Sendable { var name: String }

    enum CodingKeys: String, CodingKey { case machine, held, waiting, quotas, agents, elsewhere, me, caps, lines, hold, limits, alerts, listening }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machine = try c.decode(Machine.self, forKey: .machine)
        held = try c.decodeIfPresent([Lease].self, forKey: .held) ?? []
        waiting = try c.decodeIfPresent([Waiter].self, forKey: .waiting) ?? []
        quotas = c.lenient(.quotas) ?? []
        subagents = c.lenient(.agents)
        elsewhere = c.lenient(.elsewhere)
        me = c.lenient(.me)
        caps = c.lenient(.caps) ?? [:]
        lines = c.lenient(.lines)
        alerts = c.lenient(.alerts)
        listening = c.lenient(.listening) ?? []
        hold = (c.lenient(.hold) as String?).flatMap { $0.isEmpty ? nil : $0 }
        limits = (c.lenient(.limits) as String?).flatMap { $0.isEmpty ? nil : $0 }
    }
}

struct Machine: Decodable, Sendable {
    var memFree: Double?
    var diskFree: Double?
    var swapUsed: Double?
    var load: Double?
    var cores: Int?
    var pace: String?
    var maxLoad: Double?
    // The memory dibs shares out to jobs and how much running jobs have.
    var memHandedOut: Double?
    var memBudget: Double?
}

// The owner's hand in a row: a boost or a cap, and the priority it set.
// `by` is the agent that made it, or nil for the person.
struct OwnerMark: Decodable, Sendable {
    var act: String
    var prio: String
    private var byField: Lenient<String>?
    private var reasonField: Lenient<String>?
    var by: String? { byField?.value.flatMap { $0.isEmpty ? nil : $0 } }
    var reason: String? { reasonField?.value.flatMap { $0.isEmpty ? nil : $0 } }

    enum CodingKeys: String, CodingKey { case act, prio, byField = "by", reasonField = "reason" }

    // The same words as ownerLabel in src/override.mjs.
    func label(asked: String?) -> String {
        let who = by ?? "owner"
        if act == "cap" { return "capped \(prio) by \(who)" }
        let did = "\(Prio(prio).order < Prio(asked).order ? "boosted" : "lowered") by \(who)"
        return reason.map { "\(did): \($0)" } ?? did
    }
}

// An agent's change to its own job's priority. Rows carry one only while the
// person hasn't set the priority themselves; their mark wins.
struct AgentBoost: Decodable, Sendable {
    var prio: String
    // The priority before the agent's first change.
    var from: String?
    var reason: String?
    // The agent session that changed it.
    var by: String?
    var at: Double?

    // The same words as the CLI's board.
    var label: String {
        guard Prio(prio).order < Prio(from).order else { return "lowered by the agent" }
        guard let reason, !reason.isEmpty else { return "boosted by the agent" }
        return "boosted by the agent: \(reason)"
    }
}

struct Lease: Decodable, Sendable {
    struct Pause: Decodable, Sendable {
        var who: String?
        var lease: Int?
        var owner: Bool?
        var disk: Bool?
        // A pause by hand names the agent that made it in `by`; none means
        // the person. Older states marked an agent's pause `agent: true`.
        private var agentField: Lenient<Bool>?
        private var byField: Lenient<String>?
        var agent: Bool? { agentField?.value }
        var by: String? { byField?.value.flatMap { $0.isEmpty ? nil : $0 } }
        var byHand: Bool { owner == true || agent == true }

        enum CodingKeys: String, CodingKey { case who, lease, owner, disk, agentField = "agent", byField = "by" }
    }

    var id: Int
    var res: [String]
    var who: String
    var agent: String?
    var label: String?
    var purpose: String?
    var cmd: String?
    var prio: String?
    var kind: String?
    var start: Double
    var remaining: Double?
    var idleMs: Double?
    var pausedAt: Double?
    var pauses: [Pause]?
    var owner: OwnerMark?
    var askedPrio: String?
    var plain: HeldPlain?
    // 0.0.86: which subagent of the session asked, and what the job really
    // used. Lenient, so a shape this app doesn't know never costs the board.
    private var agentIdField: Lenient<String>?
    private var overAskField: Lenient<OverAsk>?
    private var agentBoostField: Lenient<AgentBoost>?
    var agentId: String? { agentIdField?.value }
    // Hidden while the person's own mark is on the row.
    var agentBoost: AgentBoost? { owner == nil ? agentBoostField?.value : nil }
    var overAsk: OverAsk? { overAskField?.value.flatMap { $0.used != nil && $0.asked != nil ? $0 : nil } }

    struct OverAsk: Decodable, Sendable, Hashable {
        var used: Double?
        var asked: Double?
        var suggest: String?
    }

    // The folder the job runs in; the panel shows its last part, as the web page does.
    private var cwdField: Lenient<String>?
    var cwd: String? { cwdField?.value }

    enum CodingKeys: String, CodingKey {
        case id, res, who, agent, label, purpose, cmd, prio, kind, start, remaining, idleMs, pausedAt, pauses, owner, askedPrio, plain
        case agentIdField = "agentId", overAskField = "overAsk", agentBoostField = "agentBoost", cwdField = "cwd"
    }

    // The same words the CLI's board prints (pauseLabel in src/preempt.mjs).
    var pauseLabel: String? {
        guard pausedAt != nil else { return nil }
        if let hand = (pauses ?? []).first(where: \.byHand) { return "paused by \(hand.by ?? "owner")" }
        var by: [String] = []
        for p in pauses ?? [] where p.lease != nil {
            if let who = p.who, !by.contains(who) { by.append(who) }
        }
        if !by.isEmpty { return "paused for \(by.joined(separator: ", "))" }
        return (pauses ?? []).contains { $0.disk == true } ? "paused: disk low" : "paused: memory pressure"
    }
}

struct Waiter: Decodable, Sendable {
    struct Rank: Decodable, Sendable {
        struct Part: Decodable, Sendable, Hashable { var label: String; var shift: Double }
        var parts: [Part]
    }

    var id: Int
    var place: Int?
    var res: [String]
    var who: String
    var agent: String?
    var label: String?
    var purpose: String?
    var cmd: String?
    var prio: String?
    var enq: Double
    var expectStart: Double?
    var by: Double?
    // Without "blocked by ": "slot: xcode-build", "behind web-app". nil for a
    // kept place, whose agent's process is gone.
    var blocked: String?
    var rank: Rank?
    var pid: Int?
    var owner: OwnerMark?
    var askedPrio: String?
    var plain: WaitPlain?
    private var agentIdField: Lenient<String>?
    private var agentBoostField: Lenient<AgentBoost>?
    var agentId: String? { agentIdField?.value }
    var agentBoost: AgentBoost? { owner == nil ? agentBoostField?.value : nil }
    private var cwdField: Lenient<String>?
    var cwd: String? { cwdField?.value }

    enum CodingKeys: String, CodingKey {
        case id, place, res, who, agent, label, purpose, cmd, prio, enq, expectStart, by, blocked, rank, pid, owner, askedPrio, plain
        case agentIdField = "agentId", agentBoostField = "agentBoost", cwdField = "cwd"
    }
}

struct Quota: Decodable, Sendable, Hashable {
    var name: String
    var left: Double?
    var limit: Double?
    var per: String?
    var error: String?
}

struct Subagents: Decodable, Sendable {
    struct Running: Decodable, Sendable { var who: String; var type: String? }
    var slots: Int
    var running: [Running]
}

// The coordinator's view of every machine in the group. `error` instead of
// machines when it couldn't be reached.
struct Elsewhere: Decodable, Sendable {
    var machines: [Peer]?
    var error: String?
}

struct Peer: Decodable, Sendable, Identifiable {
    var name: String
    var load: Double?
    var memFree: Double?
    var diskFree: Double?
    var version: String?
    var lost: Bool?
    var age: Double?
    var board: PeerBoard?
    // An on-demand VM's state, and why it can't be used or woken.
    private var ondemandField: Lenient<OnDemand>?
    var ondemand: OnDemand? { ondemandField?.value }

    var id: String { name }

    enum CodingKeys: String, CodingKey { case name, load, memFree, diskFree, version, lost, age, board, ondemandField = "ondemand" }

    struct OnDemand: Decodable, Sendable {
        struct CantWake: Decodable, Sendable { var why: String; var until: Double? }
        var state: String?
        var problem: String?
        var cantWake: CantWake?
    }
}

// Other machines' rows: no ids or pids, and times as durations so two clocks
// needn't agree (boardOf in src/board.mjs).
struct PeerBoard: Decodable, Sendable {
    struct Held: Decodable, Sendable {
        var res: [String]
        var who: String
        var label: String?
        var `for`: Double
        var left: Double?
        var paused: String?
        var purpose: String?
        var cmd: String?
        var prio: String?
        var owner: String?
        // The agent's change to its own priority, as a label; shown only
        // without the person's mark.
        private var byAgentField: Lenient<String>?
        var byAgent: String? { owner == nil ? byAgentField?.value.flatMap { $0.isEmpty ? nil : $0 } : nil }

        enum CodingKeys: String, CodingKey {
            case res, who, label, `for`, left, paused, purpose, cmd, prio, owner
            case byAgentField = "byAgent"
        }
    }
    struct Waiting: Decodable, Sendable {
        var res: [String]
        var who: String
        var label: String?
        var waited: Double
        var `in`: Double?
        var due: Double?
        // Still "blocked by ..." in this form.
        var blocked: String?
        var kept: Bool?
        var purpose: String?
        var prio: String?
        var owner: String?
        private var byAgentField: Lenient<String>?
        var byAgent: String? { owner == nil ? byAgentField?.value.flatMap { $0.isEmpty ? nil : $0 } : nil }

        enum CodingKeys: String, CodingKey {
            case res, who, label, waited, `in`, due, blocked, kept, purpose, prio, owner
            case byAgentField = "byAgent"
        }
    }
    var held: [Held]
    var waiting: [Waiting]
    var free: [String]?
}

extension KeyedDecodingContainer {
    // A field the app can do without: missing or malformed reads as nil
    // instead of failing the whole board.
    func lenient<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}
