import Foundation

// Everything agents say to the person, as one conversation. The person used
// to find questions on Home, notes in Messages and decisions nowhere, and
// never knew which ones needed them. Here each line says what it is:
//
//   ask      a one-way question: the agent can't undo what it wants to do,
//            so it waits for the person. Options, a recommendation, a reply.
//   note     an agent telling the person something. Nothing to do.
//   decided  a two-way question the agent settled itself, logged. The person
//            can overrule it by replying.
//   mine     what the person said or answered.
//
// dibs's own notices to agents (stuck jobs, memory) and what agents tell each
// other are their own streams (ThreadList.between, .fromDibs), never here.
struct ChatItem: Identifiable, Sendable, Hashable {
    enum Kind: Sendable, Hashable { case ask, note, decided, mine }

    var id: String
    var kind: Kind
    var at: Double
    // The thread it belongs to, by the name `dibs tell` takes.
    var to: String
    // The agent's handle, for its display name and its tile.
    var agent: String
    var label: String?
    var text: String
    // An ask's question; an answered or closed one shows as history.
    var question: ChatQuestion?
    // What a decision chose, and why.
    var chose: String?
    var why: String?
    // Said by the desk, the agent that answers for dibs.
    var desk = false
    // An agent that wrote this in the person's place: it reads as that
    // agent's, never as the person's.
    var by: String?
    // The person's message, not yet handed to its agent (its next tool call does that).
    var queued = false
    // The person's message: whether and how it reached the agent, in plain words.
    var delivery: String?

    var date: Date { Date(ms: at) }
}

struct ChatQuestion: Sendable, Hashable {
    var id: String
    var options: [String]
    // The option the agent would pick, and why.
    var recommend: String?
    var why: String?
    // What can't be undone once it's done.
    var cantUndo: String?
    var open: Bool
    var answer: String?
    var state: String
}

enum Chat {
    // What the box writes to with no one picked: dibs sends it to the agent
    // config.json names as the desk.
    static let desk = "desk"

    // The conversation, oldest first, with the questions still waiting on the
    // person last, next to the box they answer in.
    static func items(threads: [AgentThread], questions: [Question], desk: String? = nil) -> [ChatItem] {
        let byId = Dictionary(questions.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [ChatItem] = []
        for t in threads {
            let receipts = Dictionary(t.messages.filter { $0.kind == "delivered" }.compactMap { m in m.about.map { ($0, m) } }, uniquingKeysWith: { a, _ in a })
            for m in t.messages {
                guard let kind = kind(of: m, question: m.questionId.flatMap { byId[$0] }) else { continue }
                let q = m.questionId.flatMap { byId[$0] }
                var item = ChatItem(id: "\(t.to)-\(m.id)", kind: kind, at: m.at, to: t.to, agent: t.agent, label: t.label, text: m.text,
                                    chose: m.answer ?? (kind == .decided ? q?.answer ?? q?.recommend : nil), why: m.why ?? q?.why,
                                    desk: isDesk(t, desk) && (m.reply || m.fromPerson || t.agent == Self.desk), by: m.fromPerson ? m.by : nil,
                                    queued: m.fromPerson && m.state == "queued",
                                    delivery: m.fromPerson && m.kind == "message"
                                        ? Reach.words(state: m.state, deliveredAt: m.deliveredAt, via: m.via, reach: t.reach, receipt: receipts[m.id]) : nil)
                if m.kind == "question" {
                    let open = (q?.state ?? Question.State(rawValue: m.state ?? "") ?? .expired) == .open
                    item.question = ChatQuestion(id: m.questionId ?? m.id, options: q?.options ?? m.options ?? [],
                                                 recommend: q?.recommend, why: q?.why, cantUndo: q?.cantUndo,
                                                 open: open, answer: q?.answer, state: q?.state.rawValue ?? m.state ?? "")
                }
                out.append(item)
            }
        }
        // A question that's in no thread yet (an older dibs, or a poll in
        // between) still reaches the person.
        let shown = Set(out.compactMap { $0.question?.id })
        for q in questions where q.state == .open && q.oneWay && !shown.contains(q.id) {
            out.append(ChatItem(id: "q-\(q.id)", kind: .ask, at: q.asked, to: q.agent ?? q.who, agent: q.agent ?? q.who, label: nil, text: q.text,
                                question: ChatQuestion(id: q.id, options: q.options ?? [], recommend: q.recommend, why: q.why,
                                                       cantUndo: q.cantUndo, open: true, answer: nil, state: "open")))
        }
        let waiting = { (i: ChatItem) in i.kind == .ask && i.question?.open == true }
        return out.filter { !waiting($0) }.sorted { $0.at < $1.at } + out.filter(waiting).sorted { $0.at < $1.at }
    }

    // The desk is also an agent with its own work: only its replies to the
    // person, and what the person says to it, speak for dibs.
    static func isDesk(_ t: AgentThread, _ desk: String?) -> Bool {
        t.desk || t.agent == desk || t.agent == Self.desk
    }

    // What a thread message is to the person, or nil for what they don't see:
    // dibs's notices to agents, delivery receipts.
    static func kind(of m: ThreadMessage, question q: Question?) -> ChatItem.Kind? {
        if m.fromDibs || m.kind == "delivered" || m.kind == "notice" { return nil }
        // Another agent's message to this one: the between-agents stream's, not the person's conversation.
        if m.fromPerson && m.by != nil { return nil }
        // dibs copies a worded answer into the thread as a message for the
        // agent; the answer itself already shows.
        if m.fromPerson && m.kind == "message" && m.text.hasPrefix("(answering your question #") { return nil }
        if m.fromPerson { return .mine }
        if m.kind == "decided" { return .decided }
        if m.kind == "question" {
            // A two-way question is the agent's to settle: once settled it's
            // a decision on the record, and while open it's only news.
            if let q, !q.oneWay || q.state == .decided { return q.state == .open ? .note : .decided }
            return .ask
        }
        return .note
    }

    // The questions waiting on the person: what the badge and the menu bar count.
    static func waiting(_ items: [ChatItem]) -> [ChatItem] {
        items.filter { $0.kind == .ask && $0.question?.open == true }
    }
}
