import Foundation
import Testing

@Suite("Progress and pairing")
struct ProgressTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func ms(_ minutesAgo: Double) -> Double { (now.timeIntervalSince1970 - minutesAgo * 60) * 1000 }

    @Test("dibs progress --json decodes, label and eta optional")
    func decodes() throws {
        let json = #"[{"at":1800000000000,"who":"b8","task":"auth","state":"doing","eta":1800000600000,"text":"ran the tests","project":"dibs","branch":"web"},{"at":1800000001000,"who":"c2","label":"tester","state":"blocked","text":"no sim","project":"app"}]"#
        let posts = try JSONDecoder().decode([ProgressPost].self, from: Data(json.utf8))
        #expect(posts.count == 2)
        #expect(posts[1].task == nil && posts[1].eta == nil && posts[1].label == "tester")
    }

    @Test("a task shows its latest post, the agent who posted last comes first")
    func grouping() {
        let posts = [
            ProgressPost(at: ms(30), who: "b8", task: "auth", state: "doing", eta: ms(-20), text: "started", project: "dibs"),
            ProgressPost(at: ms(20), who: "c2", task: "ui", state: "doing", text: "sketching", project: "app"),
            ProgressPost(at: ms(10), who: "b8", task: "auth", state: "done", text: "41 pass", project: "dibs"),
            ProgressPost(at: ms(5), who: "b8", task: nil, state: "doing", text: "looking around", project: "dibs"),
        ]
        let agents = ProgressBoard.agents(posts)
        #expect(agents.map(\.who) == ["b8", "c2"])
        #expect(agents[0].tasks.map(\.title) == ["Work in dibs", "auth"])
        let auth = agents[0].tasks[1]
        #expect(auth.state == .done && auth.text == "41 pass" && auth.posts.count == 2)
        // The eta from the first post still stands after a post without one.
        #expect(auth.eta != nil)
    }

    @Test("ETA reads as done by, in; late once it passes; ended tasks are never late")
    func eta() {
        var t = ProgressTask(who: "b8", task: "auth", started: now, last: now, state: .doing,
                             eta: now.addingTimeInterval(12 * 60), text: "", posts: [])
        #expect(t.when(now: now)?.hasSuffix(", in 12m") == true)
        #expect(t.when(now: now)?.hasPrefix("done by ") == true)
        #expect(!t.late(now: now))
        t.eta = now.addingTimeInterval(-65 * 60)
        #expect(t.late(now: now))
        #expect(t.when(now: now)?.hasSuffix(", 1h 5m late") == true)
        t.state = .done
        #expect(!t.late(now: now))
    }

    @Test("the code is the first line of dibs pair")
    func code() {
        let out = "K7QM-4XNA\n\nOne use, good for 10 minutes. Type it on the dibs page."
        #expect(PairCode(output: out, issued: now)?.code == "K7QM-4XNA")
        #expect(PairCode(output: out, issued: now)?.expires == now.addingTimeInterval(600))
        #expect(PairCode(output: "dibs: unknown command pair") == nil)
    }

    @Test("dibs pair --list: browsers and MCP clients, by id")
    func paired() {
        let out = """
        1a2b3c4d  web page  signed in 11/1/2026, 8:05:00 PM
        9f8e7d6c  MCP: Claude Code  signed in 11/1/2026, 8:07:12 PM
        Sign one out: dibs pair --revoke <id>, or --revoke all
        """
        let list = PairedClient.list(out)
        #expect(list.map(\.id) == ["1a2b3c4d", "9f8e7d6c"])
        #expect(list[0].isPage && list[0].name == "Browser")
        #expect(list[1].name == "Claude Code" && list[1].since == "11/1/2026, 8:07:12 PM")
        #expect(PairedClient.list("Nothing is signed in. dibs pair gives a code for the page or an MCP client.").isEmpty)
    }

    @Test("dibs service status web: running, set up, or not")
    func service() {
        let what = "the page and MCP server showing your agents' work"
        let running = ServiceState(output: "web       \("running (pid 812)".padding(toLength: 28, withPad: " ", startingAt: 0)) \(what)")
        #expect(running.running && running.installed && running.detail == "running (pid 812)")
        let stuck = ServiceState(output: "web       installed, not running (last exit 78) \(what)")
        #expect(!stuck.running && stuck.installed && stuck.detail == "installed, not running (last exit 78)")
        let none = ServiceState(output: "web       \("not installed".padding(toLength: 28, withPad: " ", startingAt: 0)) \(what)")
        #expect(!none.running && !none.installed)
    }
}
