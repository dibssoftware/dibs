import Charts
import SwiftUI

// The machines as a TV guide. In Channels, every resource is a channel and
// every job a program; in Whole machine, all of a machine's work shares one
// timeline, colored by what it's using. Each machine leads with its load, so
// the person can see how hard it was working at any moment: hover the graph.
// What already ran sits left of the red line at now, what's on runs through
// it, what's coming up follows. Click a program for its details, or a channel
// for its day.
struct ScheduleView: View {
    @Environment(Store.self) private var store
    @State private var pick: Pick?
    // Go first or Stop on a job picked in the guide, waiting for the person to confirm.
    @State private var pending: PendingAction?
    // The screen's width, to decide whether the panel sits beside the guide or over it.
    @State private var width: CGFloat = 1200
    @AppStorage("scheduleMode") private var mode = Mode.channels
    // Where the pointer is on a load graph: which machine, and when.
    @State private var hover: (machine: String, at: Date)?

    enum Mode: String { case channels, machine }

    enum Pick: Equatable {
        case program(String)
        case channel(String)
    }

    // How far back and ahead the guide reaches, and how wide a minute is.
    nonisolated static let before: TimeInterval = 2 * 3600
    static let after: TimeInterval = 2 * 3600
    static let perMinute: CGFloat = 7
    static let channelWidth: CGFloat = 178
    static let laneHeight: CGFloat = 44
    static let loadHeight: CGFloat = 76
    static let machineHeight: CGFloat = 40
    static let freeHeight: CGFloat = 40
    // The whole-machine view shows this many rows of work before "+N more".
    static let machineLanes = 8
    private static let sideBySide: CGFloat = 1000

    // One machine's part of the guide.
    struct Part: Identifiable {
        var machine: String
        var title: String
        var channels: [Channel]
        var load: [LoadLog.Point]
        var ceiling: Double?
        var loadNow: Double?
        var id: String { machine }
    }

    // A program with the channel it's on, for the whole-machine view's colors.
    struct Item: Identifiable {
        var program: Program
        var res: String
        var id: String { program.id }
    }

    // The guide's rows, the same down the names column and the timeline.
    enum Line: Identifiable {
        case machine(Part)
        case load(Part)
        case channel(Channel)
        case whole(Part, [[Item]], hidden: Int)
        case free(Part, [String])

        var id: String {
            switch self {
            case .machine(let p): "m-\(p.machine)"
            case .load(let p): "l-\(p.machine)"
            case .channel(let c): "c-\(c.id)"
            case .whole(let p, _, _): "w-\(p.machine)"
            case .free(let p, _): "f-\(p.machine)"
            }
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let now = context.date
            let parts = self.parts(now: now)
            let channels = parts.flatMap(\.channels)
            let wide = width >= Self.sideBySide
            ZStack(alignment: .trailing) {
                HStack(spacing: 0) {
                    guide(parts, now: now)
                        .frame(maxWidth: .infinity)
                    if wide, let pick {
                        Rectangle().fill(Palette.hairline).frame(width: 1)
                        panel(pick, channels: channels, now: now)
                    }
                }
                if !wide, let pick {
                    panel(pick, channels: channels, now: now)
                        .overlay(alignment: .leading) { Rectangle().fill(Palette.hairline).frame(width: 1) }
                        .shadow(color: .black.opacity(0.16), radius: 18, x: -4)
                }
            }
            .animation(.easeOut(duration: 0.2), value: pick)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .navigationTitle("Schedule")
        .jobConfirm($pending)
        // Over the page like the web page's view tools; the window has no toolbar.
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("View", selection: $mode) {
                Text("Channels").tag(Mode.channels)
                Text("Whole machine").tag(Mode.machine)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 44)
            .padding(.top, 20)
        }
        .onChange(of: store.focusRes, initial: true) { _, res in
            guard let res, store.section == .schedule else { return }
            mode = .channels
            pick = .channel("\(store.hostName)/\(res.hasPrefix("files:") ? "files" : res)")
            store.focusRes = nil
        }
    }

    // This Mac first, then the other machines in the group.
    private func parts(now: Date) -> [Part] {
        let m = store.board?.machine
        var parts = [Part(machine: store.hostName, title: "This Mac",
                          channels: Channel.all(counters: store.counters, history: store.today, machine: store.hostName, now: now),
                          load: store.loadLog.points(store.hostName, hourly: store.today?.hourly ?? []),
                          ceiling: m?.maxLoad ?? m?.cores.map(Double.init), loadNow: m?.load)]
        for peer in store.board?.peers(excluding: store.hostName) ?? [] {
            parts.append(Part(machine: peer.name, title: peer.name,
                              channels: Channel.all(counters: peer.rows().counters(), history: nil, machine: peer.name, now: now),
                              load: store.loadLog.points(peer.name), ceiling: nil, loadNow: peer.load))
        }
        return parts
    }

    private func lines(_ parts: [Part]) -> [Line] {
        parts.flatMap { part -> [Line] in
            var out: [Line] = [.machine(part), .load(part)]
            switch mode {
            case .channels:
                out += part.channels.filter { !$0.programs.isEmpty }.map(Line.channel)
                let free = part.channels.filter(\.programs.isEmpty).map(\.name)
                if !free.isEmpty { out.append(.free(part, free)) }
            case .machine:
                var seen: Set<String> = []
                let items = part.channels.flatMap { ch in ch.programs.map { Item(program: $0, res: ch.res) } }
                    .filter { seen.insert($0.id).inserted }
                let lanes = Self.pack(items)
                out.append(.whole(part, Array(lanes.prefix(Self.machineLanes)),
                                  hidden: lanes.dropFirst(Self.machineLanes).reduce(0) { $0 + $1.count }))
            }
            return out
        }
    }

    private func height(_ line: Line) -> CGFloat {
        switch line {
        case .machine: Self.machineHeight
        case .load: Self.loadHeight
        case .channel(let ch): CGFloat(max(1, ch.lanes.count)) * Self.laneHeight + 12
        case .whole(_, let lanes, _): CGFloat(max(1, lanes.count)) * Self.laneHeight + 12
        case .free: Self.freeHeight
        }
    }

    // Each item in the first row where the one before it has ended.
    static func pack(_ items: [Item]) -> [[Item]] {
        var lanes: [[Item]] = []
        for i in items.sorted(by: { $0.program.start < $1.program.start }) {
            if let k = lanes.firstIndex(where: { ($0.last?.program.end ?? .distantPast) <= i.program.start }) {
                lanes[k].append(i)
            } else {
                lanes.append([i])
            }
        }
        return lanes
    }

    // MARK: the guide

    private func guide(_ parts: [Part], now: Date) -> some View {
        let start = now.addingTimeInterval(-Self.before)
        let span = Self.before + Self.after
        let width = CGFloat(span / 60) * Self.perMinute
        let lines = self.lines(parts)
        return ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: Space.l) {
                header(parts)
                HStack(alignment: .top, spacing: 0) {
                    VStack(spacing: 0) {
                        Color.clear.frame(height: 30)
                        ForEach(lines) { line in
                            label(line, now: now).frame(height: height(line))
                        }
                    }
                    .frame(width: Self.channelWidth)
                    ScrollView(.horizontal) {
                        VStack(alignment: .leading, spacing: 0) {
                            axis(start: start, span: span, now: now)
                                .frame(width: width, height: 30)
                            ForEach(lines) { line in
                                row(line, start: start, span: span, now: now)
                                    .frame(width: width, height: height(line))
                            }
                        }
                        .overlay(alignment: .topLeading) {
                            // One line for now, down through every machine and channel.
                            Rectangle()
                                .fill(Palette.accent)
                                .frame(width: 2)
                                .padding(.top, 22)
                                .offset(x: CGFloat(Self.before / 60) * Self.perMinute - 1)
                                .allowsHitTesting(false)
                        }
                        .overlay(alignment: .topLeading) {
                            // Where the pointer is on a load graph, carried down through the work.
                            if let hover {
                                Rectangle()
                                    .fill(Palette.ink.opacity(0.35))
                                    .frame(width: 1)
                                    .padding(.top, 30)
                                    .offset(x: CGFloat(hover.at.timeIntervalSince(start) / 60) * Self.perMinute)
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                    // Opens a little before now, so what just finished is in view.
                    .defaultScrollAnchor(UnitPoint(x: (Self.before - 25 * 60) / span, y: 0))
                    .scrollIndicators(.visible)
                }
                .card()
            }
            // The panel's padding, as every other screen.
            .padding(.horizontal, 44)
            .padding(.top, Space.xl)
            .padding(.bottom, 72)
        }
    }

    private func header(_ parts: [Part]) -> some View {
        let programs = parts.flatMap(\.channels).flatMap(\.programs)
        let on = programs.filter { $0.kind == .running }.count
        let next = programs.filter { $0.kind == .next }.count
        let aired = programs.filter { $0.kind == .past }.reduce(0) { $0 + $1.runs }
        let busy = parts.flatMap(\.channels).filter { !$0.programs.isEmpty }
        return VStack(alignment: .leading, spacing: Space.m) {
            PageHead(title: "Schedule", summary: busy.isEmpty ? "Nothing ran in the last two hours and nothing is waiting."
                     : "What ran in the last two hours, what's on now, and what's waiting. Click a job to change it.")
            HStack(spacing: Space.s) {
                Pill("\(on) on now", tone: on > 0 ? .hot : .plain)
                Pill("\(next) coming up", tone: next > 0 ? .next : .plain)
                Pill("\(aired) ran in the last 2 hours", tone: .faint)
            }
            // The key: which color is which.
            if mode == .machine {
                Flow(spacing: Space.m) {
                    ForEach(Dictionary(grouping: busy, by: \.res).keys.sorted(), id: \.self) { res in
                        HStack(spacing: 6) {
                            ResDot(res: res)
                            Text(res == "files" ? "File locks" : Plain.name(res))
                                .font(Typeface.small.weight(.medium))
                                .foregroundStyle(Palette.ink2)
                        }
                    }
                }
            }
        }
    }

    // Quarter hours on the clock, the hours in ink, "Now" in red.
    private func axis(start: Date, span: TimeInterval, now: Date) -> some View {
        OnClock {
            ForEach(Self.quarters(from: start, span: span), id: \.self) { q in
                let hour = Calendar.current.component(.minute, from: q) == 0
                Text(Format.clock(q))
                    .font(Typeface.sized(11, hour ? .semibold : .regular).monospacedDigit())
                    .foregroundStyle(hour ? Palette.ink : Palette.ink3)
                    .fixedSize()
                    .opacity(abs(q.timeIntervalSince(now)) < 300 ? 0 : 1)
                    .layoutValue(key: OnClock.At.self, value: share(q, start, span) ... share(q, start, span))
            }
            Text("Now")
                .font(Typeface.sized(11, .bold))
                .foregroundStyle(Palette.onAccent)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Palette.accent, in: Capsule())
                .fixedSize()
                .layoutValue(key: OnClock.At.self, value: share(now, start, span) ... share(now, start, span))
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }

    // MARK: the names column

    @ViewBuilder
    private func label(_ line: Line, now: Date) -> some View {
        switch line {
        case .machine(let part):
            HStack(spacing: Space.s) {
                Image(systemName: part.machine == store.hostName ? "desktopcomputer" : "server.rack")
                    .foregroundStyle(Palette.ink2)
                Text(part.title)
                    .font(Typeface.title)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.m)
            .frame(maxHeight: .infinity)
            .background(Palette.sunken.opacity(0.7))
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
        case .load(let part):
            loadLabel(part)
        case .channel(let ch):
            channelCell(ch)
        case .whole(let part, _, let hidden):
            cell {
                Text("All work").font(Typeface.headline).foregroundStyle(Palette.ink)
                let on = part.channels.flatMap(\.programs).filter { $0.kind == .running }.count
                Text(on == 0 ? "Nothing on now" : "\(on) on now").font(Typeface.small).foregroundStyle(Palette.ink2)
                if hidden > 0 {
                    Text("+\(hidden) more").font(Typeface.small.weight(.semibold)).foregroundStyle(Palette.ink3)
                }
            }
        case .free(_, let names):
            cell {
                Text("Free").font(Typeface.headline).foregroundStyle(Palette.ink3)
                Text(names.joined(separator: ", ")).font(Typeface.small).foregroundStyle(Palette.ink3).lineLimit(2)
            }
        }
    }

    // The load at the pointer, or now: the number, and the limit dibs works to.
    private func loadLabel(_ part: Part) -> some View {
        let at = hover?.machine == part.machine ? hover?.at : nil
        let value = at.flatMap { LoadChart.nearest(part.load, $0)?.load } ?? part.loadNow
        let over = (value ?? 0) > (part.ceiling ?? .infinity)
        return cell {
            Text(at.map { "Load at \(Format.clock($0))" } ?? "Load now")
                .font(Typeface.small)
                .foregroundStyle(Palette.ink3)
            Text(value.map { String(format: "%.1f", $0) } ?? "Unknown")
                .font(Typeface.sized(22, .bold).monospacedDigit())
                .foregroundStyle(over ? Palette.accentInk : Palette.ink)
                .contentTransition(.numericText())
            if let ceiling = part.ceiling {
                Text(over ? String(format: "over its limit of %.0f", ceiling) : String(format: "limit %.0f", ceiling))
                    .font(Typeface.small)
                    .foregroundStyle(over ? Palette.accentInk : Palette.ink3)
            }
        }
    }

    private func cell<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 2) { content() }
            .padding(.leading, Space.m + 8)
            .padding(.top, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
    }

    private func channelCell(_ ch: Channel) -> some View {
        let selected = pick == .channel(ch.id)
        return Button { pick = selected ? nil : .channel(ch.id) } label: {
            HStack(spacing: Space.m) {
                ResDot(res: ch.res)
                VStack(alignment: .leading, spacing: 3) {
                    Text(ch.name)
                        .font(Typeface.headline)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Text(ch.status)
                        .font(Typeface.small)
                        .foregroundStyle(ch.busy ? Palette.ink2 : Palette.ink3)
                        .lineLimit(1)
                    if ch.hidden > 0 {
                        Text("+\(ch.hidden) more")
                            .font(Typeface.small.weight(.semibold))
                            .foregroundStyle(Palette.ink3)
                    }
                }
                .padding(.top, 12)
                .frame(maxHeight: .infinity, alignment: .top)
                Spacer(minLength: 0)
            }
            .padding(.leading, Space.m)
            .frame(maxHeight: .infinity)
            .background(selected ? Palette.accentWash : .clear)
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            .overlay(alignment: .trailing) { Rectangle().fill(Palette.hairline).frame(width: 1) }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .help("See \(ch.name)'s day")
    }

    // MARK: the timeline

    @ViewBuilder
    private func row(_ line: Line, start: Date, span: TimeInterval, now: Date) -> some View {
        switch line {
        case .machine:
            Palette.sunken.opacity(0.7)
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        case .load(let part):
            LoadChart(points: part.load, start: start, end: start.addingTimeInterval(span), ceiling: part.ceiling,
                      onHover: { at in hover = at.map { (part.machine, $0) } })
                .padding(.vertical, 6)
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        case .channel(let ch):
            lanes((ch.lanes.isEmpty ? [[]] : ch.lanes).map { $0.map { Item(program: $0, res: ch.res) } }, start: start, span: span, now: now)
        case .whole(_, let lanes, _):
            self.lanes(lanes.isEmpty ? [[]] : lanes, start: start, span: span, now: now)
        case .free:
            Color.clear.overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        }
    }

    private func lanes(_ lanes: [[Item]], start: Date, span: TimeInterval, now: Date) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(lanes.enumerated()), id: \.offset) { _, lane in
                OnClock {
                    ForEach(Self.quarters(from: start, span: span), id: \.self) { q in
                        let hour = Calendar.current.component(.minute, from: q) == 0
                        Rectangle().fill(Palette.hairline.opacity(hour ? 1 : 0.5)).frame(width: 1)
                            .layoutValue(key: OnClock.At.self, value: share(q, start, span) ... share(q, start, span))
                    }
                    ForEach(lane) { item in
                        let p = item.program
                        Button { pick = pick == .program(p.id) ? nil : .program(p.id) } label: {
                            program(p, res: item.res, selected: pick == .program(p.id), now: now)
                        }
                        .buttonStyle(.plain)
                        .layoutValue(key: OnClock.At.self, value: share(p.start, start, span) ... max(share(p.end, start, span), share(p.start, start, span) + 0.004))
                    }
                }
                .frame(height: Self.laneHeight)
            }
        }
        .padding(.vertical, 6)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }
    // A program: who and a line under it. On now is solid, coming up is a
    // wash with a dashed edge when its length is a guess, already ran is grey.
    @ViewBuilder
    private func program(_ p: Program, res: String, selected: Bool, now: Date) -> some View {
        if p.kind == .past && p.runs == 1 && p.end.timeIntervalSince(p.start) < Channel.tickUnder {
            Rectangle()
                .fill(p.failed > 0 ? Palette.accent : Tint.ink(res).opacity(0.6))
                .frame(width: 2, height: Self.laneHeight - 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
                .help(tip(p, now: now))
        } else {
            bar(p, res: res, selected: selected, now: now)
        }
    }

    // Who, which job, what, when, how long and how it ended or where it waits: on hover.
    private func tip(_ p: Program, now: Date) -> String {
        let job = p.row?.leaseID ?? Int(p.id.replacingOccurrences(of: "past-", with: ""))
        let head = "\(store.displayName(p.who)) (\(p.who))\(job.map { ", #\($0)" } ?? "")\(p.what.isEmpty ? "" : ": \(p.what)")"
        let when = "\(Format.clock(p.start)) to \(Format.clock(p.end)), \(Span.of(p.end.timeIntervalSince(p.start)))"
        return [head, when, p.line(now: now)].filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private func bar(_ p: Program, res: String, selected: Bool, now: Date) -> some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        let fill: Color = switch p.kind {
        case .running: p.paused ? Palette.sunken : Tint.of(res)
        case .next: Tint.wash(res)
        // What already ran: a light tint of the channel, a step back from what's on.
        case .past: Tint.of(res).opacity(0.18)
        }
        let ink: Color = switch p.kind {
        case .running: p.paused ? Palette.ink2 : Tint.on(res)
        case .next: Tint.ink(res)
        case .past: Tint.ink(res).opacity(0.85)
        }
        return ViewThatFits(in: .horizontal) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    if p.kind == .past, p.failed > 0 {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.accent)
                    }
                    Text(store.displayName(p.who)).font(Typeface.sized(12, .semibold))
                }
                Text(p.line(now: now)).font(Typeface.sized(10.5)).opacity(0.85)
            }
            .lineLimit(1)
            .fixedSize()
            Text(store.displayName(p.who)).font(Typeface.sized(12, .semibold)).lineLimit(1).fixedSize()
            // What's still worth reading when the name won't fit: the run count, or the session's short suffix ("0b").
            Text(p.runs > 1 ? "\(p.runs) runs\(p.failed > 0 ? ", \(p.failed) failed" : "")" : AgentLabel.handle(p.who))
                .font(Typeface.sized(12, .semibold)).lineLimit(1).fixedSize()
            if p.runs > 1 { Text("\u{00D7}\(p.runs)").font(Typeface.sized(12, .semibold)).lineLimit(1).fixedSize() }
            Color.clear.frame(width: 0, height: 0)
        }
        .foregroundStyle(ink)
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: Self.laneHeight - 8, alignment: .leading)
        .background(fill, in: shape)
        .overlay {
            if selected {
                shape.strokeBorder(Palette.ink, lineWidth: 2)
            } else if p.kind == .next && !p.known {
                shape.strokeBorder(Tint.of(res).opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
            }
        }
        .padding(.horizontal, 1.5)
        .contentShape(shape)
        .help(tip(p, now: now))
    }

    private func share(_ date: Date, _ start: Date, _ span: TimeInterval) -> Double {
        min(1, max(0, date.timeIntervalSince(start) / span))
    }

    static func quarters(from start: Date, span: TimeInterval) -> [Date] {
        let q = 900.0
        let first = (start.timeIntervalSince1970 / q).rounded(.up) * q
        return stride(from: first, to: start.timeIntervalSince1970 + span, by: q).map { Date(timeIntervalSince1970: $0) }
    }

    // MARK: the panel

    @ViewBuilder
    private func panel(_ pick: Pick, channels: [Channel], now: Date) -> some View {
        Group {
            switch pick {
            case .channel(let id):
                if let ch = channels.first(where: { $0.id == id }) {
                    ChannelPanel(channel: ch, history: store.today, now: now, onPick: { self.pick = .program($0) }, onClose: { self.pick = nil })
                }
            case .program(let id):
                if let (p, ch) = Self.find(id, in: channels) {
                    if let row = p.row {
                        // A job on this Mac can be changed here, as on the web page's schedule; another machine's only on its own.
                        RowInspector(row: row, line: ch.res == "files" ? (row.res.first ?? "files") : ch.res,
                                     canAct: store.ownerActions && ch.machine == store.hostName,
                                     onConfirm: { pending = $0 }, onClose: { self.pick = nil })
                    } else {
                        PastPanel(program: p, channel: ch, history: store.today, onClose: { self.pick = nil })
                    }
                }
            }
        }
        .frame(width: 340)
        .background(Palette.surface)
        .transition(.move(edge: .trailing).combined(with: .opacity))
    }

    static func find(_ id: String, in channels: [Channel]) -> (Program, Channel)? {
        for ch in channels {
            if let p = ch.programs.first(where: { $0.id == id }) { return (p, ch) }
        }
        return nil
    }
}

// One program on the guide: a run that already ended, one on now, or one
// coming up.
struct Program: Identifiable {
    enum Kind { case past, running, next }

    var id: String
    var kind: Kind
    var who: String
    var what: String
    var start: Date
    var end: Date
    // Whether the end is known: a forecast or a finished run, not a guess.
    var known: Bool
    var paused = false
    var code: Int?
    // Back-to-back runs by one agent shown as one program: how many, how many failed.
    var runs = 1
    var failed = 0
    // The live row, for programs on now or coming up.
    var row: Row?

    func line(now: Date) -> String {
        switch kind {
        case .past:
            let took = Span.of(end.timeIntervalSince(start))
            if runs > 1 { return failed > 0 ? "\(runs) runs, \(failed) failed" : "\(runs) runs, \(took)" }
            return code.map { $0 == 0 ? "Passed, \(took)" : "Failed, \(took)" } ?? "Held \(took)"
        case .running:
            return paused ? "Paused" : row?.left(at: now) ?? ""
        case .next:
            return what.isEmpty ? row?.starts(at: now) ?? "" : what
        }
    }
}

// A channel: one resource (or every file lock together), its programs, and
// how they stack when several run at once.
struct Channel: Identifiable {
    var machine = ""
    var res: String
    var name: String
    var programs: [Program]
    var lanes: [[Program]]
    // Programs that didn't fit in the rows shown; the channel's panel has them all.
    var hidden = 0
    var counter: Counter?
    var id: String { "\(machine)/\(res)" }

    var busy: Bool { programs.contains { $0.kind == .running } }

    var status: String {
        let on = programs.filter { $0.kind == .running }.count
        let waiting = counter?.waiting.count ?? 0
        if res == "files" && on > 0 {
            let held = counter.map { Set($0.serving.flatMap { $0.res.filter { $0.hasPrefix("files:") } }).count } ?? 0
            return "\(on) agents, \(held) files" + (waiting > 0 ? ", \(waiting) waiting" : "")
        }
        if on == 0 && waiting == 0 { return "Free" }
        var parts: [String] = []
        if on > 0 { parts.append("\(on) on now") }
        if waiting > 0 { parts.append("\(waiting) waiting") }
        return parts.joined(separator: ", ")
    }

    // A turn of unknown length is drawn this long.
    static let unknownTurn: TimeInterval = 12 * 60

    static func all(counters: [Counter], history: History?, machine: String = "", now: Date) -> [Channel] {
        let past = pastRuns(history, now: now)
        var out: [Channel] = counters.queues.map { c in
            make(res: c.res, name: c.shortName, counters: [c], past: past.filter { $0.res.contains(c.res) }, now: now)
        }
        let files = counters.fileLocks
        let filePast = past.filter { $0.res.contains { $0.hasPrefix("files:") } }
        if !files.isEmpty || !filePast.isEmpty {
            out.append(make(res: "files", name: "File locks", counters: files, past: filePast, now: now))
        }
        for i in out.indices { out[i].machine = machine }
        // Busy channels first, then the ones that ran something, then the rest.
        return out.sorted { a, b in
            let ra = a.busy ? 0 : a.programs.isEmpty ? 2 : 1
            let rb = b.busy ? 0 : b.programs.isEmpty ? 2 : 1
            return ra != rb ? ra < rb : a.name < b.name
        }
    }

    private static func make(res: String, name: String, counters: [Counter], past: [PastRun], now: Date) -> Channel {
        var programs: [Program] = sittings(past)
        var seen: Set<String> = []
        // Each file is its own lease line, so one agent holding thirty files
        // would be thirty programs: on the file locks channel, one per agent.
        if res == "files" {
            for (who, rows) in Dictionary(grouping: FileLocks.unique(counters.flatMap(\.serving)), by: \.who) {
                let files = Set(rows.flatMap { $0.res.filter { $0.hasPrefix("files:") } }).count
                let ends = rows.compactMap(\.endsAt)
                programs.append(Program(id: "files-\(who)", kind: .running, who: who, what: files == 1 ? "1 file" : "\(files) files",
                                        start: rows.map(\.since).min() ?? now,
                                        end: max(ends.max() ?? now.addingTimeInterval(unknownTurn), now.addingTimeInterval(60)),
                                        known: ends.count == rows.count, row: rows[0]))
                rows.forEach { seen.insert($0.id) }
            }
        }
        for c in counters {
            for r in c.serving where seen.insert(r.id).inserted {
                let end = r.pausedText == nil ? r.endsAt : nil
                programs.append(Program(id: r.id, kind: .running, who: r.who, what: r.purpose, start: r.since,
                                        end: max(end ?? now.addingTimeInterval(unknownTurn), now.addingTimeInterval(60)),
                                        known: end != nil, paused: r.pausedText != nil, row: r))
            }
            let timed = c.waiting.compactMap { r in r.startsAt.map { (r, max($0, now)) } }
            for (i, (r, start)) in timed.enumerated() where seen.insert(r.id).inserted {
                let next = i + 1 < timed.count ? timed[i + 1].1 : nil
                programs.append(Program(id: r.id, kind: .next, who: r.who, what: r.purpose, start: start,
                                        end: next.map { max($0, start.addingTimeInterval(60)) } ?? start.addingTimeInterval(unknownTurn),
                                        known: next != nil, row: r))
            }
        }
        let c = counters.count == 1 ? counters.first : nil
        let merged = c ?? (counters.isEmpty ? nil : Counter(res: res, name: name, serving: counters.flatMap(\.serving),
                                                                waiting: FileLocks.unique(counters.flatMap(\.waiting)), clearsAt: nil, summary: ""))
        let all = lanes(programs)
        return Channel(res: res, name: name, programs: programs, lanes: Array(all.prefix(maxLanes)),
                       hidden: all.dropFirst(maxLanes).reduce(0) { $0 + $1.count }, counter: merged)
    }

    // More rows than this and a channel stops reading as one line of the guide.
    // Four: deploys run one per project at once (0.0.178).
    static let maxLanes = 4
    // Runs by one agent closer together than this read as one sitting: back to
    // back, not two minutes apart, which joined separate tries into one bar.
    static let sitting: TimeInterval = 30
    // A single run shorter than this is a tick, not a pill that reads as a broken bar.
    static let tickUnder: TimeInterval = 60

    // One program per sitting: an agent's runs on a channel with less than
    // 30 seconds between them, so a test loop is one block, not fifty slivers.
    static func sittings(_ runs: [PastRun]) -> [Program] {
        var out: [Program] = []
        for (who, mine) in Dictionary(grouping: runs, by: \.who) {
            var cur: Program?
            for r in mine.sorted(by: { $0.start < $1.start }) {
                let bad = (r.code ?? 0) != 0
                if var c = cur, r.start.timeIntervalSince(c.end) < sitting {
                    c.end = max(c.end, r.end)
                    c.runs += 1
                    c.failed += bad ? 1 : 0
                    cur = c
                } else {
                    if let c = cur { out.append(c) }
                    cur = Program(id: "past-\(r.id)", kind: .past, who: who, what: "", start: r.start, end: r.end, known: true,
                                  code: r.code, failed: bad ? 1 : 0)
                }
            }
            if let c = cur { out.append(c) }
        }
        return out
    }

    // Each program goes in the first row where the one before it has ended.
    static func lanes(_ programs: [Program]) -> [[Program]] {
        var lanes: [[Program]] = []
        for p in programs.sorted(by: { $0.start < $1.start }) {
            if let i = lanes.firstIndex(where: { ($0.last?.end ?? .distantPast) <= p.start }) {
                lanes[i].append(p)
            } else {
                lanes.append([p])
            }
        }
        return lanes
    }

    struct PastRun {
        var id: Int
        var res: [String]
        var who: String
        var start: Date
        var end: Date
        var code: Int?
    }

    // Finished runs in the guide's window: each end, matched to its start
    // (or worked back from how long it held).
    static func pastRuns(_ history: History?, now: Date) -> [PastRun] {
        guard let events = history?.events else { return [] }
        let from = now.addingTimeInterval(-ScheduleView.before)
        var starts: [Int: Double] = [:]
        for e in events where e.kind == "start" { if let id = e.id { starts[id] = e.at } }
        return events.compactMap { e in
            guard e.kind == "end", let id = e.id, let res = e.res else { return nil }
            let end = Date(ms: e.at)
            let start = starts[id].map(Date.init(ms:)) ?? end.addingTimeInterval(-(e.ms ?? 0) / 1000)
            guard end > from else { return nil }
            return PastRun(id: id, res: res, who: e.who ?? "someone", start: start, end: end, code: e.code)
        }
    }
}

// A channel's day: what's on, what's waiting, today's numbers, when it was
// busy, and who used it most.
struct ChannelPanel: View {
    let channel: Channel
    let history: History?
    let now: Date
    let onPick: (String) -> Void
    let onClose: () -> Void

    var body: some View {
        let today = Self.runs(channel.res, history)
        let stats = Self.stats(channel.res, history)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack(spacing: Space.s) {
                        ResDot(res: channel.res, size: 10)
                        Text("Channel")
                            .font(Typeface.small)
                            .foregroundStyle(Palette.ink3)
                    }
                    Text(channel.name)
                        .font(Typeface.sized(22, .bold))
                        .foregroundStyle(Palette.ink)
                    Text(channel.status)
                        .foregroundStyle(Palette.ink2)
                }
                .padding(Space.l + 2)
                .padding(.trailing, 28)

                section("Past day") {
                    Grid(alignment: .leading, horizontalSpacing: Space.l, verticalSpacing: Space.m) {
                        GridRow {
                            figure("\(today.count)", "runs")
                            figure(Span.of(today.reduce(0) { $0 + $1.end.timeIntervalSince($1.start) }), "in use")
                        }
                        GridRow {
                            figure(stats.map { "\($0.waits)" } ?? "0", "waits")
                            figure(stats?.p50WaitMs.map { Span.of($0 / 1000) } ?? "none", "typical wait")
                        }
                        GridRow {
                            figure("\(today.filter { ($0.code ?? 0) != 0 }.count)", "failed", hot: today.contains { ($0.code ?? 0) != 0 })
                            figure(stats?.peakQueue.map { "\($0)" } ?? "0", "longest line")
                        }
                    }
                }

                if !today.isEmpty {
                    section("When it was busy") {
                        Chart {
                            ForEach(Self.byHour(today, now: now), id: \.hour) { h in
                                BarMark(x: .value("Hour", h.hour, unit: .hour), y: .value("Minutes", h.minutes))
                                    .foregroundStyle(Tint.of(channel.res))
                                    .clipShape(.rect(cornerRadius: 3))
                            }
                        }
                        .chartXAxis {
                            AxisMarks(values: .stride(by: .hour, count: 6)) { _ in
                                AxisValueLabel(format: .dateTime.hour()).font(Typeface.axis).foregroundStyle(Palette.ink3)
                            }
                        }
                        .chartYAxis {
                            AxisMarks(position: .trailing, values: .automatic(desiredCount: 2)) { v in
                                AxisGridLine().foregroundStyle(Palette.hairline)
                                AxisValueLabel { if let m = v.as(Double.self) { Text("\(Int(m))m") } }.font(Typeface.axis).foregroundStyle(Palette.ink3)
                            }
                        }
                        .frame(height: 110)
                    }

                    section("Who used it most") {
                        let users = Self.users(today)
                        let top = users.first?.time ?? 1
                        ForEach(users.prefix(6), id: \.who) { u in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    AgentLabel(who: u.who)
                                    Spacer()
                                    Text("\(u.runs) runs, \(Span.of(u.time))")
                                        .font(Typeface.small).foregroundStyle(Palette.ink3)
                                }
                                Bar(fill: u.time / top, color: Tint.of(channel.res))
                            }
                        }
                    }
                }

                let live = channel.programs.filter { $0.kind != .past }.sorted { $0.start < $1.start }
                if !live.isEmpty {
                    section("On now and next") {
                        ForEach(live) { p in
                            Button { onPick(p.id) } label: {
                                HStack(spacing: Space.m) {
                                    Pill(p.kind == .running ? "Now" : "Next", tone: p.kind == .running ? .hot : .next)
                                    VStack(alignment: .leading, spacing: 1) {
                                        AgentLabel(who: p.who)
                                        if !p.what.isEmpty {
                                            Text(p.what).font(Typeface.small).foregroundStyle(Palette.ink3).lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right").font(Typeface.chevron).foregroundStyle(Palette.ink3)
                                }
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .frame(width: 340)
        }
        .overlay(alignment: .topTrailing) { CloseButton(action: onClose) }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text(title).font(Typeface.title).foregroundStyle(Palette.ink)
            content()
        }
        .padding(Space.l + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }

    private func figure(_ value: String, _ label: String, hot: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(Typeface.sized(20, .bold).monospacedDigit())
                .foregroundStyle(hot ? Palette.accentInk : Palette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(label).font(Typeface.small).foregroundStyle(Palette.ink3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // Every finished run on this channel in the past day.
    static func runs(_ res: String, _ history: History?) -> [Channel.PastRun] {
        guard let history else { return [] }
        let all = Channel.pastRuns(history, now: Date(ms: history.until).addingTimeInterval(ScheduleView.before - 24 * 3600))
        return all.filter { run in run.res.contains { res == "files" ? $0.hasPrefix("files:") : $0 == res } }
    }

    static func stats(_ res: String, _ history: History?) -> History.Resource? {
        guard let history else { return nil }
        if res != "files" { return history.resources[res] }
        let files = history.resources.filter { $0.key.hasPrefix("files:") }.map(\.value)
        guard !files.isEmpty else { return nil }
        return History.Resource(busyMs: files.reduce(0) { $0 + $1.busyMs }, waits: files.reduce(0) { $0 + $1.waits },
                                waitMs: files.reduce(0) { $0 + $1.waitMs }, p50WaitMs: nil, p90WaitMs: nil,
                                peakQueue: files.compactMap(\.peakQueue).max(), timeouts: nil)
    }

    // Minutes in use in each hour of the past day.
    static func byHour(_ runs: [Channel.PastRun], now: Date) -> [(hour: Date, minutes: Double)] {
        let cal = Calendar.current
        guard let thisHour = cal.dateInterval(of: .hour, for: now)?.start else { return [] }
        return (0..<24).reversed().map { back in
            let h = thisHour.addingTimeInterval(-Double(back) * 3600)
            let end = h.addingTimeInterval(3600)
            let secs = runs.reduce(0.0) { sum, r in sum + max(0, min(r.end, end).timeIntervalSince(max(r.start, h))) }
            return (h, secs / 60)
        }
    }

    static func users(_ runs: [Channel.PastRun]) -> [(who: String, runs: Int, time: TimeInterval)] {
        var by: [String: (Int, TimeInterval)] = [:]
        for r in runs { by[r.who, default: (0, 0)].0 += 1; by[r.who, default: (0, 0)].1 += r.end.timeIntervalSince(r.start) }
        return by.map { ($0.key, $0.value.0, $0.value.1) }.sorted { $0.time > $1.time }
    }
}

// A run that already ended: when, how long, how it went, and the agent's
// other runs that day.
struct PastPanel: View {
    @Environment(Store.self) private var store
    let program: Program
    let channel: Channel
    let history: History?
    let onClose: () -> Void

    var body: some View {
        let others = ChannelPanel.runs(channel.res, history).filter { $0.who == program.who }.sorted { $0.end > $1.end }
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("Ran \(Format.clock(program.start)) to \(Format.clock(program.end))")
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                    Text(store.displayName(program.who))
                        .font(Typeface.sized(22, .bold))
                        .foregroundStyle(Palette.ink)
                    if store.displayName(program.who) != program.who {
                        Text("Claude \u{00B7} \(program.who)").font(Typeface.small).foregroundStyle(Palette.ink3)
                    }
                    HStack(spacing: Space.s) {
                        ResPill(res: channel.res)
                        if let code = program.code {
                            Pill(code == 0 ? "Passed" : "Failed, code \(code)", tone: code == 0 ? .plain : .hot)
                        } else {
                            Pill("Held, then given back", tone: .faint)
                        }
                    }
                }
                .padding(Space.l + 2)
                .padding(.trailing, 28)

                VStack(alignment: .leading, spacing: Space.m) {
                    fact("Took", Span.of(program.end.timeIntervalSince(program.start)))
                    fact("Started", Format.clock(program.start))
                    fact("Ended", Format.clock(program.end))
                }
                .padding(Space.l + 2)
                .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }

                if others.count > 1 {
                    VStack(alignment: .leading, spacing: Space.m) {
                        Text("Its runs on \(channel.name), past day")
                            .font(Typeface.title)
                            .foregroundStyle(Palette.ink)
                        ForEach(Array(others.prefix(12).enumerated()), id: \.offset) { _, r in
                            HStack {
                                Text(Format.clock(r.end)).font(Typeface.time).foregroundStyle(Palette.ink2)
                                Spacer()
                                Text(Span.of(r.end.timeIntervalSince(r.start))).font(Typeface.small).foregroundStyle(Palette.ink3)
                                Image(systemName: (r.code ?? 0) == 0 ? "checkmark.circle.fill" : "xmark.circle.fill")
                                    .foregroundStyle((r.code ?? 0) == 0 ? Palette.working : Palette.accent)
                            }
                        }
                    }
                    .padding(Space.l + 2)
                    .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
                }
            }
            .frame(width: 340)
        }
        .overlay(alignment: .topTrailing) { CloseButton(action: onClose) }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(Palette.ink3).frame(width: 90, alignment: .leading)
            Text(value).foregroundStyle(Palette.ink).monospacedDigit()
        }
    }
}

struct CloseButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(Typeface.sized(10, .bold))
                .foregroundStyle(Palette.ink2)
                .frame(width: 22, height: 22)
                .background(Palette.ink.opacity(0.07), in: Circle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.cancelAction)
        .help("Close")
        .padding(Space.m)
    }
}

// A machine's load across the guide's window: the shape filled red to green
// by height, its limit as a dashed line, and a readout under the pointer.
struct LoadChart: View {
    let points: [LoadLog.Point]
    let start: Date
    let end: Date
    let ceiling: Double?
    let onHover: (Date?) -> Void
    @State private var at: Date?

    var body: some View {
        let shown = points.filter { $0.at >= start.addingTimeInterval(-1800) && $0.at <= end }
        let top = max((ceiling ?? 1) * 1.35, (shown.map(\.load).max() ?? 1) * 1.1)
        Chart {
            ForEach(shown, id: \.at) { p in
                AreaMark(x: .value("Time", p.at), y: .value("Load", p.load))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(LinearGradient(colors: [Palette.accent.opacity(0.55), Palette.yellow.opacity(0.4), Palette.working.opacity(0.25)],
                                                    startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Time", p.at), y: .value("Load", p.load))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(Palette.ink2)
                    .lineStyle(StrokeStyle(lineWidth: 1.2))
            }
            if let ceiling {
                RuleMark(y: .value("Limit", ceiling))
                    .foregroundStyle(Palette.accent.opacity(0.7))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
            }
            if let at, let p = Self.nearest(shown, at) {
                PointMark(x: .value("Time", p.at), y: .value("Load", p.load))
                    .foregroundStyle(Palette.ink)
                    .symbolSize(30)
            }
        }
        .chartXScale(domain: start ... end)
        .chartYScale(domain: 0 ... top)
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartOverlay { proxy in
            Rectangle().fill(.clear).contentShape(.rect)
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let loc):
                        at = proxy.value(atX: loc.x, as: Date.self)
                    case .ended:
                        at = nil
                    }
                    onHover(at)
                }
        }
        .overlay {
            if shown.isEmpty {
                Text("The load shows here once the app has been open a little while.")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
            }
        }
    }

    static func nearest(_ points: [LoadLog.Point], _ at: Date) -> LoadLog.Point? {
        points.min { abs($0.at.timeIntervalSince(at)) < abs($1.at.timeIntervalSince(at)) }
    }
}
