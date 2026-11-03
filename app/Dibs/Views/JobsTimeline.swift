import SwiftUI

// The web page's Jobs: one row per job, and per task with an end time, each a
// bar on an axis that spans only the time something is in, so a quiet
// afternoon isn't empty track. A job opens in Queues, with its panel.
struct JobsTimeline: View {
    @Environment(Store.self) private var store
    let rows: [Row]
    let tasks: [ProgressTask]
    let now: Date

    struct Item: Identifiable {
        enum Kind { case run, paused, wait, task, late }
        var id: String
        var row: Row?
        var who: String
        var kind: Kind
        var what: String
        var tag: String
        var from: Date
        var to: Date
        var open = false
        var when: String
    }

    var body: some View {
        let items = Self.items(rows: rows, tasks: tasks, now: now)
        if items.isEmpty {
            Text(store.chosen.map { "\(store.displayName($0)) has no jobs and no task with an end time." }
                 ?? "Nothing running or waiting. Jobs show up here as agents run them, and tasks once they post with --eta.")
                .foregroundStyle(Palette.ink3)
                .padding(.vertical, Space.s)
        } else {
            let axis = Axis(items: items, now: now)
            VStack(spacing: 0) {
                line(who: "", what: AnyView(EmptyView()), when: "") { ticks(axis) }
                    .frame(height: 30)
                ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                    Rectangle().fill(Palette.hairline).frame(height: 1)
                    let first = i == 0 || items[i - 1].who != item.who
                    row(item, axis: axis, first: first)
                }
            }
            .padding(.vertical, 4)
            .card()
        }
    }

    static func note(rows: [Row], tasks: [ProgressTask], now: Date) -> String {
        let items = items(rows: rows, tasks: tasks, now: now)
        guard !items.isEmpty else { return "" }
        let axis = Axis(items: items, now: now)
        return "\(Format.clock(axis.lo)) to \(Format.clock(axis.hi)). Click a job to change it."
    }

    // The axis: from the earliest start (at most an hour back) to the latest
    // end (at most six hours ahead), never narrower than 15 minutes past now.
    struct Axis {
        var lo: Date
        var hi: Date
        var ticks: [Date]
        var now: Date

        init(items: [Item], now: Date) {
            self.now = now
            let lo0 = max(now.addingTimeInterval(-3600), min(now, items.map(\.from).min() ?? now))
            let hi0 = min(now.addingTimeInterval(6 * 3600), max(now.addingTimeInterval(15 * 60), items.map(\.to).max() ?? now))
            let pad = max(180, hi0.timeIntervalSince(lo0) * 0.04)
            lo = lo0.addingTimeInterval(-pad)
            hi = hi0.addingTimeInterval(pad)
            let width = hi.timeIntervalSince(lo)
            let step = [5.0, 10, 15, 30, 60, 120].map { $0 * 60 }.first { width / $0 <= 5 } ?? 7200
            var t = (lo.timeIntervalSince1970 / step).rounded(.up) * step
            var out: [Date] = []
            while t < hi.timeIntervalSince1970 {
                out.append(Date(timeIntervalSince1970: t))
                t += step
            }
            let lo = lo, hi = hi
            let at = { (d: Date) in (min(hi, max(lo, d)).timeIntervalSince(lo)) / width }
            // A tick right next to now would print over the "now" tag.
            ticks = out.filter { abs(at($0) - at(now)) > 0.09 }
        }

        func at(_ d: Date) -> Double { min(hi, max(lo, d)).timeIntervalSince(lo) / hi.timeIntervalSince(lo) }
    }

    static func items(rows: [Row], tasks: [ProgressTask], now: Date) -> [Item] {
        var out: [Item] = []
        for r in rows where !r.res.allSatisfy({ $0.hasPrefix("files:") }) || r.res.isEmpty {
            let what = r.purpose.isEmpty ? (r.cmd.isEmpty ? r.res.joined(separator: ", ") : r.cmd) : r.purpose
            let tag = "\(r.leaseID.map { "#\($0) " } ?? "")\(r.res.joined(separator: ", "))"
            if r.held {
                let paused = r.pausedText != nil
                let when = paused ? "paused" : r.endsAt.map { "ends ~\(Format.clock($0))" } ?? "running \(ProgressTask.short(now.timeIntervalSince(r.since)))"
                out.append(Item(id: r.id, row: r, who: r.who, kind: paused ? .paused : .run, what: what, tag: tag,
                                from: r.since, to: r.endsAt ?? now, open: r.endsAt == nil, when: when))
            } else {
                let from = r.startsAt ?? now
                out.append(Item(id: r.id, row: r, who: r.who, kind: .wait, what: what, tag: tag, from: from,
                                to: from.addingTimeInterval(10 * 60),
                                when: r.startsAt.map { "starts ~\(Format.clock($0))" } ?? "waiting, #\(r.place ?? 1) in line"))
            }
        }
        for t in tasks where t.state == .doing {
            guard let eta = t.eta else { continue }
            let late = eta < now
            out.append(Item(id: t.id, row: nil, who: t.who, kind: late ? .late : .task, what: t.task ?? "work in \(t.project ?? "a folder")",
                            tag: "task", from: t.started, to: eta,
                            when: late ? "was due \(Format.clock(eta))" : "done by \(Format.clock(eta))"))
        }
        return out.sorted { ($0.who, $0.from) < ($1.who, $1.from) }
    }

    private func row(_ item: Item, axis: Axis, first: Bool) -> some View {
        let body = line(who: first ? item.who : "", what: AnyView(
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                dot(item.kind)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                // The page's .s-text truncates; the tag after it never does.
                Text(item.what).foregroundStyle(Palette.ink).lineLimit(1).layoutPriority(-1)
                Text(item.tag).font(Typeface.sized(11.5, .semibold)).foregroundStyle(Palette.ink3).lineLimit(1).fixedSize()
            }), when: item.when, bold: item.kind == .late) {
            GeometryReader { g in
                let w = g.size.width
                ZStack(alignment: .leading) {
                    ForEach(axis.ticks, id: \.self) { t in
                        // The page's 1px dashed grid line.
                        Path { p in p.move(to: .zero); p.addLine(to: CGPoint(x: 0, y: g.size.height)) }
                            .stroke(Palette.hairline, style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                            .frame(width: 1)
                            .offset(x: w * axis.at(t))
                    }
                    bar(item, axis: axis, width: w)
                    Rectangle().fill(Palette.accent.opacity(0.7)).frame(width: 1.5).offset(x: w * axis.at(axis.now))
                }
                .frame(height: g.size.height)
            }
        }
        .frame(height: 40)
        return Group {
            if let r = item.row {
                Button { open(r) } label: { body.contentShape(.rect) }
                    .buttonStyle(.plain)
                    .help("Click for Go first, Pause and Stop")
            } else {
                body
            }
        }
    }

    private func bar(_ item: Item, axis: Axis, width: CGFloat) -> some View {
        let x = width * axis.at(item.from)
        let w = max(width * 0.008, width * (axis.at(item.open ? axis.now : item.to) - axis.at(item.from)))
        let thin = item.kind == .task || item.kind == .late
        return Group {
            switch item.kind {
            case .run: Capsule().fill(Palette.accent)
            case .paused: Capsule().strokeBorder(Palette.accent, lineWidth: 1.5)
            case .wait: Capsule().fill(Palette.yellow)
            case .task: Capsule().fill(Palette.working.opacity(0.55))
            case .late: Capsule().fill(Palette.yellow.opacity(0.7))
            }
        }
        .frame(width: w, height: thin ? 6 : 10)
        .offset(x: x)
    }

    // The page's .s-dot: 7 points, filled, or a ring when paused or late.
    @ViewBuilder
    private func dot(_ kind: Item.Kind) -> some View {
        Group {
            switch kind {
            case .run: Circle().fill(Palette.accent)
            case .paused: Circle().strokeBorder(Palette.accent, lineWidth: 1.5)
            case .wait: Circle().fill(Palette.yellow)
            case .task: Circle().fill(Palette.working)
            case .late: Circle().strokeBorder(Palette.yellow, lineWidth: 1.5)
            }
        }
        .frame(width: 7, height: 7)
        .accessibilityHidden(true)
    }

    private func ticks(_ axis: Axis) -> some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                ForEach(axis.ticks, id: \.self) { t in
                    Text(Format.clock(t)).fixedSize().offset(x: g.size.width * axis.at(t) - 22)
                }
                Text("now").fontWeight(.bold).foregroundStyle(Palette.accentInk).fixedSize()
                    .offset(x: g.size.width * axis.at(axis.now) - 12)
            }
            .font(Typeface.sized(11, .medium))
            .foregroundStyle(Palette.ink3)
            .frame(maxHeight: .infinity)
        }
    }

    // who | what | track | when, the web page's four columns. The agent is its
    // handle, as on the page, so its column stays narrow.
    private func line<Track: View>(who: String, what: AnyView, when: String, bold: Bool = false, @ViewBuilder track: () -> Track) -> some View {
        Columns {
            Text(who)
                .font(Typeface.exact(13.5, 650))
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(who.isEmpty ? "" : store.displayName(who))
            what
            track()
            Text(when)
                .font(Typeface.sized(13, .semibold))
                .foregroundStyle(bold ? Palette.ink : Palette.ink2)
                .lineLimit(1)
        }
        // The page's .srow: 18 at the sides, so the hairlines between rows run edge to edge.
        .padding(.horizontal, 18)
    }

    private func open(_ row: Row) {
        store.sheetRow = row.id
    }
}

// The timeline's four columns from the width it's offered: the agent and
// the time at fixed widths, and what's left split so the job's name gets a
// little more than the track, since the name is the thing to read and the
// bars still tell times apart at 160 points.
struct Columns: Layout {
    static let gap: CGFloat = 18, who: CGFloat = 110, when: CGFloat = 128, minTrack: CGFloat = 160

    private func widths(_ total: CGFloat) -> [CGFloat] {
        let rest = max(0, total - Self.who - Self.when - Self.gap * 3)
        let track = min(rest, max(Self.minTrack, rest / 2.4))
        return [Self.who, rest - track, track, Self.when]
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 720
        let w = widths(width)
        let height = zip(subviews, w).map { $0.sizeThatFits(ProposedViewSize(width: $1, height: proposal.height)).height }.max() ?? 0
        return CGSize(width: width, height: proposal.height ?? height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        for (i, (view, w)) in zip(subviews, widths(bounds.width)).enumerated() {
            // The time sits on the right of its column, as the page's .s-when does.
            let size = view.sizeThatFits(ProposedViewSize(width: w, height: bounds.height))
            let dx = i == 3 ? w - min(w, size.width) : 0
            view.place(at: CGPoint(x: x + dx, y: bounds.midY), anchor: .leading,
                       proposal: ProposedViewSize(width: i == 2 ? w : min(w, size.width), height: i == 2 ? bounds.height : nil))
            x += w + Self.gap
        }
    }
}
