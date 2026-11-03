import Foundation
import Testing

private final class Token {}

// The screens the app gained to match the web page: Later and Stats read
// the CLI's JSON, and the times read the way the page says them.
@Suite("The web page's screens")
struct MatchTests {
    @Test("dibs stats --json decodes, with an agent's own numbers and the overrides")
    func stats() throws {
        let url = try #require(Bundle(for: Token.self).url(forResource: "stats", withExtension: "json"))
        let s = try JSONDecoder().decode(Stats.self, from: Data(contentsOf: url))
        #expect(s.agents.first?.who == "web-app")
        #expect(s.resources.first?.res == "sim")
        #expect(s.totals.heldBy?.first?.label == "another agent had it")
        #expect(s.machine?.overrides?.first?.line == "set #12 to urgent (tests's): person waiting")
        #expect(s.lead.hasPrefix("\(Stats.plural(s.totals.agents ?? 0, "agent")) ran \(Stats.plural(s.totals.jobs, "job")) for "))
    }

    @Test("dibs later list --json decodes; running comes before what's still scheduled")
    func later() throws {
        let json = #"{"jobs":[{"id":"l2","state":"scheduled","res":["heavy"],"who":"b8","purpose":"nightly sweep","cmd":"x","when":"at 02:00 AM","at":1800003600000},{"id":"l3","state":"running","res":["deploy"],"who":"c2","purpose":null,"cmd":"./ship.sh","when":null,"fired":1800000000000,"code":null},{"id":"l4","state":"done","res":["test"],"who":"c2","cmd":"npm test","ended":1800000000000,"code":0}]}"#
        let list = try JSONDecoder().decode(LaterList.self, from: Data(json.utf8)).jobs
        let active = list.filter(\.active).sorted(by: LaterRun.order)
        #expect(active.map(\.id) == ["l3", "l2"])
        #expect(active[0].what == "./ship.sh")
        #expect(list[0].side(now: .now) == "heavy, at 02:00 AM")
        #expect(!list[2].active)
    }

    @Test("dibs service status reads as rows, the relay's own line skipped")
    func services() {
        let out = """
        serve     not installed                the coordinator for your machines
        web       running (pid 812)            the page and MCP server showing your agents' work
        relay     installed, not running (last exit 1)  reach the page from any browser
                  relay: not running
        """
        let rows = ServiceRow.list(out)
        #expect(rows.map(\.name) == ["serve", "web", "relay"])
        #expect(rows[1].running && rows[1].state == "running (pid 812)")
        #expect(!rows[0].installed && rows[2].installed && !rows[2].running)
    }

    @Test("dibs pair --list: the page, MCP clients and devices paired through the relay, each with its own words")
    func paired() {
        let out = """
        1a2b3c4d  web page  signed in 11/2/2026, 1:26:13 AM
        5e6f7a8b  MCP: Claude  signed in 11/2/2026, 1:30:00 AM
        9c0d1e2f  remote: Safari on iPhone, look only  paired 11/2/2026, 2:00:00 AM, last connected 3m ago
        Sign one out: dibs pair --revoke <id>, or --revoke all
        """
        let list = PairedClient.list(out)
        #expect(list.map(\.id) == ["1a2b3c4d", "5e6f7a8b", "9c0d1e2f"])
        #expect(list[2].isRemote && list[2].name == "Safari on iPhone, look only")
        #expect(list[2].since.hasSuffix("last connected 3m ago"))
        #expect(!list[0].isRemote && list[0].isPage)
    }

    @Test("a message still waiting for its agent's next tool call reads as not delivered")
    func queued() {
        let thread = AgentThread(agent: "a1", to: "a1", alive: true, working: nil, unread: 0, last: 2,
                                 messages: [ThreadMessage(id: "m1", at: 1, from: "person", kind: "message", text: "hold on", state: "queued"),
                                            ThreadMessage(id: "m2", at: 2, from: "person", kind: "message", text: "go", state: "delivered")])
        let items = Chat.items(threads: [thread], questions: [])
        #expect(items.map(\.queued) == [true, false])
    }

    @Test("times read as the web page says them")
    func spans() {
        #expect(Span.ago(20) == "just now")
        #expect(Span.ago(12 * 60) == "12m ago")
        #expect(Span.ago(185 * 60) == "3h 5m ago")
        #expect(Span.ago(50 * 3600) == "2d ago")
        #expect(Span.short(ms: 40_000) == "40s")
        #expect(Span.short(ms: 200 * 60_000) == "3h 20m")
        #expect(Span.short(ms: 31 * 3_600_000) == "31h")
        #expect(Span.short(ms: nil) == "-")
    }
}
