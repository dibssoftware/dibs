import Foundation
import Testing

private final class Token {}

private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = try #require(Bundle(for: Token.self).url(forResource: name, withExtension: "json"))
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}

private func row(_ id: Int) throws -> Row {
    try #require(try fixture("board-override-by", as: Board.self).rows().first { $0.leaseID == id })
}

@Suite("Who overrode a job")
struct OverrideByTests {
    @Test("an agent's mark names the agent and its reason, in the label, the move and the sentence")
    func agentMark() throws {
        let boosted = try row(4224)
        #expect(boosted.owner == "boosted by web-app: ci is red")
        #expect(ActionText.owner(try #require(boosted.owner)) == "web-app let it go first: ci is red")
        #expect(ActionText.owner(try #require(boosted.owner), name: { $0 == "web-app" ? "Web app" : $0 }) == "Web app let it go first: ci is red")

        let waiting = try row(4233)
        #expect(waiting.owner == "boosted by web-app: ci is red")
        #expect(waiting.moves.map(\.chip) == ["Moved up: set by web-app"])
        #expect(waiting.moves.map(\.sentence) == ["Moved ahead because web-app let it go first: ci is red."])

        let capped = try row(4234)
        #expect(capped.owner == "capped low by web-app")
        #expect(capped.moves.map(\.chip) == ["Moved back: capped by web-app"])
        #expect(capped.moves.map(\.sentence) == ["Moved back because web-app capped this agent at low priority."])
        #expect(ActionText.owner("capped low by web-app") == "web-app set it to let others go first")
    }

    @Test("the person's mark still reads as the owner's and says you")
    func personMark() throws {
        let running = try row(4223)
        #expect(running.owner == "boosted by owner")
        #expect(running.byAgent == nil)
        #expect(ActionText.owner(try #require(running.owner)) == "You let it go first")

        let waiting = try row(4235)
        #expect(waiting.owner == "boosted by owner")
        #expect(waiting.moves.map(\.chip) == ["Moved up: set by you"])
        #expect(waiting.moves.map(\.sentence) == ["Moved ahead because you let it go first."])
        #expect(Plain.ownerMove("capped idle by owner").short == "capped by you")
        #expect(ActionText.owner("capped idle by owner") == "You set it to run only when nothing else is waiting")
    }

    @Test("a pause by hand names whoever made it, the old agent: true shape too, and both can be resumed")
    func pauses() throws {
        let person = try row(4223)
        #expect(person.paused == "paused by owner")
        #expect(person.pausedText == "Paused by you")
        #expect(person.pausedByHand)
        #expect(person.pausedByAgent == nil)

        // The first pause by hand names it, as the CLI's pauseLabel does.
        let agent = try row(4224)
        #expect(agent.paused == "paused by web-app")
        #expect(agent.pausedText == "Paused by web-app")
        #expect(agent.pausedByHand)
        #expect(agent.pausedByAgent == "web-app")

        let old = try row(4222)
        #expect(old.paused == "paused by alex-b5")
        #expect(old.pausedByAgent == "alex-b5")
    }

    @Test("a by or reason of the wrong type is dropped and the board still decodes, as the person's")
    func junkBy() throws {
        let board = try fixture("board-override-by", as: Board.self)
        #expect(board.held.count == 5)
        #expect(board.waiting.count == 6)
        let junk = try row(4225)
        #expect(junk.owner == "lowered by owner")
        #expect(junk.paused == "paused by owner")
        #expect(junk.pausedByAgent == nil)
    }

    @Test("an older board's agentBoost still reads, and a junk one is dropped")
    func agentBoost() throws {
        let board = try fixture("board-override-by", as: Board.self)
        #expect(board.held[0].agentBoost?.by == "alex-b4")
        #expect(board.held[1].agentBoost == nil)
        #expect(board.waiting[2].agentBoost == nil)
        let rows = board.rows()
        #expect(rows.first { $0.leaseID == 4221 }?.byAgent == "boosted by the agent: person waiting on the fix")
        #expect(rows.first { $0.leaseID == 4230 }?.moves.map(\.chip) == ["Moved back: lowered by the agent"])
    }

    @Test("other machines' rows: an agent's owner label names it; an older byAgent label still reads")
    func peerRows() throws {
        let rows = try #require(try fixture("board-override-by", as: Board.self).peers(excluding: nil).first).rows()
        #expect(rows.map(\.byAgent) == ["boosted by the agent: ci is red", nil, nil, nil])
        #expect(rows[1].owner == "boosted by owner")
        #expect(rows[3].moves.map(\.chip) == ["Moved up: set by web-app"])
    }

    @Test("history: agents' changes name the agent, in the new shape and the 0.0.91 one; the person's don't show")
    func overrideEvents() throws {
        let json = #"""
        { "since": 0, "until": 1, "events": [
          { "at": 1, "kind": "override", "act": "boost", "id": 4221, "res": "xcode-build", "who": "alex-b4", "prio": "urgent",
            "from": "normal", "by": "agent", "agent": "alex-b4", "reason": "person waiting on the fix" },
          { "at": 2, "kind": "override", "act": "pause", "id": 12, "res": ["test"], "who": "alex-b4", "by": "agent", "agent": "alex-b4" },
          { "at": 3, "kind": "override", "act": "boost", "id": 13, "who": "alex-b4", "prio": "urgent", "from": "normal" },
          { "at": 4, "kind": "override", "act": "stop", "id": 14, "who": "alex-b4", "by": "agent", "agent": { "odd": true } },
          { "at": 5, "kind": "override", "act": "pause", "id": 15, "res": ["sim"], "who": "alex-b5", "by": "web-app", "byAgent": true },
          { "at": 6, "kind": "override", "act": "boost", "id": 16, "who": "web-app", "prio": "low", "from": "normal", "by": "web-app", "byAgent": true },
          { "at": 7, "kind": "override", "act": "pace", "pace": "quiet", "by": "web-app", "byAgent": true },
          { "at": 8, "kind": "override", "act": "cap", "who": "alex-b6", "prio": "idle", "by": "web-app", "byAgent": true },
          { "at": 9, "kind": "override", "act": "guard install", "by": "the person", "byAgent": false },
          { "at": 10, "kind": "override", "act": "kick", "machine": "studio", "by": 42, "byAgent": true }
        ] }
        """#
        let h = try JSONDecoder().decode(History.self, from: Data(json.utf8))
        #expect(h.events.count == 10)
        #expect(h.events[0].agentLine() == "alex-b4 boosted #4221 to urgent: person waiting on the fix")
        #expect(h.events[1].agentLine() == "alex-b4 paused #12")
        #expect(h.events[2].agentLine() == nil)
        // A junk agent name falls back to the job's own agent.
        #expect(h.events[3].agent == nil)
        #expect(h.events[3].agentLine() == "alex-b4 stopped #14")
        #expect(h.events[4].agentLine() == "web-app paused alex-b5's #15")
        #expect(h.events[4].agentLine(name: { $0.uppercased() }) == "WEB-APP paused ALEX-B5's #15")
        #expect(h.events[5].agentLine() == "web-app lowered #16 to low")
        #expect(h.events[6].agentLine() == "web-app ran dibs pace")
        #expect(h.events[7].agentLine() == "web-app capped alex-b6 at idle")
        #expect(h.events[8].agentLine() == nil)
        #expect(h.events[9].by == nil)
        #expect(h.events[9].agentLine() == "an agent ran dibs kick")
        #expect(h.agentChanges.map(\.at) == [10, 8, 7, 6, 5, 4, 2, 1])
    }
}
