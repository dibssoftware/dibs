import Charts
import SwiftUI

// The web page's Stats, from `dibs stats --json`: a few sentences, then
// every day, by hour, the agents, the resources, what held jobs back, the
// machine and who changed what. With an agent picked, that agent's own.
struct StatsScreen: View {
    @Environment(Store.self) private var store
    @State private var range = "7d"
    @State private var heatKind = "run"

    // Stats read the whole event log; a minute between reads is plenty.
    private static let reload: Duration = .seconds(60)

    var body: some View {
        let key = Store.statsKey(range, store.chosen)
        VStack(alignment: .leading, spacing: Space.xxl) {
            if let s = store.stats[key] {
                PageHead(title: store.chosen.map(store.displayName) ?? "Stats") { Text(s.lead) }
                tools
                report(s)
            } else {
                PageHead(title: store.chosen.map(store.displayName) ?? "Stats", summary: "")
                tools
                if let e = store.statsErrors[key] {
                    Text(e.message).foregroundStyle(Palette.accentInk).fixedSize(horizontal: false, vertical: true)
                } else {
                    Loading("Counting")
                }
            }
        }
        .page()
        .navigationTitle("Stats")
        .task(id: key) {
            while !Task.isCancelled {
                await store.loadStats(since: range, agent: store.chosen)
                try? await Task.sleep(for: store.stats[key] == nil ? .seconds(3) : Self.reload)
            }
        }
    }

    private var tools: some View {
        HStack(spacing: Space.m) {
            SpanPicker(range: $range)
            if store.chosen != nil {
                Button("Everyone") { store.chosen = nil }.buttonStyle(InkButton())
            }
        }
    }

    static func plural(_ n: Int, _ w: String) -> String { Stats.plural(n, w) }
    static func pct(_ x: Double?) -> String { Stats.pct(x) }

    @ViewBuilder
    private func report(_ s: Stats) -> some View {
        if s.totals.jobs == 0 && (s.totals.posts ?? 0) == 0 {
            Text("\(store.chosen.map(store.displayName) ?? "Nobody") ran anything through dibs in this period.").foregroundStyle(Palette.ink3)
        } else {
            PageSection(title: "Every day") { legend } content: { dayChart(s.days) }
            PageSection(title: "By hour") {
                Picker("Show", selection: $heatKind) {
                    Text("Running").tag("run")
                    Text("Waiting").tag("wait")
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
            } content: {
                let kind = heatKind
                HeatGrid(rows: s.grid.map { ($0.day, kind == "run" ? $0.run : $0.wait) }, tint: kind == "run" ? Palette.accent : Palette.yellow,
                         describe: { "\(kind == "run" ? "ran" : "waited") \(Span.short(ms: $0))" })
            }
            if store.chosen == nil && !s.agents.isEmpty {
                PageSection("Agents", note: "Click one for its own numbers") { agentTable(s.agents) }
            }
            if store.chosen != nil, let a = s.agents.first { agentDetail(a) }
            if !s.resources.isEmpty {
                PageSection("Resources", note: "In use: share of the window something held it") { resourceTable(s.resources) }
            }
            if let held = s.totals.heldBy, !held.isEmpty {
                PageSection("What held jobs back", note: "Time jobs waited, by the rule that held them") {
                    Bars(items: held.prefix(8).map { ($0.label, $0.ms, "\(Span.short(ms: $0.ms)), \(Self.plural($0.jobs ?? 0, "job"))") }, tint: Palette.yellow)
                }
            }
            if let m = s.machine {
                PageSection("The machine", note: Self.machineNote(m)) { machineChart(m, since: s.since, until: s.until) }
                if let o = m.overrides, !o.isEmpty {
                    PageSection("Overrides and setting changes", note: "\(o.count) in this window, by whoever made them") { ChangeList(changes: o) }
                }
            }
        }
    }

    private var legend: some View {
        HStack(spacing: Space.m) {
            key("running", Palette.accent)
            key("waiting", Palette.yellow)
        }
    }

    private func key(_ label: String, _ color: Color) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
            Text(label)
        }
    }

    private func dayChart(_ days: [Stats.Day]) -> some View {
        Chart {
            ForEach(days) { d in
                BarMark(x: .value("Day", Date(ms: d.day), unit: .day), y: .value("Hours", d.runMs / 3_600_000))
                    .foregroundStyle(Palette.accent)
                    .clipShape(.rect(cornerRadius: 2))
                BarMark(x: .value("Day", Date(ms: d.day), unit: .day), y: .value("Hours", d.waitMs / 3_600_000))
                    .foregroundStyle(Palette.yellow)
                    .clipShape(.rect(cornerRadius: 2))
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .day, count: days.count > 8 ? 3 : 1)) { _ in
                AxisValueLabel(format: days.count > 8 ? .dateTime.day() : .dateTime.day().weekday(.abbreviated), centered: true)
                    .font(Typeface.axis)
                    .foregroundStyle(Palette.ink3)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { v in
                AxisGridLine().foregroundStyle(Palette.hairline)
                AxisValueLabel { if let h = v.as(Double.self) { Text("\(Int(h))h") } }.font(Typeface.axis).foregroundStyle(Palette.ink3)
            }
        }
        .frame(height: 190)
    }

    private func agentTable(_ agents: [Stats.AgentStats]) -> some View {
        let max = agents.map { $0.runMs + $0.waitMs }.max() ?? 1
        return StatTable(columns: ["Agent", "Jobs", "Ran / waited", "Had to wait", "Waited longer than ran", "Failed", "ETAs met", "Posts"],
                         numeric: [false, true, false, true, true, true, true, true],
                         rows: agents.map { a in
            StatTable.Row(id: a.who, cells: [
                AnyView(Text(store.displayName(a.who)).fontWeight(.semibold)),
                AnyView(Text(a.jobs.formatted())),
                AnyView(HStack(spacing: Space.s) { RunWait(run: a.runMs, wait: a.waitMs, max: max); Text("\(Span.short(ms: a.runMs)) / \(Span.short(ms: a.waitMs))") }),
                AnyView(Text((a.waited ?? 0) > 0 ? "\(Self.plural(a.waited!, "time")), usually \(Span.short(ms: a.feltMedian))" : "never")),
                AnyView(Text(Self.pct(a.waitedLongerShare))),
                AnyView(Text((a.runs ?? 0) > 0 ? "\(Self.pct(a.failRate)) of \(a.runs!)" : "-")),
                AnyView(Text((a.eta?.finished ?? 0) > 0 ? "\(a.eta!.onTime) of \(a.eta!.finished)" : "-")),
                AnyView(Text((a.posts ?? 0) > 0 ? "\(a.posts!)" : "-")),
            ])
        }, onPick: { store.chosen = $0 })
    }

    private func resourceTable(_ resources: [Stats.ResourceStats]) -> some View {
        StatTable(columns: ["Resource", "Jobs", "In use", "By hour of day", "Had to wait", "1 in 10 over", "Held back by", "Gave up"],
                  numeric: [false, true, true, false, true, true, false, true],
                  rows: resources.map { r in
            StatTable.Row(id: r.res, cells: [
                AnyView(Text(Plain.name(r.res)).fontWeight(.semibold)),
                AnyView(Text(r.jobs.formatted())),
                AnyView(Text("\(Span.short(ms: r.busyMs)), \(Self.pct(r.utilization))")),
                AnyView(HourStrip(hours: r.hours ?? [])),
                AnyView(Text((r.waited ?? 0) > 0 ? "\(r.waited!.formatted())x, usually \(Span.short(ms: r.feltMedian))" : "never")),
                AnyView(Text(Span.short(ms: r.p90Wait))),
                AnyView(Text(r.heldBy?.first.map { "\($0.label) (\(Span.short(ms: $0.ms)))" } ?? "-")),
                AnyView(Text((r.gaveUp ?? 0) > 0 ? "\(r.gaveUp!)" : "-")),
            ])
        }, onPick: nil)
    }

    @ViewBuilder
    private func agentDetail(_ a: Stats.AgentStats) -> some View {
        Text(Self.agentFacts(a)).foregroundStyle(Palette.ink2).fixedSize(horizontal: false, vertical: true)
        if let r = a.resources, !r.isEmpty {
            PageSection("Where its time went") {
                Bars(items: r.map { ($0.name, $0.ms, "\(Span.short(ms: $0.ms)), \(Self.plural($0.n, "job"))") }, tint: Palette.accent)
            }
        }
        if let codes = a.codes, !codes.isEmpty {
            PageSection("How its runs ended", note: "\(a.failed ?? 0) failed, \(a.stopped ?? 0) stopped by a signal") { ExitCodes(codes: codes) }
        }
        if let c = a.commands, !c.isEmpty {
            PageSection("Top commands", note: "From the run log, with time spent") {
                Bars(items: c.map { ($0.name, $0.ms, "\($0.n)x, \(Span.short(ms: $0.ms))") }, tint: Palette.accent)
            }
        }
        if let h = a.heldBy, !h.isEmpty {
            PageSection("What held it back") {
                Bars(items: h.prefix(6).map { ($0.label, $0.ms, Span.short(ms: $0.ms)) }, tint: Palette.yellow)
            }
        }
    }

    static func agentFacts(_ a: Stats.AgentStats) -> String {
        var out = (a.waited ?? 0) > 0
            ? "\(plural(a.waited!, "job")) of \(a.jobs) had to wait, usually \(Span.short(ms: a.feltMedian)); 1 in 10 jobs waited over \(Span.short(ms: a.p90Wait)). "
            : "None of its jobs had to wait. "
        if let m = a.peakMem, m > 0 { out += "Its biggest run used \(Format.gb(m)) of memory. " }
        if let b = a.blockedMs, b > 0 { out += "It was blocked for \(Span.short(ms: b))\((a.blockedNow ?? 0) > 0 ? " and still is" : ""). " }
        if let g = a.gaveUp, g > 0 { out += "\(plural(g, "request")) gave up waiting. " }
        if let p = a.posts, p > 0 { out += "\(plural(p, "progress post")), \(plural(a.tasksDone ?? 0, "task")) done." }
        return out.trimmingCharacters(in: .whitespaces)
    }

    static func machineNote(_ m: Stats.MachineStats) -> String {
        var parts: [String] = []
        if let h = m.loadHigh, let l = h.load { parts.append("load peaked at \(Int(l.rounded())) around \(Date(ms: h.at).formatted(.dateTime.weekday(.abbreviated).day())) \(Format.clock(Date(ms: h.at)))") }
        if let f = m.memLow?.memFree { parts.append("memory got down to \(Int(f.rounded()))% free") }
        parts.append("\(plural(m.pauses ?? 0, "pause")) (\(m.ownerPauses ?? 0) by hand, \(m.dibsPauses ?? 0) by dibs for memory or urgent work)")
        return parts.joined(separator: "; ")
    }

    // Load against the cores, free memory, free disk: three strips, one time axis.
    @ViewBuilder
    private func machineChart(_ m: Stats.MachineStats, since: Double, until: Double) -> some View {
        if m.series.isEmpty {
            Text("No machine samples in this window. The throttle watcher takes them (dibs service install throttle).").foregroundStyle(Palette.ink3)
        } else {
            let cores = Double(store.board?.machine.cores ?? 0)
            VStack(alignment: .leading, spacing: Space.l) {
                strip("Load", m.series.compactMap { p in p.load.map { (p.at, $0) } }, limit: cores > 0 ? cores : nil, limitLabel: "\(Int(cores)) cores", format: { "\(Int($0))" })
                strip("Memory free", m.series.compactMap { p in p.memFree.map { (p.at, $0) } }, limit: 15, limitLabel: "dibs holds jobs", format: { "\(Int($0))%" })
                strip("Disk free", m.series.compactMap { p in p.diskFree.map { (p.at, $0) } }, limit: Meters.floor, limitLabel: "5 GB floor", format: { Format.gb($0) })
            }
            .padding(Space.l)
            .card()
        }
    }

    private func strip(_ label: String, _ points: [(Double, Double)], limit: Double?, limitLabel: String, format: @escaping (Double) -> String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Typeface.small.weight(.medium)).foregroundStyle(Palette.ink2)
            Chart {
                ForEach(points, id: \.0) { p in
                    LineMark(x: .value("Time", Date(ms: p.0)), y: .value(label, p.1))
                        .foregroundStyle(Palette.ink2)
                        .lineStyle(StrokeStyle(lineWidth: 1.3))
                }
                if let limit {
                    RuleMark(y: .value("Limit", limit))
                        .foregroundStyle(Palette.accent.opacity(0.7))
                        .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .annotation(position: .top, alignment: .leading) {
                            Text(limitLabel).font(Typeface.small).foregroundStyle(Palette.ink3)
                        }
                }
            }
            .chartYAxis {
                AxisMarks(position: .leading, values: .automatic(desiredCount: 2)) { v in
                    AxisValueLabel { if let d = v.as(Double.self) { Text(format(d)) } }.font(Typeface.axis).foregroundStyle(Palette.ink3)
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 6)) { _ in
                    AxisGridLine().foregroundStyle(Palette.hairline)
                    AxisValueLabel().font(Typeface.axis).foregroundStyle(Palette.ink3)
                }
            }
            .frame(height: 74)
        }
    }
}

// Past day, Past week, Past 30 days: Stats and History both.
struct SpanPicker: View {
    @Binding var range: String

    var body: some View {
        Picker("Range", selection: $range) {
            Text("Past day").tag("1d")
            Text("Past week").tag("7d")
            Text("Past 30 days").tag("30d")
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
    }
}

// A table the way the web page draws one: a header row in small grey, then
// a row each, figures right-aligned. Clicking a row picks it when it can.
struct StatTable: View {
    struct Row: Identifiable {
        var id: String
        var cells: [AnyView]
    }
    let columns: [String]
    let numeric: [Bool]
    let rows: [Row]
    let onPick: ((String) -> Void)?

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: Space.l, verticalSpacing: 0) {
                GridRow {
                    ForEach(columns.indices, id: \.self) { i in
                        Text(columns[i])
                            .font(Typeface.small.weight(.medium))
                            .foregroundStyle(Palette.ink3)
                            .gridColumnAlignment(numeric[i] ? .trailing : .leading)
                    }
                }
                .padding(.vertical, Space.s + 2)
                ForEach(rows) { row in
                    Divider().overlay(Palette.hairline)
                    GridRow {
                        ForEach(row.cells.indices, id: \.self) { i in row.cells[i] }
                    }
                    .padding(.vertical, Space.s + 2)
                    .contentShape(.rect)
                    .onTapGesture { onPick?(row.id) }
                }
            }
            .font(Typeface.body)
            .foregroundStyle(Palette.ink)
            .padding(.horizontal, Space.l)
        }
        .scrollIndicators(.never)
        .card()
    }
}

// Days down, hours across: when work ran, or when agents waited.
struct HeatGrid: View {
    let rows: [(Double, [Double])]
    let tint: Color
    // What a cell's hover says after its hour: "ran 12m", "3 waiting".
    let describe: (Double) -> String

    var body: some View {
        let max = rows.flatMap(\.1).max().map { Swift.max(1, $0) } ?? 1
        VStack(alignment: .leading, spacing: 2) {
            // Every third hour labelled, each over its own column and free to run past it.
            HStack(spacing: 2) {
                Color.clear.frame(width: 60, height: 1)
                ForEach(0..<24, id: \.self) { h in
                    Color.clear
                        .frame(maxWidth: .infinity, minHeight: 16)
                        .overlay(alignment: .leading) {
                            if h % 3 == 0 {
                                Text(Self.hour(h))
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink3)
                                    .fixedSize()
                            }
                        }
                }
            }
            ForEach(rows, id: \.0) { day, values in
                HStack(spacing: 2) {
                    Text(Date(ms: day).formatted(.dateTime.day().weekday(.abbreviated)))
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .frame(width: 60, alignment: .leading)
                    ForEach(0..<24, id: \.self) { h in
                        let v = values.indices.contains(h) ? values[h] : 0
                        RoundedRectangle(cornerRadius: 2)
                            .fill(v > 0 ? tint.opacity(0.12 + 0.88 * (v / max).squareRoot()) : Palette.sunken)
                            .frame(height: rows.count > 10 ? 13 : 20)
                            .help("\(Self.hour(h)): \(describe(v))")
                    }
                }
            }
        }
    }

    static func hour(_ h: Int) -> String {
        Calendar.current.date(bySettingHour: h, minute: 0, second: 0, of: .now)?.formatted(.dateTime.hour()).lowercased().replacingOccurrences(of: " ", with: "") ?? "\(h)"
    }
}

// Horizontal bars, labelled, for a short ranked list.
struct Bars: View {
    let items: [(String, Double, String)]
    let tint: Color

    var body: some View {
        let max = items.map(\.1).max().map { Swift.max(1, $0) } ?? 1
        Grid(alignment: .leading, horizontalSpacing: Space.m, verticalSpacing: Space.s) {
            ForEach(items.indices, id: \.self) { i in
                GridRow {
                    Text(items[i].0)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 220, alignment: .leading)
                        .help(items[i].0)
                    GeometryReader { g in
                        Capsule().fill(Palette.sunken)
                            .overlay(alignment: .leading) {
                                Capsule().fill(tint).frame(width: Swift.max(2, g.size.width * items[i].1 / max))
                            }
                    }
                    .frame(height: 8)
                    Text(items[i].2)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink2)
                        .monospacedDigit()
                        .gridColumnAlignment(.trailing)
                }
            }
        }
        .font(Typeface.body)
        .foregroundStyle(Palette.ink)
    }
}

// Run and wait side by side, on a shared scale.
struct RunWait: View {
    let run: Double
    let wait: Double
    let max: Double

    var body: some View {
        HStack(spacing: 1) {
            RoundedRectangle(cornerRadius: 2).fill(Palette.accent).frame(width: Swift.max(run > 0 ? 1 : 0, 110 * run / max))
            RoundedRectangle(cornerRadius: 2).fill(Palette.yellow).frame(width: Swift.max(wait > 0 ? 1 : 0, 110 * wait / max))
        }
        .frame(width: 112, height: 8, alignment: .leading)
    }
}

// A tiny 24-hour strip: how busy a resource is at each hour of the day.
struct HourStrip: View {
    let hours: [Double]

    var body: some View {
        let max = Swift.max(0.05, hours.max() ?? 0)
        HStack(alignment: .bottom, spacing: 1) {
            ForEach(hours.indices, id: \.self) { h in
                Rectangle().fill(hours[h] > 0 ? Palette.accent : Palette.sunken)
                    .frame(width: 4, height: Swift.max(1, 16 * hours[h] / max))
                    .help("\(h):00: in use \(StatsScreen.pct(hours[h])) of the time")
            }
        }
        .frame(height: 18, alignment: .bottom)
    }
}

// How an agent's runs ended, as one bar split by exit code, and the key.
struct ExitCodes: View {
    let codes: [String: Int]

    var body: some View {
        let sorted = codes.sorted { $0.value > $1.value }
        let total = Swift.max(1, sorted.reduce(0) { $0 + $1.value })
        VStack(alignment: .leading, spacing: Space.s) {
            GeometryReader { g in
                HStack(spacing: 1) {
                    ForEach(sorted, id: \.key) { code, n in
                        Rectangle().fill(Self.color(code)).frame(width: g.size.width * Double(n) / Double(total))
                    }
                }
            }
            .frame(height: 10)
            .clipShape(Capsule())
            Flow(spacing: Space.m) {
                ForEach(sorted, id: \.key) { code, n in
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 2).fill(Self.color(code)).frame(width: 8, height: 8)
                        Text("\(code == "none" ? "no code" : "exit \(code)") \(n) (\(Int((100 * Double(n) / Double(total)).rounded()))%)")
                    }
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink2)
                }
            }
        }
    }

    // Green passed, grey stopped by a signal, red failed: the web page's.
    static func color(_ code: String) -> Color {
        if code == "0" { return Palette.working }
        if ["130", "137", "143", "none"].contains(code) { return Palette.ink3 }
        return Palette.accent
    }
}

// Who changed what by hand: the person or an agent, and when.
struct ChangeList: View {
    let changes: [Stats.Override]

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(changes.enumerated()), id: \.element.id) { i, e in
                if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                    Text("\(Text(e.by ?? "the person").fontWeight(.semibold).foregroundStyle(Palette.ink)) \(e.line)")
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
