import SwiftUI

// The next hour as a timetable: one track per busy queue, with who has it now
// and who goes after, as blocks on a clock running left to right from now.
// Turns dibs can't time yet fade out at their end instead of stopping.
struct ComingUp: View {
    @Environment(Store.self) private var store
    let counters: [Counter]
    var open: (String) -> Void = { _ in }
    // Narrow cards put each queue's name over its track, so the track keeps
    // enough width for names to fit in the blocks.
    @State private var stacked = false
    nonisolated private static let stackBelow: CGFloat = 600

    // An hour is as far ahead as the forecasts are worth reading.
    static let window: TimeInterval = 3600
    // A turn with no known length is drawn this long, fading.
    static let unknownTurn: TimeInterval = 12 * 60
    static let labelWidth: CGFloat = 132

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let now = context.date
            VStack(alignment: .leading, spacing: Space.m) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Coming up")
                            .font(Typeface.title)
                            .foregroundStyle(Palette.ink)
                        Text("Who has each queue and who's next, over the next hour")
                            .font(Typeface.small)
                            .foregroundStyle(Palette.ink3)
                    }
                    Spacer()
                    OpenSchedule()
                }
                VStack(spacing: Space.s) {
                    axis(now)
                    ForEach(counters) { c in
                        Button { open(c.res) } label: { track(c, now: now) }
                            .buttonStyle(.plain)
                    }
                }
                // One line for now, down through every track, in place of a
                // mark on each.
                .overlay(alignment: .topLeading) {
                    if !stacked {
                        Rectangle()
                            .fill(Palette.accent)
                            .frame(width: 1.5)
                            .padding(.top, 18)
                            .offset(x: Self.labelWidth + Space.m)
                    }
                }
            }
            .padding(Space.l + 2)
            .card(12)
            .onGeometryChange(for: Bool.self) { $0.size.width < Self.stackBelow } action: { stacked = $0 }
        }
    }

    // "Now" at the left edge, then each quarter hour on the clock (4:30,
    // 4:45) where it falls.
    private func axis(_ now: Date) -> some View {
        HStack(spacing: Space.m) {
            if !stacked { Color.clear.frame(width: Self.labelWidth, height: 1) }
            OnClock {
                Text("Now")
                    .font(Typeface.sized(10.5, .semibold))
                    .foregroundStyle(Palette.accentInk)
                    .fixedSize()
                    .layoutValue(key: OnClock.At.self, value: 0 ... 0)
                ForEach(Self.quarters(now), id: \.self) { q in
                    let at = Self.share(q, now)
                    Text(Format.clock(q))
                        .font(Typeface.sized(10.5).monospacedDigit())
                        .foregroundStyle(Palette.ink3)
                        .fixedSize()
                        // Too close to "Now" to read; its rule still shows.
                        .opacity(at < 0.08 ? 0 : 1)
                        .layoutValue(key: OnClock.At.self, value: at ... at)
                }
            }
            .frame(height: 14)
        }
    }

    // The quarter hours inside the window.
    static func quarters(_ now: Date) -> [Date] {
        let q = 900.0
        let first = (now.timeIntervalSince1970 / q).rounded(.up) * q
        return stride(from: first, to: now.timeIntervalSince1970 + window, by: q).map { Date(timeIntervalSince1970: $0) }
    }

    private func track(_ c: Counter, now: Date) -> some View {
        let label = HStack(spacing: Space.s) {
            ResDot(res: c.res)
            Text(c.shortName)
                .font(Typeface.headline)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .truncationMode(.middle)
            // Over a full-width track there's room to name who's on and who's next.
            if stacked {
                Text([c.serving.first.map { "\(store.displayName($0.who)) now" }, c.waiting.first.map { "\(store.displayName($0.who)) next" }]
                    .compactMap { $0 }.joined(separator: ", "))
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
            }
        }
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: Space.m))
        return layout {
            label
                .frame(width: stacked ? nil : Self.labelWidth, alignment: .leading)
                .padding(.top, stacked ? Space.xs : 0)
            // Turns that overlap (a queue with room for several at once) each
            // get their own row inside the track, so none hides another.
            let lanes = Self.lanes(Self.turns(c, now: now))
            VStack(spacing: 3) {
                ForEach(Array(lanes.enumerated()), id: \.offset) { i, lane in
                    OnClock {
                        // Quarter-hour rules behind the blocks.
                        ForEach(Self.quarters(now), id: \.self) { q in
                            Rectangle().fill(Palette.hairline).frame(width: 1)
                                .layoutValue(key: OnClock.At.self, value: Self.share(q, now) ... Self.share(q, now))
                        }
                        // A line with no forecast: say who's waiting and that it's later.
                        if lane.isEmpty, let first = c.waiting.first {
                            Text("\(store.displayName(first.who)) is next, \(first.startsPhrase(at: now))")
                                .font(Typeface.small)
                                .foregroundStyle(Palette.ink3)
                                .lineLimit(1)
                                .padding(.leading, Space.m)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .layoutValue(key: OnClock.At.self, value: 0 ... 1)
                        }
                        ForEach(lane) { turn in
                            block(turn, res: c.res)
                                .layoutValue(key: OnClock.At.self, value: Self.share(turn.start, now) ... Self.share(turn.end, now))
                        }
                    }
                    .frame(height: 26)
                }
            }
            .padding(.vertical, 2)
            .background(Palette.sunken.opacity(0.7), in: .rect(cornerRadius: 9, style: .continuous))
            .clipShape(.rect(cornerRadius: 9, style: .continuous))
        }
        .contentShape(.rect)
    }

    // Where a time falls across the hour, from 0 at now to 1.
    static func share(_ date: Date, _ now: Date) -> Double {
        min(1, max(0, date.timeIntervalSince(now) / window))
    }

    // Running: solid color. Up next: a wash of it. A turn whose length dibs
    // doesn't know gets a dashed edge instead of pretending to know when it ends.
    private func block(_ t: Turn, res: String) -> some View {
        let fill = t.paused ? Palette.sunken : t.running ? Tint.of(res) : Tint.wash(res)
        let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
        // The name only when it fits whole; a short turn is just its color.
        return ViewThatFits(in: .horizontal) {
            Text(store.displayName(t.who))
                .font(Typeface.sized(11.5, .semibold))
                .foregroundStyle(t.paused ? Palette.ink2 : t.running ? Tint.on(res) : Tint.ink(res))
                .lineLimit(1)
                .fixedSize()
            Color.clear.frame(width: 0)
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: 24, alignment: .leading)
        .background(fill, in: shape)
        .overlay {
            if !t.known || t.paused {
                shape.strokeBorder(Tint.of(res).opacity(0.7), style: StrokeStyle(lineWidth: 1.2, dash: [4, 3]))
            }
        }
        .padding(.horizontal, 1.5)
        .help("\(store.displayName(t.who))\(t.what.isEmpty ? "" : ": \(t.what)")")
    }

    // Each turn goes in the first row where the one before it has ended.
    // Always at least one row, so an idle queue still has a track.
    static func lanes(_ turns: [Turn]) -> [[Turn]] {
        var lanes: [[Turn]] = []
        for t in turns.sorted(by: { $0.start < $1.start }) {
            if let i = lanes.firstIndex(where: { ($0.last?.end ?? .distantPast) <= t.start }) {
                lanes[i].append(t)
            } else {
                lanes.append([t])
            }
        }
        return lanes.isEmpty ? [[]] : lanes
    }

    struct Turn: Identifiable {
        var id: String
        var who: String
        var what: String
        var start: Date
        var end: Date
        var running: Bool
        var paused: Bool
        var known: Bool
    }

    // Each waiter starts when dibs expects it to, and lasts until the next one
    // is expected; the last one's length isn't known. Waiters with no forecast
    // aren't drawn.
    static func turns(_ c: Counter, now: Date) -> [Turn] {
        var out: [Turn] = c.serving.map { r in
            let end = r.pausedText == nil ? r.endsAt : nil
            return Turn(id: r.id, who: r.who, what: r.purpose, start: now, end: end ?? now.addingTimeInterval(unknownTurn),
                        running: true, paused: r.pausedText != nil, known: end != nil)
        }
        let timed = c.waiting.compactMap { r in r.startsAt.map { (r, max($0, now)) } }
        for (i, (r, start)) in timed.enumerated() {
            let next = i + 1 < timed.count ? timed[i + 1].1 : nil
            out.append(Turn(id: r.id, who: r.who, what: r.purpose, start: start,
                            end: next.map { max($0, start.addingTimeInterval(60)) } ?? start.addingTimeInterval(unknownTurn),
                            running: false, paused: false, known: next != nil))
        }
        return out.filter { $0.start.timeIntervalSince(now) < window }
    }
}

// Lays children along a clock: each gets the share of the width its At range
// covers. A zero-width range places the child at its own size, centered on
// that point and kept inside the edges.
struct OnClock: Layout {
    struct At: LayoutValueKey {
        static let defaultValue: ClosedRange<Double> = 0 ... 1
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: proposal.width ?? 200, height: proposal.height ?? 24)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for v in subviews {
            let at = v[At.self]
            if at.lowerBound == at.upperBound {
                let size = v.sizeThatFits(.unspecified)
                let x = min(bounds.maxX - size.width, max(bounds.minX, bounds.minX + bounds.width * at.lowerBound - size.width / 2))
                v.place(at: CGPoint(x: x, y: bounds.midY - min(size.height, bounds.height) / 2),
                        proposal: ProposedViewSize(width: size.width, height: min(size.height, bounds.height)))
            } else {
                let w = max(4, bounds.width * (at.upperBound - at.lowerBound))
                v.place(at: CGPoint(x: bounds.minX + bounds.width * at.lowerBound, y: bounds.midY), anchor: .leading,
                        proposal: ProposedViewSize(width: w, height: bounds.height))
            }
        }
    }
}

// The last few jobs that finished here: who, on what, how long, and whether
// the command passed. Keeps the screen alive when nothing is in line.
struct JustFinished: View {
    @Environment(Store.self) private var store
    let history: History?
    var limit = 6

    var body: some View {
        // A twin is a second copy of a command dibs refused to start (0.0.86):
        // worth a line, since the agent tried to run the same thing twice.
        let ends = Array((history?.events ?? []).filter { $0.kind == "end" || $0.kind == "twin" }.suffix(limit).reversed())
        if !ends.isEmpty {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(alignment: .leading, spacing: Space.xs) {
                    HStack {
                        Text("Just finished")
                            .font(Typeface.title)
                            .foregroundStyle(Palette.ink)
                        Spacer()
                        ColumnLabel("Took").frame(width: 78, alignment: .trailing)
                        ColumnLabel("Ended").frame(width: 74, alignment: .trailing)
                    }
                    .padding(.horizontal, Space.m)
                    .padding(.bottom, Space.xs)
                    ForEach(Array(ends.enumerated()), id: \.offset) { _, e in
                        let res = e.res ?? []
                        HStack(spacing: Space.m) {
                            Text(name(e))
                                .font(Typeface.headline)
                                .foregroundStyle(Palette.ink)
                                .lineLimit(1)
                                .frame(maxWidth: 150, alignment: .leading)
                            // The first resource; any others are counted.
                            HStack(spacing: 4) {
                                if let first = res.first { ResPill(res: first) }
                                if res.count > 1 { Pill("+\(res.count - 1)", tone: .faint) }
                            }
                            .frame(width: 150, alignment: .leading)
                            .help(res.map(Plain.name).joined(separator: ", "))
                            Group {
                                if e.kind == "twin" {
                                    Pill("Repeat skipped", tone: .faint)
                                        .help("It asked to run a command it was already running, so dibs didn't start the second copy.")
                                } else {
                                    result(e.code)
                                }
                            }
                            .frame(width: 110, alignment: .leading)
                            Spacer(minLength: Space.s)
                            Text(e.ms.map { Span.of($0 / 1000) } ?? "")
                                .font(Typeface.time)
                                .foregroundStyle(Palette.ink2)
                                .lineLimit(1)
                                .frame(width: 78, alignment: .trailing)
                            Text(NeedBody.ago(Date(ms: e.at), now: context.date))
                                .font(Typeface.small)
                                .foregroundStyle(Palette.ink3)
                                .lineLimit(1)
                                .frame(width: 74, alignment: .trailing)
                        }
                        .padding(.horizontal, Space.m)
                        .padding(.vertical, Space.s)
                    }
                }
            }
        }
    }

    // The agent, and which of its subagents when it was one.
    private func name(_ e: History.Event) -> String {
        let who = e.who.map { store.displayName($0) } ?? ""
        return Row.subagent(label: e.label, agentId: e.agentId, who: e.who ?? "", agent: nil).map { "\(who) \u{00B7} \($0)" } ?? who
    }

    // A hold has no command, so no exit code: it was just given back.
    @ViewBuilder
    private func result(_ code: Int?) -> some View {
        if let code {
            HStack(spacing: 4) {
                Image(systemName: code == 0 ? "checkmark" : "xmark")
                    .font(Typeface.sized(9, .black))
                Text(code == 0 ? "Passed" : "Failed")
            }
            .font(Typeface.small.weight(.semibold))
            .foregroundStyle(code == 0 ? Palette.working : Palette.onAccent)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(code == 0 ? Palette.working.opacity(0.14) : Palette.accent, in: Capsule())
            .fixedSize()
            .help(code == 0 ? "The command exited cleanly" : "The command exited with code \(code)")
        }
    }
}

// The way from Home's preview into the full guide.
struct OpenSchedule: View {
    @Environment(Store.self) private var store

    var body: some View {
        Button("Full schedule") { store.section = .schedule }
            .buttonStyle(InkButton())
    }
}
