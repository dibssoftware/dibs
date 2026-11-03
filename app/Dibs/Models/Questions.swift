import Foundation

// `dibs questions --json`: what agents asked the person, and the working
// hours they ask within.
struct QuestionList: Decodable, Sendable {
    var questions: [Question]
    var hours: Hours?
    // How many wait on the person, as dibs counts them (0.0.119).
    var waitingCount: Int?

    enum CodingKeys: String, CodingKey { case questions, hours, waitingCount = "open" }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        questions = try c.decode([Question].self, forKey: .questions)
        hours = c.lenient(.hours)
        waitingCount = c.lenient(.waitingCount)
    }

    struct Hours: Decodable, Sendable, Equatable {
        var start: String
        var end: String
    }

    // Open ones in the order to answer them: an agent blocked on it now
    // first, then the most urgent, the one due soonest, the one asked earliest.
    // Off-hours questions held for tomorrow go last.
    var open: [Question] {
        func key(_ q: Question) -> (Int, Int, Int, Double, Double) {
            (q.held ? 1 : 0, q.waiting ? 0 : 1, q.prio.order, q.due ?? .infinity, q.asked)
        }
        return questions.filter { $0.state == .open }.sorted { key($0) < key($1) }
    }

    var closed: [Question] {
        questions.filter { $0.state != .open }.sorted { ($0.answeredAt ?? $0.asked) > ($1.answeredAt ?? $1.asked) }
    }
}

struct Question: Decodable, Sendable, Identifiable, Hashable {
    enum State: String, Decodable, Sendable {
        // decided: a two-way question its agent settled itself (0.0.119).
        case open, answered, dismissed, expired, decided
    }

    var id: String
    var who: String
    var agent: String?
    var text: String
    var purpose: String
    // An agent is blocked on the answer right now.
    var waiting: Bool
    // Asked outside working hours and held for the morning.
    var held: Bool
    var options: [String]?
    var prio: Prio
    var asked: Double
    var due: Double?
    var state: State
    var answer: String?
    var answeredAt: Double?
    // Who answered: "the person", or the agent that answered in their place.
    var answeredBy: String?
    // 0.0.119: only a one-way question (something that can't be undone)
    // reaches the person; an agent decides a two-way one itself. A dibs
    // older than that sends no flag, and every question it has is the
    // person's to answer.
    var oneWay: Bool
    // The option the agent would pick and why, and what can't be undone.
    var recommend: String?
    var why: String?
    var cantUndo: String?

    enum CodingKeys: String, CodingKey {
        case id, who, agent, text, purpose, waiting, held, options, prio, asked, due, state, answer, answeredAt, answeredBy, oneWay, recommend, why, cantUndo
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // dibs question ids are numbers (app-contract.md). A string is read too, so a stand-in dibs can't break the list.
        if let n = try? c.decode(Int.self, forKey: .id) { id = String(n) } else { id = try c.decode(String.self, forKey: .id) }
        who = try c.decode(String.self, forKey: .who)
        agent = c.lenient(.agent)
        text = try c.decode(String.self, forKey: .text)
        purpose = c.lenient(.purpose) ?? ""
        waiting = c.lenient(.waiting) ?? false
        held = c.lenient(.held) ?? false
        options = c.lenient(.options)
        prio = Prio(c.lenient(.prio) as String?)
        asked = try c.decode(Double.self, forKey: .asked)
        due = c.lenient(.due)
        // A state this app doesn't know yet is treated as closed, not as a question to answer.
        state = (c.lenient(.state) as String?).flatMap(State.init(rawValue:)) ?? .expired
        answer = c.lenient(.answer)
        answeredAt = c.lenient(.answeredAt)
        answeredBy = c.lenient(.answeredBy)
        oneWay = c.lenient(.oneWay) ?? true
        recommend = c.lenient(.recommend)
        why = c.lenient(.why)
        cantUndo = c.lenient(.cantUndo)
    }

    var askedDate: Date { Date(ms: asked) }
    var dueDate: Date? { due.map(Date.init(ms:)) }
}

extension Prio {
    var order: Int { Prio.allCases.firstIndex(of: self) ?? 2 }
}
