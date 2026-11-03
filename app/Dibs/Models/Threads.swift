import Foundation

// `dibs threads --json` (0.0.80): one conversation per agent. An agent's
// questions, its notes ("done", "blocked on the build"), the person's answers
// and messages, and a receipt when a message reached it. Older dibs has no
// threads; ThreadList(questions:) builds the same shape from its questions.
struct ThreadList: Decodable, Sendable {
    var threads: [AgentThread]
    // The agent that answers the person's chat (config "desk"), or nil when none is set.
    var desk: String?

    init(threads: [AgentThread]) { self.threads = threads }

    enum CodingKeys: String, CodingKey { case threads, desk }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threads = (c.lenient(.threads) as [Lenient<AgentThread>]?)?.compactMap(\.value) ?? []
        desk = c.lenient(.desk)
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

    enum CodingKeys: String, CodingKey { case agent, label, agentId, to, alive, working, unread, last, messages, desk }

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

    enum CodingKeys: String, CodingKey { case id, at, from, kind, text, options, questionId, state, about, answer, why, by, reply }

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
    }
}
