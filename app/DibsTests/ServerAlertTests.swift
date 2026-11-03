import Foundation
import Testing

@Suite("dibs alerts")
struct ServerAlertTests {
    private func alert(_ id: String, cause: String = "wait", level: String = "warn", resolved: Double? = nil) -> DibsAlert {
        DibsAlert(id: id, cause: cause, level: level, title: "t \(id)", fix: "f", since: 1_800_000_000_000, resolvedAt: resolved)
    }

    @Test("the board's alerts decode, and an older dibs without them still decodes")
    func decoding() throws {
        let json = #"{"machine":{"memFree":50},"held":[],"waiting":[],"quotas":[],"caps":{},"alerts":[{"id":"wait:#2","cause":"wait","level":"urgent","title":"api's #2 has waited 15 min","why":"test is in use","fix":"dibs boost 2 urgent","job":2,"who":"api","since":1800000000000,"resolvedAt":null},{"id":"disk","cause":"disk","level":"urgent","title":"Free disk is low","fix":"Free disk","since":1800000000000,"resolvedAt":1800000300000,"dismissed":true}]}"#
        let b = try JSONDecoder().decode(Board.self, from: Data(json.utf8))
        #expect(b.alerts?.count == 2)
        #expect(b.alerts?[0].open == true && b.alerts?[0].job == 2 && b.alerts?[0].kind == .stuck)
        #expect(b.alerts?[1].open == false && b.alerts?[1].dismissed == true)
        let old = #"{"machine":{"memFree":50},"held":[],"waiting":[],"quotas":[],"caps":{}}"#
        #expect(try JSONDecoder().decode(Board.self, from: Data(old.utf8)).alerts == nil)
    }

    @Test("each alert notifies once, at most one notification per cause every 30 minutes")
    func gate() {
        var g = AlertCauseGate()
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        let first = g.pass([alert("wait:#1"), alert("memory", cause: "memory", level: "urgent")], now: t0)
        #expect(first.map(\.cause) == ["memory", "wait"])
        #expect(g.pass([alert("wait:#1"), alert("memory", cause: "memory")], now: t0.addingTimeInterval(60)).isEmpty, "nothing new")
        #expect(g.pass([alert("wait:#1"), alert("wait:#2")], now: t0.addingTimeInterval(10 * 60)).isEmpty, "a new wait, but wait spoke 10 min ago")
        let later = g.pass([alert("wait:#1"), alert("wait:#2")], now: t0.addingTimeInterval(31 * 60))
        #expect(later.map { $0.alerts.map(\.id) } == [["wait:#2"]])
        #expect(g.pass([alert("x", resolved: 1)], now: t0.addingTimeInterval(3 * 3600)).isEmpty, "a resolved alert never notifies")
    }

    @Test("a muted cause never notifies, and doesn't use up its 30 minutes")
    func muted() {
        var g = AlertCauseGate()
        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(g.pass([alert("failed:a", cause: "ended", level: "note")], now: t0, enabled: [.stuck]).isEmpty)
        #expect(g.lastSent["ended"] == nil)
    }
}
