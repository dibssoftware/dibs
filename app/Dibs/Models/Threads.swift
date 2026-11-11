import Foundation

// `dibs threads --json` (0.0.80): one conversation per agent. An agent's
// questions, its notes ("done", "blocked on the build"), the person's answers
// and messages, and a receipt when a message reached it. Older dibs has no
// threads; ThreadList(questions:) builds the same shape from its questions.
struct ThreadList: Decodable, Sendable {
    var threads: [AgentThread]
    // The agent that answers the person's chat (config "desk"), or nil when none is set.
    var desk: String?
    // What agents tell each other, and what dibs tells agents (0.0.180): the person's to look
    // at, never part of their conversations. Older dibs sends neither.
    var between: [StreamItem] = []
    var fromDibs: [StreamItem] = []

    init(threads: [AgentThread]) { self.threads = threads }

    enum CodingKeys: String, CodingKey { case threads, desk, between, fromDibs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threads = (c.lenient(.threads) as [Lenient<AgentThread>]?)?.compactMap(\.value) ?? []
        desk = c.lenient(.desk)
        between = (c.lenient(.between) as [Lenient<StreamItem>]?)?.compactMap(\.value) ?? []
        fromDibs = (c.lenient(.fromDibs) as [Lenient<StreamItem>]?)?.compactMap(\.value) ?? []
    }

    // One thread per agent from 0.0.70's questions: each question, then its answer.
    init(questions: [Question]) {
        var byAgent: [String: [Question]] = [:]
        for q in questions { byAgent[q.agent ?? q.who, default: []].append(q) }
        threads = byAgent.map { agent, qs in
            let messages = qs.sorted { $0.asked < $1.asked }.flatMap { q -> [ThreadMessage] in
                var out = [ThreadMessage(id: "q\(q.id)", at: q.asked, from: "agent", kind: "question", text: q.text,
                                         options: q.options, questionId: q.id, state: q.state.rawValue)]
                if q.state == .answered, let answer = q.answer {
                    out.append(ThreadMessage(id: "q\(q.id)a", at: q.answeredAt ?? q.asked, from: "person", kind: "answer", text: answer,
                                             questionId: q.id, state: "delivered"))
                }
                return out
            }
            return AgentThread(agent: agent, to: agent, alive: true, working: nil,
                               unread: qs.filter { $0.state == .open }.count, last: messages.map(\.at).max() ?? 0, messages: messages)
        }
        .sorted { $0.last > $1.last }
    }
}

struct AgentThread: Decodable, Sendable, Identifiable {
    var agent: String
    var label: String?
    // "main", or Claude Code's id for a subagent.
    var agentId: String?
    // The name `dibs tell` and `dibs threads read` take.
    var to: String
    var alive: Bool
    var working: String?
    var unread: Int
    var last: Double
    var messages: [ThreadMessage]
    // The desk's own thread: its replies speak for dibs.
    var desk = false
    // How a message sent now would reach it (Reach), from 0.0.180; guessed for older dibs.
    var reach: Reach { reachRaw.flatMap(Reach.init(rawValue:)) ?? (!alive ? .ended : working == "listening" ? .listening : .working) }
    var reachRaw: String?
    // A subagent's thread: "web-app/tests".
    var isSub: Bool { to != agent && to.hasPrefix("\(agent)/") }

    var id: String { to }

    // Read here: the thread's `last` when the person opened it. Until the
    // thread moves past that, its unread are ones they've seen, even if the
    // CLI hasn't caught up yet. A newer note shows as unread again.
    func hidingRead(at seenLast: Double?) -> AgentThread {
        guard let seenLast, last <= seenLast else { return self }
        var t = self
        t.unread = 0
        return t
    }
    var openQuestions: [ThreadMessage] { messages.filter { $0.kind == "question" && $0.state == "open" } }
    // A subagent's thread is named after its label: "web-app / tests". A main
    // agent's label is its own name.
    // dibs sends "" for a thread with no label (a main agent's, from 0.0.80 on), which is no label.
    var name: String { label.flatMap { $0.isEmpty || $0 == agent ? nil : "\(agent) / \($0)" } ?? agent }
    var isMain: Bool { agentId == nil || agentId == "main" }

    // What it's doing now, as a person would say it. dibs writes
    // 'using sim for "purpose"', 'waiting for deploy for "purpose"' or "idle".
    var activity: String {
        guard alive else { return "Not running" }
        guard let w = working, w != "idle", !w.isEmpty else { return "Idle" }
        for (prefix, using) in [("using ", true), ("waiting for ", false)] where w.hasPrefix(prefix) {
            let res = String(w.dropFirst(prefix.count).prefix { $0 != " " })
            return Self.doing(res, using: using)
        }
        return w.prefix(1).uppercased() + w.dropFirst()
    }

    var isWorking: Bool { alive && activity != "Idle" }

    static func doing(_ res: String, using: Bool) -> String {
        let (now, wait): (String, String) = switch res {
        case "sim", "sim-own": ("Using the simulator", "Waiting for the simulator")
        case "xcode-build": ("Building", "Waiting to build")
        case "test": ("Running tests", "Waiting to run tests")
        case "deploy": ("Deploying", "Waiting to deploy")
        case "playwright": ("Running browser tests", "Waiting to run browser tests")
        case "heavy": ("Running a heavy job", "Waiting to run a heavy job")
        default: ("Using \(Plain.inSentence(res))", "Waiting for \(Plain.inSentence(res))")
        }
        return using ? now : wait
    }

    init(agent: String, label: String? = nil, to: String, alive: Bool, working: String?, unread: Int, last: Double, messages: [ThreadMessage]) {
        self.agent = agent
        self.label = label
        self.to = to
        self.alive = alive
        self.working = working
        self.unread = unread
        self.last = last
        self.messages = messages
    }

    enum CodingKeys: String, CodingKey { case agent, label, agentId, to, alive, working, unread, last, messages, desk, reachRaw = "reach" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try c.decode(String.self, forKey: .agent)
        label = c.lenient(.label)
        agentId = c.lenient(.agentId)
        to = c.lenient(.to) ?? agent
        alive = c.lenient(.alive) ?? true
        working = c.lenient(.working)
        unread = c.lenient(.unread) ?? 0
        last = c.lenient(.last) ?? 0
        desk = c.lenient(.desk) ?? false
        reachRaw = c.lenient(.reachRaw)
        messages = ((c.lenient(.messages) as [Lenient<ThreadMessage>]?)?.compactMap(\.value) ?? []).sorted { $0.at < $1.at }
    }
}

struct ThreadMessage: Decodable, Sendable, Identifiable, Hashable {
    var id: String
    var at: Double
    var from: String
    // question, answer, message, note, delivered
    var kind: String
    var text: String
    var options: [String]?
    var questionId: String?
    // Questions: open, answered, dismissed, expired. The person's messages: queued, delivered.
    var state: String?
    // A receipt's message.
    var about: String?
    // A decision's chosen option, or the person's own words for an answer.
    var answer: String?
    var why: String?
    // An agent that sent a message or answered in the person's place.
    var by: String?
    // The desk agent answering the person's chat (dibs say --to person).
    var reply = false
    // When and how dibs handed the person's message over (0.0.180): tool, stop, listen, say, command.
    var deliveredAt: Double?
    var via: String?

    var fromPerson: Bool { from == "person" }
    // 0.0.86: dibs's own notice to the agent about one of its jobs (stuck,
    // over its memory, paused). For the agent; the person sees it in passing.
    var fromDibs: Bool { from == "dibs" }
    var atDate: Date { Date(ms: at) }

    init(id: String, at: Double, from: String, kind: String, text: String, options: [String]? = nil,
         questionId: String? = nil, state: String? = nil, about: String? = nil) {
        self.id = id
        self.at = at
        self.from = from
        self.kind = kind
        self.text = text
        self.options = options
        self.questionId = questionId
        self.state = state
        self.about = about
    }

    enum CodingKeys: String, CodingKey { case id, at, from, kind, text, options, questionId, state, about, answer, why, by, reply, deliveredAt, via }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // Strings since the talk branch ("m12", "q3"); a number is read too.
        if let n: Int = c.lenient(.id) { id = String(n) } else { id = try c.decode(String.self, forKey: .id) }
        at = try c.decode(Double.self, forKey: .at)
        from = c.lenient(.from) ?? "agent"
        kind = c.lenient(.kind) ?? "message"
        text = c.lenient(.text) ?? ""
        options = c.lenient(.options)
        if let n: Int = c.lenient(.questionId) { questionId = String(n) } else { questionId = c.lenient(.questionId) }
        state = c.lenient(.state)
        about = c.lenient(.about)
        answer = c.lenient(.answer)
        why = c.lenient(.why)
        by = c.lenient(.by)
        reply = c.lenient(.reply) ?? false
        deliveredAt = c.lenient(.deliveredAt)
        via = c.lenient(.via)
    }
}

// How a message reaches an agent, in the words the page uses too (web/app.js REACH).
enum Reach: String, Sendable {
    case listening, working, idle, ended, command

    var sentence: String {
        switch self {
        case .listening: "Listening. It gets messages within seconds."
        case .working: "Working. It gets messages at its next step."
        case .idle: "Idle and not listening. It won't see messages until it works again."
        case .ended: "Not running. Messages wait in case it comes back."
        case .command: "Not a Claude Code session. It gets messages the next time it runs dibs say."
        }
    }

    var short: String {
        switch self {
        case .listening: "listening"
        case .working: "working"
        case .idle: "idle, not listening"
        case .ended: "not running"
        case .command: "outside Claude Code"
        }
    }

    // A message not handed over yet.
    var waiting: String {
        switch self {
        case .listening: "Not delivered yet. It gets it within seconds."
        case .working: "Waiting for its next step."
        case .idle: "Not delivered: it's idle and not listening."
        case .ended: "Not delivered: it isn't running."
        case .command: "Waiting for its next dibs say."
        }
    }

    // Can it hear the person soon: the thread's dot.
    var hears: Bool { self == .listening || self == .working }

    // A message's delivery in plain words. receipt: dibs's old "got it ..." line about it.
    static func words(state: String?, deliveredAt: Double?, via: String?, reach: Reach, receipt: ThreadMessage? = nil, now: Date = .now) -> String {
        if state == "queued" { return reach.waiting }
        if state == "expired" { return "Never reached it." }
        let how = via.flatMap { ["tool": "with its next step", "stop": "as it finished its turn", "listen": "while it was listening",
                                 "say": "when it ran dibs say", "command": "with its next dibs command"][$0] }
            ?? receipt.map { $0.text.replacingOccurrences(of: "got it ", with: "") }
        guard let at = deliveredAt ?? receipt?.at else { return "Delivered." }
        return "Delivered \(Span.ago(now.timeIntervalSince(Date(ms: at))))\(how.map { ", \($0)" } ?? "")."
    }
}

// One line of the between-agents stream or the from-dibs stream.
struct StreamItem: Decodable, Sendable, Identifiable, Hashable {
    var id: String
    var at: Double
    // The sending agent (between agents); nil for dibs.
    var from: String?
    var to: String
    // notice or note (from dibs).
    var kind: String?
    var text: String
    var state: String?
    var deliveredAt: Double?
    var via: String?

    var date: Date { Date(ms: at) }
}
