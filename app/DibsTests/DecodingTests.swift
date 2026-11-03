import Foundation
import Testing

private final class Token {}

private func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = try #require(Bundle(for: Token.self).url(forResource: name, withExtension: "json"))
    return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
}

@Suite("Board")
struct BoardTests {
    @Test("a 0.0.63 board decodes, and a waiter borrows its reason from the coordinator's copy")
    func board063() throws {
        let board = try fixture("board-063", as: Board.self)
        #expect(board.machine.pace == "normal")
        #expect(board.subagents?.slots == 8)

        let rows = board.rows(peerName: "Alexs-Mac-mini")
        let hold = try #require(rows.first { $0.held })
        #expect(hold.isHold)
        #expect(hold.leaseID == 637)
        #expect(hold.purpose == "perf: instruments #21")

        let waiter = try #require(rows.first { !$0.held })
        #expect(waiter.place == 1)
        #expect(waiter.blocked == "blocked by disk: 5.2G free, needs 6.0G")
        #expect(waiter.rank.map(Format.rank) == ["short job: up 4m56s", "recent use: back 9m05s"])

        #expect(board.rows(peerName: nil).first { !$0.held }?.blocked == nil)
        #expect(board.peers(excluding: "Alexs-Mac-mini").isEmpty)
    }

    @Test("paused leases read the way the CLI prints them")
    func pauses() throws {
        let rows = try fixture("board-group", as: Board.self).rows()
        #expect(rows.first { $0.leaseID == 802 }?.paused == "paused for ios-checkout")
        #expect(rows.first { $0.leaseID == 803 }?.paused == "paused: memory pressure")
        #expect(rows.first { $0.leaseID == 801 }?.paused == nil)
        #expect(rows.first { $0.leaseID == 801 }?.prio == .high)
    }

    @Test("quotas with a config error and a missing subagent limit still decode")
    func optionalSections() throws {
        let board = try fixture("board-group", as: Board.self)
        #expect(board.quotas.count == 2)
        #expect(board.quotas[1].error == "per must be a duration")
        #expect(board.subagents == nil)
    }

    @Test("resources with a line come first, longest first, then by name")
    func grouping() throws {
        let groups = try fixture("board-group", as: Board.self).rows().groupedByResource()
        #expect(groups.map(\.resource) == ["deploy", "sim,xcode-build", "heavy", "test", "xcode-build"])
        #expect(groups[0].waiting.first?.prio == .urgent)
    }

    @Test("other machines: this one left out, lost and silent ones kept, times shifted by the board's age")
    func peers() throws {
        let board = try fixture("board-group", as: Board.self)
        let peers = board.peers(excluding: "this-mac")
        #expect(peers.map(\.name) == ["laptop", "old-mini", "studio"])
        #expect(peers[0].lost == true)
        #expect(peers[1].board == nil)

        let now = Date(timeIntervalSince1970: 1_000_000)
        let rows = peers[2].rows(now: now)
        let held = try #require(rows.first { $0.held })
        #expect(held.isHold)
        #expect(held.leaseID == nil)
        // 120s held as of 25s ago: it started 145s before now.
        #expect(now.timeIntervalSince(held.since) == 145)
        let waiting = try #require(rows.first { !$0.held })
        #expect(waiting.blocked == "behind studio-agent")
        #expect(waiting.startsAt.map { $0.timeIntervalSince(now) } == 65)
    }

    @Test("a coordinator that can't be reached is an error, not missing machines")
    func unreachable() throws {
        let board = try fixture("board-unreachable", as: Board.self)
        #expect(board.elsewhere?.error == "no answer in 1.5s")
        #expect(board.peers(excluding: nil).isEmpty)
        #expect(board.rows().isEmpty)
    }
}

@Suite("dibs 0.0.70")
struct Contract070Tests {
    @Test("owner marks, caps and wait reasons from the override branch's board")
    func board() throws {
        let board = try fixture("board-070", as: Board.self)
        #expect(board.caps["web-app"]?.prio == "low")
        let rows = board.rows()
        let boosted = try #require(rows.first { $0.leaseID == 3 })
        #expect(boosted.owner == "boosted by owner")
        #expect(boosted.prio == .urgent)
        #expect(boosted.blocked == "blocked by slot: deploy")
        #expect(rows.first { $0.leaseID == 2 }?.paused == "paused by owner")
        #expect(rows.first { $0.leaseID == 1 }?.owner == nil)
    }

    @Test("the board names this machine, and an older one that doesn't still decodes")
    func me() throws {
        #expect(try fixture("board-070", as: Board.self).me?.name == "mini")
        #expect(try fixture("board-063", as: Board.self).me == nil)
    }

    @Test("dibs pace --json: the pace in force and one line per pace, in the CLI's order")
    func pace() throws {
        let info = try fixture("pace-070", as: PaceInfo.self)
        #expect(info.pace == "quiet")
        #expect(info.knobs.maxLoad == 5)
        #expect(info.pinned.isEmpty)
        #expect(info.lines.map(\.name) == ["quiet", "normal", "max"])
        #expect(info.lines[0].line == "Jobs keep up to 4 cores busy and use up to 6.5 GB of memory at once, and new work waits once the load passes 5. The limits always apply.")
        #expect(info.lines[1].line == "Jobs keep up to 6 cores busy and use up to 8 GB of memory at once, and new work waits once the load passes 10. The limits lift while the Mac is mostly idle.")
        #expect(Speed.all.map(\.title) == ["Calm", "Normal", "Fast"])
    }

    @Test("dibs guard status --json: installed with its tools, or not installed with no subagent limit")
    func guardStatus() throws {
        let on = try fixture("guard-070", as: GuardStatus.self)
        #expect(on.installed && on.complete)
        #expect(on.tools == ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"])
        #expect(on.subagents?.slots == 8)
        #expect(on.rewriteLine.hasPrefix("Rewrites commands in bypassPermissions sessions"))
        let off = try fixture("guard-none-070", as: GuardStatus.self)
        #expect(!off.installed)
        #expect(off.tools.isEmpty)
        #expect(off.subagents == nil)
    }

    @Test("a waiter whose process is gone keeps its place, and says so")
    func keptPlace() {
        #expect(Board.reason(nil, kept: true) == Row.keptPlace)
        #expect(Board.reason(nil, kept: false) == nil)
        #expect(Board.reason("behind web-app", kept: false) == "behind web-app")
        #expect(Board.reason("disk: 8.8G free, needs 10G", kept: false) == "blocked by disk: 8.8G free, needs 10G")
    }

    @Test("questions carry purpose, waiting and held")
    func questions() throws {
        let list = try fixture("questions-070", as: QuestionList.self)
        #expect(list.open.map(\.id) == ["1"])
        #expect(list.open[0].waiting == false)
        #expect(list.open[0].held == false)
        #expect(list.closed.first?.answer == "not yet")
    }

    @Test("history with null load, array res and the event fields the branch writes")
    func history() throws {
        let h = try fixture("history-070", as: History.self)
        #expect(h.bottleneck?.name == "sim")
        #expect(h.hourly.allSatisfy { $0.load == nil })
        #expect(h.events.map(\.kind) == ["start", "wait", "end", "start", "end"])
        #expect(h.worstHour(for: "sim") != nil)
    }

    @Test("an agent blocked on its question goes first; one held for tomorrow goes last")
    func questionOrder() throws {
        let json = #"""
        {"questions": [
          {"id": 1, "who": "a", "text": "x", "prio": "high", "asked": 1, "state": "open", "held": true},
          {"id": 2, "who": "b", "text": "y", "prio": "normal", "asked": 2, "state": "open", "waiting": true},
          {"id": 3, "who": "c", "text": "z", "prio": "high", "asked": 3, "state": "open"}
        ], "hours": null}
        """#
        let list = try JSONDecoder().decode(QuestionList.self, from: Data(json.utf8))
        #expect(list.open.map(\.id) == ["2", "3", "1"])
        #expect(list.hours == nil)
    }
}

@Suite("dibs 0.0.80: the lines in plain words")
struct Contract080Tests {
    // The clock board-080.json was written at.
    let now = Date(ms: 1_791_946_000_000)

    func counters(_ name: String) throws -> [Counter] {
        let board = try fixture(name, as: Board.self)
        return board.counters(rows: board.rows(now: now), now: now)
    }

    @Test("the lines come in dibs's order, with its names and summaries, and free ones last")
    func order() throws {
        let lines = try counters("board-080")
        #expect(lines.map(\.name) == ["Simulator", "Xcode builds", "Deploys", "Heavy jobs", "Test runs", "Browser tests", "Private simulators"])
        #expect(lines[0].summary == "1 in use, 2 waiting, clear in about 31 min")
        #expect(lines.filter(\.isFree).map(\.res) == ["playwright", "sim-own"])
    }

    @Test("who's using a line is the lease itself, so the person can pause or stop it")
    func serving() throws {
        let sim = try #require(try counters("board-080").first)
        let now = try #require(sim.serving.first)
        #expect(now.leaseID == 901)
        #expect(now.endsText == "up to 14 min left")
        let tests = try #require(try counters("board-080").first { $0.res == "test" })
        #expect(tests.serving.first?.pausedText == "Paused by you")
    }

    @Test("the line in order, each with dibs's own sentences")
    func waiting() throws {
        let sim = try #require(try counters("board-080").first)
        #expect(sim.waiting.map(\.who) == ["onboarding", "ios-checkout"])
        #expect(sim.waiting.map(\.place) == [1, 2])
        let next = sim.waiting[0]
        #expect(next.startsText == "about 14 min")
        #expect(next.waitingFor == "ios-checkout to give the simulator back (up to 14 min left)")
        #expect(next.moves.map(\.up) == [true, false])
        #expect(next.moves.map(\.chip) == ["Moved up: short job", "Moved back: taking turns"])
        #expect(next.moves[0].sentence == "Moved ahead because it's a short job (about 2 min).")
        #expect(sim.waiting[1].startsText == "as soon as onboarding finishes")
        #expect(Plain.startsPhrase(sim.waiting[1].startsText!) == "Starts as soon as onboarding finishes")
    }

    @Test("a job that needs two resources stands in both lines, first in the shorter one")
    func twoLines() throws {
        let lines = try counters("board-080")
        let builds = try #require(lines.first { $0.res == "xcode-build" })
        #expect(builds.waiting.map(\.leaseID) == [911])
        #expect(builds.waiting.first?.place == 1)
        #expect(lines[0].waiting.last?.place == 2)
    }

    @Test("an owner's change shows once, as the owner's, never twice")
    func ownerMoves() throws {
        let deploy = try #require(try counters("board-080").first { $0.res == "deploy" }?.waiting.first)
        #expect(deploy.moves.map(\.sentence) == ["Moved ahead because you set it to urgent."])
        #expect(deploy.moves.map(\.chip) == ["Moved up: set by you"])
        let fallback = try #require(try counters("board-080-fallback").first { $0.res == "deploy" }?.waiting.first)
        #expect(fallback.moves.map(\.chip) == ["Moved up: set by you"])
    }

    @Test("from a 0.0.70 board: the same lines, busiest first, with sentences worked out in the app")
    func fallback() throws {
        let lines = try counters("board-080-fallback")
        #expect(lines.map(\.name) == ["Simulator", "Xcode builds", "Deploys", "Heavy jobs", "Test runs"])
        #expect(lines[0].summary == "1 in use, 2 waiting")
        #expect(lines.first { $0.res == "test" }?.summary == "1 in use")
        let next = lines[0].waiting[0]
        #expect(next.waitingFor == "ios-checkout's checkout flow screenshots to finish, about 14 min left")
        #expect(next.startsText == "about 14 min")
        #expect(next.moves.map(\.chip) == ["Moved up: short job", "Moved back: taking turns"])
        #expect(lines[0].waiting[1].waitingFor == "onboarding to go first. They're ahead in the queue.")
        #expect(lines[0].serving.first?.endsText == "about 14 min left")
        #expect(lines.first { $0.res == "test" }?.serving.first?.pausedText == "Paused by you")
        #expect(lines.first { $0.res == "deploy" }?.waiting.first?.waitingFor == "the Mac to cool down")
        #expect(lines.first { $0.res == "heavy" }?.waiting.first?.startsText == "unknown")
    }

    @Test("every 0.0.70 wait reason reads as a sentence")
    func reasons() {
        func why(_ b: String?, kept: Bool = false) -> String { Plain.waitingFor(b, kept: kept, ahead: nil, now: now) }
        #expect(why("slot: xcode-build") == "a turn on Xcode builds")
        #expect(why("blocked by disk: 8.8G free, needs 10G") == "more free disk space (8.8 GB free, needs 10 GB)")
        #expect(why("blocked by budget: 4G of 8G left").hasPrefix("room on the Mac"))
        #expect(why("reset: sim") == "the simulator to finish resetting after the last job")
        #expect(why("files: src/auth") == "another agent to finish with src/auth")
        #expect(why("quota: asc") == "the asc limit to reset")
        #expect(why("idle") == "everyone else to finish. Background work goes last.")
        #expect(why(nil, kept: true).hasPrefix("its agent to come back"))
        #expect(why(Row.keptPlace, kept: true).hasPrefix("its agent to come back"))
    }

    @Test("places and times in words")
    func words() {
        #expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(Plain.ordinal) == ["Next", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st"])
        #expect(Plain.about(20) == "under a minute")
        #expect(Plain.about(4 * 60 + 10) == "about 4 min")
        #expect(Plain.about(80 * 60) == "about 1 hr 20 min")
        #expect(Plain.about(120 * 60) == "about 2 hr")
        #expect(Plain.startsPhrase("about 4 min") == "Starts in about 4 min")
        #expect(Plain.startsPhrase("unknown") == "Start time not known yet")
        #expect(Plain.name("files:src/auth") == "Files: src/auth")
    }

    @Test("a move dibs sends without a chip word gets one from its reason, if the reason starts short")
    func chips() throws {
        let json = #"[{"dir": "up", "amount": "3 min", "reason": "Quick job. It usually takes 2 minutes."}, {"dir": "down", "reason": "Its agent has used the simulator a great deal lately."}, {"reason": 4}]"#
        let moves = try JSONDecoder().decode([Lenient<Move>].self, from: Data(json.utf8)).compactMap(\.value)
        #expect(moves.map(\.chip) == ["Moved up: quick job", "Moved back"])
        #expect(Move(dir: "down", amount: "5 min", reason: "Its agent used the simulator for 28 minutes in the last hour.").chip == "Moved back 5 min")
        #expect(Move(dir: "up", amount: "3 min", reason: "A quick job. It usually takes 2 minutes.").chip == "Moved up: quick job")
    }
}

@Suite("dibs 0.0.80: JSON captured from the merged CLI")
struct Merged080Tests {
    // The clock board-080-cli.json was captured at (machine.at).
    let now = Date(ms: 1_791_961_165_532)

    func counters() throws -> [Counter] {
        let board = try fixture("board-080-cli", as: Board.self)
        return board.counters(rows: board.rows(now: now), now: now)
    }

    @Test("the board: every queue in dibs's order, a job running alongside a full queue, a build planned at all the memory")
    func board() throws {
        let lines = try counters()
        #expect(lines.map(\.name) == ["Simulator", "Test runs", "Xcode builds", "Deploys", "Private simulators", "Browser tests", "Heavy jobs"])
        #expect(lines.first { $0.res == "test" }?.serving.map(\.who) == ["api-refactor", "api"])
        let sim = try #require(lines.first)
        #expect(sim.waiting.map(\.who) == ["onboarding"])
        #expect(sim.waiting.first?.waitingFor == "ios-checkout's checkout flow screenshots to finish (about 13 min left)")
        let build = try #require(lines.first { $0.res == "xcode-build" }?.waiting.first)
        #expect(build.waitingFor?.hasPrefix("all the memory dibs shares out to be free (it usually uses 14 GB") == true)
        #expect(build.startsText == "unknown")
        #expect(try fixture("board-080-cli", as: Board.self).me?.name == "mini")
    }

    @Test("threads: a note, a queued message, an answered question and an open one, each agent doing something")
    func threads() throws {
        let list = try fixture("threads-080-cli", as: ThreadList.self)
        #expect(list.threads.map(\.to).sorted() == ["api", "onboarding", "web-app"])
        let web = try #require(list.threads.first { $0.to == "web-app" })
        #expect(web.activity == "Deploying")
        #expect(web.messages.map(\.kind) == ["note", "message"])
        #expect(web.messages.last?.state == "queued")
        #expect(list.threads.first { $0.to == "api" }?.activity == "Running tests")
        #expect(list.threads.first { $0.to == "onboarding" }?.activity == "Waiting for the simulator")
        let questions = try fixture("questions-080", as: QuestionList.self)
        let needs = Needs.items(counters: try counters(), questions: questions.questions, threads: list.threads, now: now)
        #expect(needs.filter { $0.kind == .question }.map(\.detail) == ["Ship 1.4 to TestFlight?"])
        #expect(needs.filter { $0.kind == .note }.map(\.title) == ["web-app says"])
    }

    @Test("questions, history, pace and guard status as the merged CLI writes them")
    func rest() throws {
        let q = try fixture("questions-080", as: QuestionList.self)
        #expect(q.open.map(\.id) == ["1"])
        #expect(q.open.first?.options == ["yes", "no"])
        #expect(q.closed.first?.answer == "no")
        let h = try fixture("history-080", as: History.self)
        #expect(Set(h.events.map(\.kind)).isSuperset(of: ["start", "end", "wait"]))
        #expect(h.resources["test"] != nil)
        let pace = try fixture("pace-080", as: PaceInfo.self)
        #expect(pace.pace == "normal")
        #expect(pace.lines.map(\.name) == ["quiet", "normal", "max"])
        #expect(pace.lines[2].line.hasPrefix("Jobs keep up to 15 cores busy and use up to 12 GB of memory at once"))
        #expect(pace.lines[2].line.hasSuffix("The limits always apply."))
        let g = try fixture("guard-080", as: GuardStatus.self)
        #expect(g.installed && g.complete)
        #expect(g.tools == ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"])
        #expect(g.matchers.map(\.event).contains("Stop"))
        #expect(g.subagents == nil)
    }
}

@Suite("Questions")
struct QuestionTests {
    @Test("open questions: most urgent first, then due soonest, then asked earliest")
    func order() throws {
        let list = try fixture("questions", as: QuestionList.self)
        #expect(list.open.map(\.id) == ["5", "6", "4"])
        #expect(list.open.last?.options == ["yes", "no"])
        #expect(list.hours == QuestionList.Hours(start: "09:00", end: "23:00"))
    }

    @Test("string ids and states this app doesn't know are kept, and never shown as open")
    func lenient() throws {
        let list = try fixture("questions", as: QuestionList.self)
        let legacy = try #require(list.questions.first { $0.id == "q-legacy" })
        #expect(legacy.state == .expired)
        #expect(legacy.prio == .low)
        #expect(list.closed.map(\.id) == ["2", "q-legacy"])
        #expect(list.closed.first?.answer == "not yet")
    }
}

@Suite("History")
struct HistoryTests {
    @Test("the bottleneck is the resource with the most time spent in line")
    func bottleneck() throws {
        let h = try fixture("history", as: History.self)
        #expect(h.bottleneck?.name == "sim")
        #expect(h.busiestHour?.waiting == 5)
        #expect(h.resources["deploy"]?.p90WaitMs == nil)
    }

    @Test("a resource's line forms most in the hour with the most waits, whether res is one name or a list")
    func worstHour() throws {
        let h = try fixture("history", as: History.self)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let worst = try #require(h.worstHour(for: "sim", calendar: utc))
        #expect(worst == utc.dateInterval(of: .hour, for: Date(ms: 1_791_936_100_000))?.start)
        #expect(h.events.filter { $0.res == ["sim"] }.count == 4)
        #expect(h.worstHour(for: "deploy") == nil)
    }

    @Test("a wait picked up again after a timeout counts once")
    func rewait() throws {
        let hour = 1_791_936_000_000.0
        let json = """
        { "since": 0, "until": 1, "events": [
          { "at": \(hour + 60_000), "kind": "wait", "id": 7, "res": ["sim"] },
          { "at": \(hour + 120_000), "kind": "wait", "id": 8, "res": ["sim"] },
          { "at": \(hour + 3_700_000), "kind": "wait", "id": 9, "res": ["sim"] },
          { "at": \(hour + 3_800_000), "kind": "wait", "id": 9, "res": ["sim"] },
          { "at": \(hour + 3_900_000), "kind": "wait", "id": 9, "res": ["sim"] } ] }
        """
        let h = try JSONDecoder().decode(History.self, from: Data(json.utf8))
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        #expect(h.worstHour(for: "sim", calendar: utc) == utc.dateInterval(of: .hour, for: Date(ms: hour + 60_000))?.start)
    }
}

@Suite("Talking with agents")
struct ThreadTests {
    let now = Date(ms: 1_791_946_000_000)

    @Test("dibs threads --json: string ids, questions with their numbers, receipts, a subagent's thread")
    func decode() throws {
        let list = try fixture("threads-080", as: ThreadList.self)
        #expect(list.threads.map(\.to) == ["web-app", "ios-checkout", "onboarding", "api-refactor/tests"])
        let web = list.threads[0]
        #expect(web.unread == 2)
        #expect(web.openQuestions.first?.questionId == "14")
        #expect(web.messages.first { $0.kind == "delivered" }?.about == "m2")
        #expect(list.threads[3].name == "api-refactor / tests")
        #expect(!list.threads[3].alive)
        #expect(list.threads[2].messages.last?.state == "queued")
    }

    @Test("JSON from the talk branch: a main agent's label is its own name, ids are strings, a person's message is queued")
    func realTalk() throws {
        let t = try #require(try fixture("threads-talk", as: ThreadList.self).threads.first)
        #expect(t.name == "web-app")
        #expect(t.isMain)
        #expect(t.activity == "Idle")
        #expect(t.messages.map(\.id) == ["q1", "m1", "m2"])
        #expect(t.openQuestions.first?.questionId == "1")
        #expect(t.messages.last?.state == "queued")
        let needs = Needs.items(counters: [], questions: [], threads: [t], now: now)
        #expect(needs.map(\.title) == ["web-app says"])
    }

    @Test("what an agent is doing, in plain words")
    func activity() {
        func t(_ working: String?, alive: Bool = true) -> String {
            AgentThread(agent: "a", to: "a", alive: alive, working: working, unread: 0, last: 0, messages: []).activity
        }
        #expect(t(#"waiting for deploy for "ship 1.4""#) == "Waiting to deploy")
        #expect(t(#"using test for "full suite""#) == "Running tests")
        #expect(t(#"using sim for "screenshots""#) == "Using the simulator")
        #expect(t("idle") == "Idle")
        #expect(t("idle", alive: false) == "Not running")
    }

    @Test("an unread note needs the person and links to its thread; a read one doesn't")
    func notes() throws {
        let threads = try fixture("threads-080", as: ThreadList.self).threads
        let items = Needs.items(counters: [], questions: [], threads: threads, now: now)
        #expect(items.map(\.kind) == [.note])
        #expect(items[0].title == "web-app says")
        #expect(items[0].detail.hasPrefix("Dry run passed"))
        #expect(items[0].thread == "web-app")
    }

    @Test("without dibs threads, each agent's questions and answers make its thread")
    func fromQuestions() throws {
        let questions = try fixture("questions-070", as: QuestionList.self).questions
        let threads = ThreadList(questions: questions).threads
        #expect(!threads.isEmpty)
        #expect(threads.allSatisfy { t in t.messages.allSatisfy { $0.kind == "question" || $0.kind == "answer" } })
        #expect(threads.map(\.unread).reduce(0, +) == questions.filter { $0.state == .open }.count)
    }
}

@Suite("The week in words")
struct WeekNoteTests {
    @Test("where the waiting was, when, how long, who gave up, and what came second")
    func note() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let h = try fixture("history", as: History.self)
        let note = h.note(days: 7, calendar: utc)
        #expect(note.headline == "Most of the waiting this week was for the simulator.")
        #expect(note.body.hasPrefix("Agents waited "))
        #expect(!note.body.contains("about about"))
    }

    @Test("a week nobody waited says so")
    func quiet() throws {
        let h = try JSONDecoder().decode(History.self, from: Data(#"{ "since": 0, "until": 1 }"#.utf8))
        #expect(h.note(days: 7) == ("Nobody waited this week.", "Every turn started as soon as an agent asked for it."))
    }

    @Test("lines formed in the hours with at least half the busiest hour's waiting")
    func peak() throws {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let day = 1_791_936_000_000.0 - 1_791_936_000_000.0.truncatingRemainder(dividingBy: 86_400_000)
        let hourly = [(14, 2.0), (15, 6.0), (16, 1.0), (18, 4.0), (9, 1.0)].map { #"{ "hour": \#(day + Double($0.0) * 3_600_000), "waiting": \#($0.1) }"# }
        let h = try JSONDecoder().decode(History.self, from: Data(#"{ "since": 0, "until": 1, "hourly": [\#(hourly.joined(separator: ","))] }"#.utf8))
        #expect(h.peakHours(calendar: utc).map { [$0.start, $0.hours] } == [15, 4])
        #expect(Format.hourName(0) == "midnight")
        #expect(Format.hourName(12) == "noon")
        #expect(Format.hourName(19) == "7 PM")
    }
}

@Suite("Format")
struct FormatTests {
    @Test("durations match the CLI's")
    func durations() {
        #expect(Format.dur(42) == "42s")
        #expect(Format.dur(342) == "5m42s")
        #expect(Format.dur(4020) == "1h07m")
        #expect(Format.dur(-5) == "0s")
    }
}

@Suite("version numbers")
struct VersionTests {
    @Test("old-style dibs versions read the new way, so only real 0.0.70+ gets owner actions")
    func normalizes() {
        #expect(DibsVersion.normalized("0.6.3") == "0.0.63")
        #expect(DibsVersion.normalized("0.7.0") == "0.0.70")
        #expect(DibsVersion.normalized("0.0.71") == "0.0.71")
        #expect(DibsVersion.atLeast("0.0.71", "0.0.70"))
        #expect(DibsVersion.atLeast("0.7.1", "0.0.70"))
        #expect(!DibsVersion.atLeast("0.6.3", "0.0.70"))
        #expect(!DibsVersion.atLeast("0.0.63", "0.0.70"))
    }
}
