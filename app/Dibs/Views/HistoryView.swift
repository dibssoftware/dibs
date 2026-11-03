import Charts
import SwiftUI

// The web page's History, from `dibs history --json`: a few sentences, then
// by resource, when agents waited, by agent, what was changed by hand, and
// the latest events.
struct HistoryView: View {
    @Environment(Store.self) private var store
    @State private var range = "7d"

    // History changes slowly; a minute between reads is plenty.
    private static let reload: Duration = .seconds(60)

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xxl) {
            if !store.historySupported {
                PageHead(title: "History", summary: "This dibs (\(store.version ?? "an older version")) doesn't keep a history the app can read. Update to \(Store.ownerVersion) or newer.")
            } else if let history = store.histories[range] {
                let note = history.note(days: range == "1d" ? 1 : range == "30d" ? 30 : 7)
                PageHead(title: "History", summary: history.bottleneck == nil ? "\(note.headline) \(note.body)" : note.headline)
                SpanPicker(range: $range)
                if store.historyErrors[range] != nil {
                    Text("Couldn't update this. It's what dibs said at \(Format.clock(Date(ms: history.until))).")
                        .foregroundStyle(Palette.accentInk)
                }
                HistoryReport(history: history)
            } else if let error = store.historyErrors[range] ?? store.boardError {
                PageHead(title: "History", summary: "")
                SpanPicker(range: $range)
                Text(error.message).foregroundStyle(Palette.accentInk).fixedSize(horizontal: false, vertical: true)
            } else {
                PageHead(title: "History", summary: "")
                SpanPicker(range: $range)
                Loading("Reading the history")
            }
        }
        .page()
        .navigationTitle("History")
        .task(id: range) {
            while !Task.isCancelled {
                await store.loadHistory(since: range)
                try? await Task.sleep(for: store.histories[range] == nil ? .seconds(2) : Self.reload)
            }
        }
    }
}

struct HistoryReport: View {
    @Environment(Store.self) private var store
    let history: History

    // The web page shows this many of the newest events.
    static let latestShown = 120

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xxl) {
            if !history.resources.isEmpty {
                PageSection("By resource") { resourceTable }
            }
            if !history.hourly.isEmpty {
                PageSection("When agents waited", note: "Darker: more agents waiting at once") {
                    HeatGrid(rows: waitRows, tint: Palette.yellow, describe: { "\(Int($0)) waiting" })
                }
            }
            if !history.agents.isEmpty {
                let top = history.agents.sorted { $0.value.holdMs + $0.value.waitMs > $1.value.holdMs + $1.value.waitMs }.prefix(12)
                let max = top.map { $0.value.holdMs + $0.value.waitMs }.max() ?? 1
                PageSection("By agent", note: "Time using something, and time waiting for it") {
                    Grid(alignment: .leading, horizontalSpacing: Space.m, verticalSpacing: Space.s) {
                        ForEach(Array(top), id: \.key) { name, a in
                            GridRow {
                                Text(store.displayName(name)).lineLimit(1).frame(maxWidth: 220, alignment: .leading)
                                RunWait(run: a.holdMs, wait: a.waitMs, max: max)
                                Text("\(Span.short(ms: a.holdMs)) / \(Span.short(ms: a.waitMs))")
                                    .font(Typeface.small).foregroundStyle(Palette.ink2).monospacedDigit()
                            }
                        }
                    }
                }
            }
            let changes = history.events.filter { $0.kind == "override" }.reversed().prefix(60)
            if !changes.isEmpty {
                PageSection("What was changed by hand", note: "Agents may do anything you can; this names who did what") {
                    VStack(spacing: 0) {
                        ForEach(Array(changes.enumerated()), id: \.offset) { i, e in
                            if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                            HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                                Text("\(Text(e.changedBy.map(store.displayName) ?? "the person").fontWeight(.semibold).foregroundStyle(Palette.ink)) \(Self.changeLine(e))")
                                    .foregroundStyle(Palette.ink2)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: Space.m)
                                Text(Span.ago(Date.now.timeIntervalSince(Date(ms: e.at))))
                                    .font(Typeface.small.weight(.medium))
                                    .foregroundStyle(Palette.ink2)
                            }
                            .padding(.horizontal, Space.l + 2)
                            .padding(.vertical, Space.m)
                        }
                    }
                    .card()
                }
            }
            let latest = history.events.filter { !["override", "clean", "overask"].contains($0.kind) }.reversed().prefix(Self.latestShown)
            PageSection("Latest", note: "\(latest.count) newest events") {
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(Array(latest.enumerated()), id: \.offset) { _, e in
                        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                            Text(Format.clock(Date(ms: e.at)))
                                .font(Typeface.time)
                                .foregroundStyle(Palette.ink3)
                                .frame(width: 64, alignment: .leading)
                            Text("\(Text(e.who.map(store.displayName) ?? "dibs").fontWeight(.semibold).foregroundStyle(Palette.ink)) \(Self.eventLine(e))")
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    // Days down, the most agents waiting at once in each hour across.
    private var waitRows: [(Double, [Double])] {
        let cal = Calendar.current
        var days: [Date: [Double]] = [:]
        for h in history.hourly {
            let d = Date(ms: h.hour)
            days[cal.startOfDay(for: d), default: Array(repeating: 0, count: 24)][cal.component(.hour, from: d)] = h.waiting
        }
        return days.keys.sorted().map { ($0.timeIntervalSince1970 * 1000, days[$0]!) }
    }

    private var resourceTable: some View {
        // Every file lease together in one row, as the web page shows them.
        var rows = history.resources.filter { !$0.key.hasPrefix("files:") }.map { ($0.key, $0.value) }
        let files = history.resources.filter { $0.key.hasPrefix("files:") }.map(\.value)
        if !files.isEmpty {
            rows.append(("files", History.Resource(busyMs: files.reduce(0) { $0 + $1.busyMs }, waits: files.reduce(0) { $0 + $1.waits },
                                                         waitMs: files.reduce(0) { $0 + $1.waitMs }, p50WaitMs: nil, p90WaitMs: nil,
                                                         peakQueue: files.compactMap(\.peakQueue).max(), timeouts: files.reduce(0) { $0 + ($1.timeouts ?? 0) })))
        }
        rows.sort { ($0.1.waitMs, $0.1.busyMs) > ($1.1.waitMs, $1.1.busyMs) }
        return StatTable(columns: ["Resource", "In use", "Waits", "Waited", "Usual / long wait", "Longest queue", "Gave up", "Waits mostly"],
                         numeric: [false, true, true, true, true, true, true, false],
                         rows: rows.prefix(30).map { name, r in
            StatTable.Row(id: name, cells: [
                AnyView(Text(Plain.name(name)).fontWeight(.semibold)),
                AnyView(Text(Span.short(ms: r.busyMs))),
                AnyView(Text("\(r.waits)")),
                AnyView(Text(Span.short(ms: r.waitMs))),
                AnyView(Text(r.waits > 0 && r.p50WaitMs != nil ? "\(Span.short(ms: r.p50WaitMs)) / \(Span.short(ms: r.p90WaitMs))" : "-")),
                AnyView(Text(r.peakQueue.map(String.init) ?? "-")),
                AnyView(Text((r.timeouts ?? 0) > 0 ? "\(r.timeouts!)" : "-")),
                AnyView(Text(r.mostly.flatMap { $0.count == 2 ? "\(Format.hourName($0[0])) to \(Format.hourName(($0[0] + $0[1]) % 24))" : nil } ?? "-")),
            ])
        }, onPick: nil)
    }

    // The web page's words for a change by hand.
    static func changeLine(_ e: History.Event) -> String {
        let job = e.id.map { "#\($0)" } ?? "a job"
        let what: String = switch e.act ?? "" {
        case "boost": "set \(job) to \(e.prio ?? "?")"
        case "pause": "paused \(job)"
        case "resume": "resumed \(job)"
        case "stop": "stopped \(job)"
        case "cap": "capped \(e.who ?? "an agent") at \(e.prio ?? "?")"
        case "answer": "answered a question"
        case "dismiss": "dismissed a question"
        case let act: act
        }
        let whose = e.who.flatMap { e.act == "cap" ? nil : " (\($0)'s)" } ?? ""
        return "\(what)\(whose)\(e.reason.map { ": \($0)" } ?? "")"
    }

    // The web page's words for an event in the log.
    static func eventLine(_ e: History.Event) -> String {
        let res = (e.res ?? []).joined(separator: ", ")
        switch e.kind {
        case "start": return "started \(res)\((e.ms ?? 0) > 1000 ? " after waiting \(Span.short(ms: e.ms))" : "")"
        case "end": return "finished \(res) after \(Span.short(ms: e.ms))\(e.code.map { ", exit \($0)" } ?? "")"
        case "wait": return "began waiting for \(res)"
        case "timeout": return "gave up waiting for \(res)"
        case "left": return "left the line for \(res)"
        default: return "\(e.kind) \(res)"
        }
    }
}

// Days down, hours across, so the shape of a working week shows at a glance.
struct WaitHeatmap: View {
    struct Cell: Identifiable {
        var row: Int
        var hour: Int
        var waiting: Double
        var id: Int { row * 24 + hour }
    }

    let hourly: [History.Hour]

    var body: some View {
        let calendar = Calendar.current
        let days = Array(Set(hourly.map { calendar.startOfDay(for: Date(ms: $0.hour)) })).sorted()
        // The first day on top: row 0 is drawn highest.
        let cells = hourly.map { h in
            let date = Date(ms: h.hour)
            let day = days.firstIndex(of: calendar.startOfDay(for: date)) ?? 0
            return Cell(row: days.count - 1 - day, hour: calendar.component(.hour, from: date), waiting: h.waiting)
        }
        Chart(cells) { c in
            RectangleMark(xStart: .value("Hour", Double(c.hour) + 0.05), xEnd: .value("Hour", Double(c.hour) + 0.95),
                          yStart: .value("Day", Double(c.row) + 0.1), yEnd: .value("Day", Double(c.row) + 0.9))
                .foregroundStyle(by: .value("Waiting", c.waiting))
                .accessibilityLabel("\(days[days.count - 1 - c.row].formatted(.dateTime.weekday(.wide))), \(Self.hourName(c.hour))")
                .accessibilityValue("\(Int(c.waiting)) waiting")
        }
        .chartForegroundStyleScale(range: Gradient(colors: [Palette.sunken, Palette.accent]))
        .chartXScale(domain: 0...24)
        .chartYScale(domain: 0...Double(days.count))
        .chartXAxis {
            AxisMarks(values: [0, 6, 12, 18, 24]) { v in
                AxisGridLine()
                AxisValueLabel {
                    if let h = v.as(Int.self) { Text(Self.hourName(h)) }
                }
                .font(Typeface.axis)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: days.indices.map { Double($0) + 0.5 }) { v in
                AxisValueLabel {
                    if let y = v.as(Double.self) {
                        Text(days[days.count - 1 - Int(y)].formatted(.dateTime.weekday(.abbreviated).day()))
                    }
                }
                .font(Typeface.axis)
            }
        }
        .chartLegend(.hidden)
        .frame(height: CGFloat(days.count) * 22 + 28)
    }

    static func hourName(_ h: Int) -> String { Format.hourName(h) }
}
