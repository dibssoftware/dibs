import Foundation
import Testing

// The app review's findings (against dibs 0.0.85), each with the case that
// showed it, and the 0.0.86 fields the app reads.

private func row(_ id: Int, res: String = "test", who: String, held: Bool = false, prio: Prio = .normal, since: Date,
                 endsAt: Date? = nil, blocked: String? = nil, waitingFor: String? = nil, purpose: String = "") -> Row {
    var r = Row(id: held ? "lease-\(id)" : "wait-\(id)", leaseID: id, res: [res], who: who, label: "", purpose: purpose, cmd: "", prio: prio,
                held: held, isHold: false, paused: nil, since: since, endsAt: endsAt, startsAt: nil, due: nil, blocked: blocked,
                place: held ? nil : 1, rank: [], owner: nil)
    r.waitingFor = waitingFor
    r.family = Plain.family(Plain.rule(blocked))
    return r
}

private func counter(_ res: String = "test", serving: [Row] = [], waiting: [Row]) -> Counter {
    Counter(res: res, name: Plain.name(res), serving: serving, waiting: waiting, clearsAt: nil, summary: "")
}

private func board(_ json: String) throws -> Board {
    try JSONDecoder().decode(Board.self, from: Data(json.utf8))
}

private let machine = #""machine": {"memFree": 60, "diskFree": 9e9, "load": 3, "cores": 10}"#

@Suite("Review fixes")
struct ReviewFixTests {
    @Test("a wait dibs can't forecast reads as not known yet, not as any moment from the raw guess")
    func unknownStart() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let ms = now.timeIntervalSince1970 * 1000
        let b = try board("""
        {\(machine), "held": [], "waiting": [
          {"id": 1, "res": ["test"], "who": "a", "enq": \(ms - 840_000), "expectStart": \(ms), "pid": 1, "blocked": "memory",
           "plain": {"startsIn": null, "startsText": "unknown", "waitingFor": "room in memory"}},
          {"id": 2, "res": ["files:src/x.ts"], "who": "b", "enq": \(ms - 60_000), "expectStart": \(ms + 2_040_000), "pid": 2,
           "blocked": "files: src/x.ts", "plain": {"startsIn": null, "startsText": "as soon as alex-d3 finishes"}},
          {"id": 3, "res": ["sim"], "who": "c", "enq": \(ms - 60_000), "expectStart": \(ms + 60_000), "pid": 3, "blocked": "slot: sim",
           "plain": {"startsIn": 240000, "startsText": "about 4 min"}}
        ]}
        """)
        let rows = b.rows(now: now)
        #expect(rows[0].startsAt == nil)
        #expect(rows[0].starts(at: now) == "Not known yet")
        #expect(rows[1].starts(at: now) == "After alex-d3")
        #expect(rows[2].starts(at: now) == "In 4 min")
        #expect(rows[0].startsPhrase(at: now) == "start time not known yet")
    }

    @Test("waits for swap room and a draining disk are disk needs, with how much to free")
    func diskNeeds() {
        let now = Date.now
        let swap = row(2, res: "playwright", who: "ios", prio: .high, since: now.addingTimeInterval(-700), blocked: "blocked by swaproom",
                       waitingFor: "more free disk for swap to grow into (3.1 GB free; while this machine swaps, new work below urgent waits until 8 GB is free or nothing else is running)")
        let needs = Needs.items(counters: [counter("playwright", waiting: [swap])], questions: [], now: now)
        #expect(needs.map(\.kind) == [.disk])
        #expect(needs[0].detail.contains("Free up at least 5 GB"))

        let drain = row(3, who: "api", since: now.addingTimeInterval(-2000), blocked: "blocked by drain",
                        waitingFor: "free disk to stop falling (it fell 6 GB in 5 min to 9 GB; new work below urgent waits while it falls and anything else is running)")
        let d = Needs.items(counters: [counter(waiting: [drain])], questions: [], now: now)
        #expect(d.map(\.kind) == [.disk])
        #expect(d[0].title == "The disk is filling up fast")

        let disk = row(4, who: "web", since: now, blocked: "blocked by disk: 8.7G free, needs 10G",
                       waitingFor: "more free disk (8.7 GB free, it needs 10 GB)")
        #expect(Needs.items(counters: [counter(waiting: [disk])], questions: [], now: now)[0].detail
                == "8.7 GB is free, and starting needs 10 GB. Free up at least 2 GB and it starts on its own.")
    }

    @Test("a long wait on a budget or the Mac says what it waits for, not that the Mac is busy")
    func machineWaitSaysWhy() {
        let now = Date.now
        let quota = row(4, res: "quota:asc", who: "ship", prio: .high, since: now.addingTimeInterval(-700), blocked: "blocked by quota: asc",
                        waitingFor: "the App Store Connect budget to refill (0 of 50 left, enough in about 20 min)")
        let n = Needs.items(counters: [counter("quota:asc", waiting: [quota])], questions: [], now: now)
        #expect(n.count == 1)
        #expect(n[0].detail.hasPrefix("It's waiting for the App Store Connect budget to refill"))
        #expect(!n[0].detail.contains("too busy"))
        #expect(Needs.waitsOnMac(quota))
        let turn = row(5, who: "a", since: now, blocked: "slot: test")
        #expect(!Needs.waitsOnMac(turn))
    }

    @Test("only a turn on deploy is shipping, not a test run whose purpose mentions one")
    func shipIsDeploy() {
        let now = Date.now
        let test = row(1, who: "d3", prio: .high, since: now.addingTimeInterval(-200), blocked: "slot: test",
                       purpose: "format vitest after merging main into #407 (deploy blocker)")
        #expect(!Needs.isShip(test))
        #expect(Needs.items(counters: [counter(waiting: [test])], questions: [], now: now).isEmpty)
        #expect(Needs.isShip(row(2, res: "deploy", who: "w", since: now)))
    }

    @Test("a pause for low disk reads as one, and only the person's own pause is theirs to resume")
    func pauses() throws {
        let b = try board("""
        {\(machine), "held": [
          {"id": 1, "res": ["test"], "who": "a", "start": 0, "pausedAt": 1, "pauses": [{"disk": true, "watcher": 9}]},
          {"id": 2, "res": ["test"], "who": "b", "start": 0, "pausedAt": 1, "pauses": [{"owner": true}]}
        ], "waiting": []}
        """)
        let rows = b.rows()
        #expect(rows[0].paused == "paused: disk low")
        #expect(rows[0].pausedText == "Paused while free disk space is low")
        #expect(rows[0].paused != Row.pausedByOwner)
        #expect(rows[1].paused == Row.pausedByOwner)
    }

    @Test("another machine's waits on the whole Mac read as sentences, not as a turn on a queue")
    func peerWords() {
        for b in ["blocked by swaproom", "blocked by drain", "blocked by pressure", "blocked by swap"] {
            let w = Plain.waitingFor(b, kept: false, ahead: nil, now: .now)
            #expect(!w.hasPrefix("a turn on"), "\(b): \(w)")
        }
        #expect(Plain.paused("paused: disk low") == "Paused while free disk space is low")
    }

    @Test("a line's long wait keeps one id as the line grows and shrinks")
    func lineNeedID() {
        let now = Date.now
        let a = row(5, who: "a", since: now.addingTimeInterval(-2000), blocked: "slot: test")
        let b = row(6, who: "b", since: now.addingTimeInterval(-1900), blocked: "slot: test")
        let one = Needs.items(counters: [counter(waiting: [a])], questions: [], now: now)
        let two = Needs.items(counters: [counter(waiting: [a, b])], questions: [], now: now)
        #expect(one.map(\.id) == ["long-test"])
        #expect(two.map(\.id) == ["long-test"])
    }

    @Test("busiest hours on both sides of midnight are those hours, not the whole day")
    func peakAcrossMidnight() throws {
        let cal = Calendar.current
        let day = cal.startOfDay(for: .now)
        // By the clock, not by adding hours: a day the clocks change is 23 or 25 hours long.
        let at = { (h: Int) in cal.date(bySettingHour: h, minute: 0, second: 0, of: day)!.timeIntervalSince1970 * 1000 }
        let hour = { (h: Int, w: Int) in #"{"hour": \#(at(h)), "waiting": \#(w)}"# }
        let json = #"{"since": 0, "until": 0, "hourly": [\#([hour(23, 5), hour(0, 4), hour(12, 1)].joined(separator: ","))]}"#
        let h = try JSONDecoder().decode(History.self, from: Data(json.utf8))
        let p = try #require(h.peakHours(calendar: cal))
        #expect(p.start == 23)
        #expect(p.hours == 2)
        let apart = #"{"since": 0, "until": 0, "hourly": [\#([hour(1, 5), hour(23, 5)].joined(separator: ","))]}"#
        let q = try #require(try JSONDecoder().decode(History.self, from: Data(apart.utf8)).peakHours(calendar: cal))
        #expect(q.start == 23)
        #expect(q.hours == 3)
    }

    @Test("the busiest hours per queue come from dibs, or from events only when they reach back over the range")
    func busiestHours() throws {
        let withMostly = #"{"since": 0, "until": 604800000, "resources": {"test": {"busyMs": 1, "waits": 3, "waitMs": 9, "mostly": [14, 3]}}, "events": []}"#
        #expect(try JSONDecoder().decode(History.self, from: Data(withMostly.utf8)).busiest(for: "test") == "2 PM to 5 PM")

        // 2000 events (the CLI's cap), all in the last ten hours of a week.
        let until = 604_800_000.0
        let events = (0..<History.eventCap).map { i in #"{"at": \#(until - Double(i) * 18_000), "kind": "wait", "id": \#(i), "res": "test"}"# }
        let capped = #"{"since": 0, "until": \#(until), "resources": {"test": {"busyMs": 1, "waits": 3, "waitMs": 9}}, "events": [\#(events.joined(separator: ","))]}"#
        let h = try JSONDecoder().decode(History.self, from: Data(capped.utf8))
        #expect(!h.eventsCoverRange)
        #expect(h.busiest(for: "test") == nil)
    }

    @Test("a session in a folder with a dot finds its transcript")
    func projectFolder() {
        #expect(AgentNames.projectFolder("/Users/me/.claude/worktrees/x") == "-Users-me--claude-worktrees-x")
        #expect(AgentNames.projectFolder("/private/tmp/claude-503/-Users-me/s") == "-private-tmp-claude-503--Users-me-s")
    }

    @Test("a thread read here stays read until a newer note lands")
    func readMarker() {
        let t = AgentThread(agent: "b8", to: "b8", alive: true, working: nil, unread: 1, last: 100, messages: [])
        #expect(t.hidingRead(at: 100).unread == 0)
        #expect(t.hidingRead(at: 99).unread == 1)
        #expect(t.hidingRead(at: nil).unread == 1)
    }

    @Test("dibs's notices to an agent never crowd out the agent's own unread note")
    func noticesAreNotNotes() {
        let note = ThreadMessage(id: "m1", at: 10, from: "agent", kind: "note", text: "done with the build")
        let notice = ThreadMessage(id: "m2", at: 20, from: "dibs", kind: "notice", text: "your job #12 has used no CPU for 25 min")
        let t = AgentThread(agent: "b8", to: "b8", alive: true, working: nil, unread: 1, last: 20, messages: [note, notice])
        let needs = Needs.items(counters: [], questions: [], threads: [t], now: .now)
        #expect(needs.map(\.detail) == ["done with the build"])
        #expect(notice.fromDibs)
    }

    @Test("a running job that does nothing while others wait is a need; paused or unwaited-for, it isn't")
    func stuckJob() {
        let now = Date.now
        var held = row(1, res: "sim", who: "d3", held: true, since: now.addingTimeInterval(-3600), purpose: "ui tests")
        held.idleFor = 25 * 60
        let waiter = row(2, res: "sim", who: "b8", since: now.addingTimeInterval(-60), blocked: "slot: sim")
        let needs = Needs.items(counters: [counter("sim", serving: [held], waiting: [waiter])], questions: [], now: now)
        #expect(needs.map(\.kind) == [.idle])
        #expect(needs[0].title == "d3's job looks stuck")
        #expect(needs[0].detail.contains("25 min"))
        #expect(needs[0].detail.contains("b8 is waiting for the simulator"))

        #expect(Needs.items(counters: [counter("sim", serving: [held], waiting: [])], questions: [], now: now).isEmpty)
        var paused = held
        paused.pausedText = "Paused while free disk space is low"
        #expect(Needs.items(counters: [counter("sim", serving: [paused], waiting: [waiter])], questions: [], now: now).isEmpty)
        var busy = held
        busy.idleFor = 6 * 60
        #expect(Needs.items(counters: [counter("sim", serving: [busy], waiting: [waiter])], questions: [], now: now).isEmpty)
    }

    @Test("the app says when what it shows is old")
    func freshness() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(Freshness.line(updated: now.addingTimeInterval(-3), failing: false, now: now)?.text == "Updated just now")
        #expect(Freshness.line(updated: now.addingTimeInterval(-25), failing: false, now: now)?.stale == false)
        #expect(Freshness.line(updated: now.addingTimeInterval(-45), failing: false, now: now)?.stale == true)
        let failed = Freshness.line(updated: now.addingTimeInterval(-5), failing: true, now: now)
        #expect(failed?.stale == true)
        #expect(failed?.text.hasPrefix("Can't reach dibs since") == true)
        #expect(Freshness.line(updated: nil, failing: true, now: now) == nil)
    }

    @Test("dibs's errors read as sentences without lease numbers or terminal commands")
    func actionText() {
        #expect(ActionText.plain("#3609 isn't paused by you (it's paused: disk low, which dibs undoes by itself). Nothing changed.", who: "web-app")
                == "web-app was paused by dibs, not by you. It resumes by itself when there's room.")
        #expect(ActionText.plain("no lease or waiter #12. Ids are on the board: dibs --detail", who: "b8") == "b8's job already ended, so there was nothing left to change.")
        #expect(ActionText.plain("dibs boost is for the person who runs these agents, not for an agent: ask the person.", who: nil).hasPrefix("dibs only takes this from you"))
        #expect(!ActionText.tidy("#12 b8's sim run is busy. Use: dibs pause 12").contains("#"))
        #expect(ActionText.owner("boosted by owner") == "You let it go first")
        #expect(ActionText.owner("capped idle by owner") == "You set it to run only when nothing else is waiting")
    }

    @Test("a subagent's job carries its own name; a main agent's doesn't")
    func subagentNames() {
        #expect(Row.subagent(label: "format-org", agentId: "aformat-org-94f6", who: "alex-d3", agent: "alex-d3") == "format-org")
        #expect(Row.subagent(label: "", agentId: nil, who: "alex-d3", agent: "alex-d3") == nil)
        #expect(Row.subagent(label: "alex-d3", agentId: "main", who: "alex-d3", agent: nil) == nil)
        #expect(Row.subagent(label: "", agentId: "a1b2c3d4e5", who: "alex-d3", agent: nil) == "1b2c3d4e")
        #expect(Row.subagent(label: "general-purpose", agentId: "a1b2", who: "alex-d3", agent: nil, purpose: "fix tests") == "\"fix tests\"")
        #expect(Row.subagent(label: "spec-fixer", agentId: "a1b2", who: "alex-d3", agent: nil) == "spec-fixer")
    }

    @Test("a 0.0.86 board decodes its new fields, and a field in a shape the app doesn't know costs nothing")
    func board086() throws {
        let b = try board("""
        {\(machine), "hold": "memory frees up (12 GB of the 11 GB dibs shares out is taken)", "limits": "memory 12 GB of 11 GB taken (none left)",
         "held": [
          {"id": 1, "res": ["test"], "who": "d3", "label": "format-org", "agentId": "aformat-org-94f6", "kind": "run", "start": 0, "idleMs": 1500000,
           "overAsk": {"used": 9663676416, "asked": 4294967296, "planned": 4294967296, "suggest": "9G"},
           "plain": {"headline": "Running tests", "endsText": "no end time", "stuck": "idle for 25 min, may be stuck (#1)"}},
          {"id": 2, "res": ["sim"], "who": "b8", "start": 0, "overAsk": "a string this app doesn't know", "agentId": 7}
        ], "waiting": [
          {"id": 3, "res": ["test"], "who": "b8", "enq": 0, "pid": 4, "blocked": "memory",
           "plain": {"startsIn": null, "startsText": "unknown", "waitingFor": "room in memory: it needs 4 GB", "family": "memory",
                     "advice": "Keep waiting: raising the priority is not the fix"}}
        ]}
        """)
        #expect(b.hold?.hasPrefix("memory frees up") == true)
        #expect(b.limits != nil)
        let rows = b.rows()
        #expect(rows[0].subagent == "format-org")
        #expect(rows[0].overAsk?.used == 9663676416)
        #expect(rows[0].idleFor == 1500)
        #expect(rows[1].overAsk == nil)
        #expect(rows[1].subagent == nil)
        #expect(rows[2].family == "memory")
        #expect(rows[2].advice != nil)
        #expect(Needs.waitsOnMac(rows[2]))
    }

    @Test("a 0.0.85 board still decodes with none of the new fields")
    func board085() throws {
        let b = try board(#"{"machine": {"memFree": 60}, "held": [], "waiting": []}"#)
        #expect(b.hold == nil)
        #expect(b.limits == nil)
        #expect(b.machine.memBudget == nil)
    }

    @Test("a duplicate run dibs refused comes through history with who and which subagent")
    func twinEvent() throws {
        let json = #"{"since": 0, "until": 1, "events": [{"at": 1, "kind": "twin", "id": 812, "res": ["test"], "who": "alex-d3", "agent": "alex-d3", "agentId": "aformat-org-94f6", "label": "format-org", "cmd": "npm test"}]}"#
        let e = try #require(try JSONDecoder().decode(History.self, from: Data(json.utf8)).events.first)
        #expect(e.kind == "twin")
        #expect(e.who == "alex-d3")
        #expect(e.label == "format-org")
        #expect(e.res == ["test"])
    }
}
