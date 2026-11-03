import Foundation
import Testing

private func questions(_ json: String) throws -> [Question] {
    try JSONDecoder().decode(QuestionList.self, from: Data(json.utf8)).questions
}

private func threads(_ json: String) throws -> [AgentThread] {
    try JSONDecoder().decode(ThreadList.self, from: Data(json.utf8)).threads
}

@Suite("Chat")
struct ChatTests {
    let qs = """
    {"questions": [
      {"id": 21, "who": "web-app", "text": "Drop the sessions table?", "options": ["drop it", "keep it"], "oneWay": true,
       "cantUndo": "the rows are gone for good", "recommend": "drop it", "why": "nothing reads it", "asked": 600, "state": "open"},
      {"id": 19, "who": "onboarding", "text": "New illustrations?", "options": ["yes", "no"], "oneWay": false, "asked": 100, "state": "answered", "answer": "yes"}
    ]}
    """
    let ts = """
    {"threads": [
      {"agent": "web-app", "to": "web-app", "unread": 1, "last": 600, "messages": [
        {"id": "w1", "at": 200, "from": "agent", "kind": "note", "text": "Release is built."},
        {"id": "q30", "at": 300, "from": "agent", "kind": "decided", "text": "Staging or a copy of production?", "questionId": 30,
         "options": ["staging", "a copy of production"], "answer": "a copy of production", "why": "staging has no sessions table", "state": "decided"},
        {"id": "w3", "at": 400, "from": "person", "kind": "message", "text": "Tell me before prod.", "state": "delivered"},
        {"id": "w4", "at": 401, "from": "agent", "kind": "delivered", "text": "got it", "about": "w3"},
        {"id": "w5", "at": 500, "from": "dibs", "kind": "notice", "text": "your job used 9 GB", "state": "delivered"},
        {"id": "q21", "at": 600, "from": "agent", "kind": "question", "text": "Drop the sessions table?", "questionId": 21, "state": "open"}
      ]},
      {"agent": "alex-3b", "to": "alex-3b", "desk": true, "unread": 0, "last": 520, "messages": [
        {"id": "d1", "at": 510, "from": "person", "kind": "message", "text": "why so slow?", "state": "delivered"},
        {"id": "d2", "at": 520, "from": "agent", "kind": "note", "text": "Memory is the limit.", "reply": true},
        {"id": "d3", "at": 530, "from": "agent", "kind": "note", "text": "0.0.122 is live.", "fyi": true}
      ]},
      {"agent": "onboarding", "to": "onboarding", "unread": 0, "last": 110, "messages": [
        {"id": "q19", "at": 100, "from": "agent", "kind": "question", "text": "New illustrations?", "questionId": 19, "state": "answered"},
        {"id": "q19a", "at": 110, "from": "person", "kind": "answer", "text": "yes", "questionId": 19, "state": "delivered"}
      ]}
    ], "desk": "alex-3b"}
    """

    @Test("one conversation, oldest first, with the question waiting on the person last; dibs's notices and receipts left out")
    func order() throws {
        let items = Chat.items(threads: try threads(ts), questions: try questions(qs))
        #expect(items.map(\.kind) == [.decided, .mine, .note, .decided, .mine, .mine, .note, .note, .ask])
        #expect(!items.contains { $0.text.contains("9 GB") || $0.text == "got it" })
        #expect(items.last?.question?.open == true)
        #expect(items.last?.question?.recommend == "drop it")
        #expect(items.last?.question?.cantUndo == "the rows are gone for good")
    }

    @Test("only one-way questions still open count as waiting on the person")
    func waiting() throws {
        let items = Chat.items(threads: try threads(ts), questions: try questions(qs))
        #expect(Chat.waiting(items).map { $0.question?.id } == ["21"])
    }

    @Test("an answered two-way question reads as a decision, not as something the person was asked")
    func twoWayHistory() throws {
        let items = Chat.items(threads: try threads(ts), questions: try questions(qs))
        #expect(items.first?.kind == .decided)
        #expect(items.first?.text == "New illustrations?")
    }

    @Test("a dibs with no oneWay flag: every open question is the person's")
    func olderDibs() throws {
        let old = try questions(#"{"questions": [{"id": 7, "who": "a", "text": "Ship it?", "asked": 1, "state": "open"}]}"#)
        #expect(old[0].oneWay)
        let items = Chat.items(threads: [], questions: old)
        #expect(Chat.waiting(items).count == 1)
    }

    @Test("a two-way question still open on a new dibs isn't waiting on the person")
    func twoWayOpen() throws {
        let q = try questions(#"{"questions": [{"id": 8, "who": "a", "text": "Tabs or spaces?", "oneWay": false, "asked": 1, "state": "open"}]}"#)
        #expect(Chat.waiting(Chat.items(threads: [], questions: q)).isEmpty)
    }

    @Test("a decision carries what the agent chose and why")
    func decision() throws {
        let items = Chat.items(threads: try threads(ts), questions: try questions(qs))
        let d = try #require(items.first { $0.id.hasSuffix("q30") })
        #expect(d.kind == .decided)
        #expect(d.chose == "a copy of production")
        #expect(d.why == "staging has no sessions table")
    }

    @Test("the desk's thread speaks for dibs; other agents' don't")
    func desk() throws {
        let list = try JSONDecoder().decode(ThreadList.self, from: Data(ts.utf8))
        #expect(list.desk == "alex-3b")
        let items = Chat.items(threads: list.threads, questions: try questions(qs), desk: list.desk)
        #expect(items.filter(\.desk).map(\.text) == ["why so slow?", "Memory is the limit."])
        // The desk agent's own news is its own, not dibs's.
        #expect(items.first { $0.text == "0.0.122 is live." }?.desk == false)
        #expect(!items.contains { $0.agent == "web-app" && $0.desk })
    }

    @Test("dibs's count of questions waiting on the person decodes, and a decided question isn't open")
    func counts() throws {
        let list = try JSONDecoder().decode(QuestionList.self, from: Data(#"{"questions": [{"id": 9, "who": "a", "text": "x", "asked": 1, "state": "decided", "oneWay": false}], "open": 0}"#.utf8))
        #expect(list.waitingCount == 0)
        #expect(list.questions[0].state == .decided)
        #expect(list.open.isEmpty)
    }

    @Test("an agent's words in the person's place say whose they are, and dibs's copy of a worded answer isn't shown twice")
    func byAgent() throws {
        let t = try threads(#"""
        {"threads": [{"agent": "b1", "to": "b1", "unread": 0, "last": 3, "messages": [
          {"id": "m1", "at": 1, "from": "person", "kind": "message", "text": "on behalf of the crews", "by": "d3"},
          {"id": "m2", "at": 2, "from": "person", "kind": "answer", "text": "keep it", "questionId": 5},
          {"id": "m3", "at": 3, "from": "person", "kind": "message", "text": "(answering your question #5) keep it"}
        ]}]}
        """#)
        let items = Chat.items(threads: t, questions: [])
        #expect(items.map(\.text) == ["on behalf of the crews", "keep it"])
        #expect(items[0].by == "d3")
        #expect(items[1].by == nil)
    }
}
