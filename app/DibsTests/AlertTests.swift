import Foundation
import Testing

private final class Token {}

private func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = try #require(Bundle(for: Token.self).url(forResource: name, withExtension: "json"))
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}

@Suite("Needs you")
struct NeedsTests {
    // board-group's newest waiter joined the line at this time.
    let joined = Date(ms: 1_791_944_100_000)

    func needs(_ fixture: String = "board-group", questions: [Question] = [], at now: Date) throws -> [Need] {
        let lines = try load(fixture, as: Board.self).rows(now: now).counters(now: now)
        return Needs.items(counters: lines, questions: questions, now: now)
    }

    @Test("open questions come first, then a deploy held up past two minutes")
    func questionsAndShips() throws {
        let questions = try load("questions", as: QuestionList.self).open
        let now = joined.addingTimeInterval(3 * 60)
        let items = try needs(questions: questions, at: now)
        #expect(items.prefix(3).allSatisfy { $0.kind == .question })
        #expect(items.first?.title.hasSuffix(" is asking") == true)
        let ship = try #require(items.first { $0.kind == .ship })
        #expect(ship.title == "web-app can't ship yet")
        #expect(ship.detail.contains("Waiting for a turn on deploys."))
        #expect(ship.row?.leaseID != nil)
    }

    @Test("a deploy that just joined the line isn't the person's business yet")
    func shipTooSoon() throws {
        // web-app asked for deploys at this time.
        #expect(try needs(at: Date(ms: 1_791_943_500_000).addingTimeInterval(60)).isEmpty)
    }

    @Test("a normal job needs half an hour in line before it shows, and shows once though it's in two lines")
    func stuck() throws {
        #expect(try needs(at: joined.addingTimeInterval(20 * 60)).allSatisfy { $0.kind != .stuck })
        let stuck = try needs(at: joined.addingTimeInterval(31 * 60)).filter { $0.kind == .stuck }
        #expect(stuck.count == 1)
        #expect(stuck.first?.title == "ios-checkout has been waiting 31 min for its turn")
    }

    @Test("an agent stuck behind a file says which file, who has it and when, by the agents' titles")
    func fileWait() throws {
        let now = Date(ms: 1_791_946_000_000)
        let file = "files:/Users/x/atlas/format/SPEC.md"
        let holder = Row(id: "lease-1", leaseID: 1, res: [file], who: "alex-d3", label: "", purpose: "", cmd: "", prio: .normal, held: true,
                         isHold: true, paused: nil, since: now.addingTimeInterval(-600), endsAt: now.addingTimeInterval(18 * 60), startsAt: nil,
                         due: nil, blocked: nil, place: nil, rank: [], owner: nil)
        let waiter = Row(id: "wait-2", leaseID: 2, res: [file], who: "alex-b8", label: "", purpose: "Scripts: SPEC 4.17", cmd: "", prio: .normal,
                         held: false, isHold: false, paused: nil, since: now.addingTimeInterval(-39 * 60), endsAt: nil, startsAt: nil, due: nil,
                         blocked: nil, place: nil, rank: [], owner: nil)
        let titles = ["alex-d3": "Atlas build and deploy", "alex-b8": "Atlas scripts"]
        let items = Needs.items(counters: [holder, waiter].counters(now: now), questions: [], now: now, name: { titles[$0] ?? $0 })
        let need = try #require(items.first { $0.kind == .stuck })
        #expect(need.title == "Two agents need the same file")
        #expect(need.detail == "Atlas scripts wants to change SPEC.md, but Atlas build and deploy is changing it right now. "
            + "Atlas scripts waits so neither one overwrites the other's work. "
            + "It starts by itself in about 18 min, when the other one is done. You don't need to do anything.")
    }

    @Test("work blocked on a full disk is one need, whoever is waiting")
    func disk() throws {
        let now = Date(ms: 1_791_946_000_000)
        func row(_ id: Int, _ who: String) -> Row {
            Row(id: "wait-\(id)", leaseID: id, res: ["xcode-build"], who: who, label: "", purpose: "archive", cmd: "", prio: .normal, held: false,
                isHold: false, paused: nil, since: now.addingTimeInterval(-60), endsAt: nil, startsAt: nil, due: nil,
                blocked: "blocked by disk: 8.8G free, needs 20G", place: nil, rank: [], owner: nil)
        }
        let lines = [row(1, "release-train"), row(2, "web-app")].counters(now: now)
        let items = Needs.items(counters: lines, questions: [], now: now)
        #expect(items.count == 1)
        #expect(items[0].kind == .disk)
        #expect(items[0].title == "The disk is too full for release-train and web-app to start")
        #expect(items[0].detail == "8.8 GB is free, and starting needs 20 GB. Free up at least 12 GB and they start on their own.")
    }

    @Test("the status sentence: what needs the person, who's working, the longest line")
    func status() throws {
        let now = Date(ms: 1_791_946_000_000)
        let board = try load("board-080", as: Board.self)
        let lines = board.counters(rows: board.rows(now: now), now: now)
        let s = Status.of(counters: lines, needs: 0, now: now)
        #expect(s.headline == "Nothing needs you")
        #expect(s.detail == "2 agents working. 4 waiting, most for the simulator.")
        #expect(Status.of(counters: lines, needs: 3, now: now).headline == "3 things need you")
        #expect(Status.of(counters: [], needs: 1, now: now) == Status(headline: "1 thing needs you", detail: "Nobody's working right now."))
    }

    @Test("notifications are exactly the needs")
    func alerts() throws {
        let items = try needs(questions: try load("questions", as: QuestionList.self).open, at: joined.addingTimeInterval(3 * 60))
        #expect(Alerts.candidates(items).map(\.key) == items.map(\.id))
    }

    @Test("a release build is not a ship; a deploy or a TestFlight upload is")
    func ships() {
        func row(_ res: String, _ purpose: String, _ cmd: String = "") -> Row {
            Row(id: res, leaseID: 1, res: [res], who: "a", label: "", purpose: purpose, cmd: cmd, prio: .normal, held: false,
                isHold: false, paused: nil, since: .now, endsAt: nil, startsAt: nil, due: nil, blocked: nil, place: 1, rank: [], owner: nil)
        }
        #expect(!Needs.isShip(row("xcode-build", "release build")))
        #expect(!Needs.isShip(row("sim", "shipwright onboarding")))
        #expect(Needs.isShip(row("quota:asc", "", "./upload-to-testflight.sh")))
        #expect(Needs.isShip(row("quota:asc", "TestFlight 123")))
        #expect(Needs.isShip(row("deploy", "")))
    }
}

@Suite("AlertGate")
struct AlertGateTests {
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    func q(_ id: String) -> Alert { Alert(kind: .question, key: id, title: id, body: "") }

    @Test("one notification per kind per minute, and what waited goes out together")
    func rateLimit() {
        var gate = AlertGate()
        #expect(gate.pass([q("a")], now: t0)[.question]?.map(\.key) == ["a"])
        #expect(gate.pass([q("a"), q("b")], now: t0.addingTimeInterval(20)).isEmpty)
        #expect(gate.pass([q("a"), q("b"), q("c")], now: t0.addingTimeInterval(40)).isEmpty)
        #expect(gate.pass([q("a"), q("b"), q("c")], now: t0.addingTimeInterval(61))[.question]?.map(\.key) == ["b", "c"])
        #expect(gate.pass([q("a"), q("b"), q("c")], now: t0.addingTimeInterval(200)).isEmpty)
    }

    @Test("kinds are limited separately")
    func perKind() {
        var gate = AlertGate()
        _ = gate.pass([q("a")], now: t0)
        let ship = Alert(kind: .ship, key: "s", title: "", body: "")
        #expect(gate.pass([q("a"), ship], now: t0.addingTimeInterval(5))[.ship]?.count == 1)
    }

    @Test("something that goes away and comes back is new again")
    func returns() {
        var gate = AlertGate()
        _ = gate.pass([q("a")], now: t0)
        _ = gate.pass([], now: t0.addingTimeInterval(70))
        #expect(gate.pass([q("a")], now: t0.addingTimeInterval(140))[.question]?.count == 1)
    }

    @Test("a muted kind sends nothing, and unmuting doesn't replay what was skipped")
    func muted() {
        var gate = AlertGate()
        #expect(gate.pass([q("a")], now: t0, enabled: [.ship, .stuck]).isEmpty)
        #expect(gate.pass([q("a")], now: t0.addingTimeInterval(120)).isEmpty)
    }
}

@Suite("Agent tiles")
struct TileTests {
    @Test("sessions that share a prefix get their own initials from the short part at the end")
    func monograms() {
        #expect(Format.monogram("alex-75") == "75")
        #expect(Format.monogram("alex-b8") == "B8")
        #expect(Format.monogram("web-app") == "WA")
        #expect(Format.monogram("api-refactor / tests") == "AR")
        #expect(Format.monogram("onboarding") == "ON")
    }
}
