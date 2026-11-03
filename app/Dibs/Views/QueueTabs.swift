import SwiftUI

// The queues as tabs, one per busy queue, each a standings table: who's on
// now, then everyone waiting by place, why they're in that place, and when
// they start. File locks get a tab of their own.
struct QueueTabs: View {
    let counters: [Counter]
    let files: [Counter]
    let canAct: Bool
    @Binding var tab: String?
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void

    var body: some View {
        let tabs = counters.map(\.res) + (files.isEmpty ? [] : ["files"])
        let current = tab.flatMap { tabs.contains($0) ? $0 : nil } ?? tabs.first
        VStack(alignment: .leading, spacing: Space.l) {
            ScrollView(.horizontal) {
                HStack(spacing: Space.s) {
                    ForEach(counters) { c in
                        chip(c.res, c.shortName, on: c.serving.count, waiting: c.waiting.count, current: current)
                    }
                    if !files.isEmpty {
                        chip("files", "File locks", on: FileLocks.unique(files.flatMap(\.serving)).count,
                             waiting: FileLocks.unique(files.flatMap(\.waiting)).count, current: current)
                    }
                }
                .padding(.vertical, 2)
            }
            .scrollIndicators(.never)
            if current == "files" {
                FileLocks(counters: files, canAct: canAct, selected: $selected, onConfirm: onConfirm)
                    .padding(Space.l + 2)
                    .card()
            } else if let c = counters.first(where: { $0.res == current }) {
                RankTable(counter: c, canAct: canAct, selected: $selected, onConfirm: onConfirm)
            }
        }
    }

    private func chip(_ res: String, _ name: String, on: Int, waiting: Int, current: String?) -> some View {
        let picked = res == current
        return Button { tab = res } label: {
            HStack(spacing: 7) {
                ResDot(res: res)
                Text(name)
                    .font(Typeface.name)
                    .foregroundStyle(picked ? Palette.canvas : Palette.ink)
                if waiting > 0 {
                    Text("\(waiting)")
                        .font(Typeface.time)
                        .foregroundStyle(Palette.onYellow)
                        .padding(.horizontal, 6)
                        .background(Palette.yellow, in: Capsule())
                        .help("\(waiting) waiting")
                } else if on > 0 {
                    Text("on")
                        .font(Typeface.small.weight(.semibold))
                        .foregroundStyle(picked ? Palette.canvas.opacity(0.7) : Palette.ink3)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(picked ? Palette.ink : Palette.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(picked ? .clear : Palette.hairline))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
    }
}

// One queue as standings: a header with when it clears, column labels, then
// a row per agent.
struct RankTable: View {
    let counter: Counter
    let canAct: Bool
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void

    static let place: CGFloat = 58
    static let why: CGFloat = 230
    static let time: CGFloat = 104

    var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { context in
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                    Text(counter.shortName)
                        .font(Typeface.sized(20, .bold))
                        .foregroundStyle(Palette.ink)
                    Text(counter.summary)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(1)
                    Spacer(minLength: Space.m)
                    if counter.waiting.count > 1 { WhyThisOrder() }
                }
                .padding(.bottom, Space.m)
                ViewThatFits(in: .horizontal) {
                    columns(why: true)
                    columns(why: false)
                }
                ForEach(counter.serving) { row in
                    RankRow(row: row, place: nil, line: counter.res, now: context.date, canAct: canAct, selected: $selected, onConfirm: onConfirm)
                }
                ForEach(counter.waiting) { row in
                    RankRow(row: row, place: row.place ?? 1, line: counter.res, now: context.date, canAct: canAct, selected: $selected, onConfirm: onConfirm)
                }
            }
            .padding(Space.l + 2)
            .card()
        }
    }

    private func columns(why: Bool) -> some View {
        HStack(spacing: Space.m) {
            ColumnLabel("Place").frame(width: Self.place, alignment: .leading)
            ColumnLabel("Agent")
            Spacer(minLength: Space.m)
            if why { ColumnLabel("Why this place").frame(width: Self.why, alignment: .leading) }
            ColumnLabel("Starts").frame(width: Self.time, alignment: .trailing)
        }
        .padding(.horizontal, Space.s)
        .padding(.bottom, Space.s)
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }
}

struct RankRow: View {
    let row: Row
    // nil while it's on now.
    let place: Int?
    let line: String
    let now: Date
    let canAct: Bool
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void
    @State private var hovering = false

    var body: some View {
        let isSelected = selected == row.id
        Button { selected = isSelected ? nil : row.id } label: {
            ViewThatFits(in: .horizontal) {
                content(why: true)
                content(why: false)
            }
            .padding(.horizontal, Space.s)
            .padding(.vertical, 10)
            .background(isSelected ? Palette.accentWash : hovering ? Palette.sunken.opacity(0.6) : .clear,
                        in: .rect(cornerRadius: 10, style: .continuous))
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.accent.opacity(0.6), lineWidth: 1.5)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .focusable(false)
        .onHover { hovering = $0 }
        .contextMenu {
            if canAct && row.leaseID != nil { RowActions(row: row, onConfirm: onConfirm) }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1).padding(.horizontal, Space.s) }
    }

    private func content(why: Bool) -> some View {
        HStack(spacing: Space.m) {
            badge.frame(width: RankTable.place, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                AgentLabel(who: row.who, sub: row.subagent)
                if !row.purpose.isEmpty {
                    Text(row.purpose)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(1)
                }
            }
            .frame(minWidth: 120, alignment: .leading)
            Spacer(minLength: Space.m)
            if why {
                let also = row.res.filter { $0 != line && !$0.hasPrefix("files:") }
                FitRow {
                    ForEach(row.moves.prefix(2), id: \.self) { Delta(move: $0) }
                    ForEach(also, id: \.self) { ResPill(res: $0, prefix: "+ ") }
                }
                .frame(width: RankTable.why, alignment: .leading)
                .clipped()
                .help((row.moves.prefix(2).map(\.sentence) + also.map { "Also needs \(Plain.inSentence($0))." }).joined(separator: "\n"))
            }
            VStack(alignment: .trailing, spacing: 4) {
                Text(place == nil ? (row.pausedText == nil ? row.left(at: now) : "Paused") : row.starts(at: now))
                    .font(Typeface.time)
                    .foregroundStyle(place == nil && row.pausedText != nil ? Palette.accentInk : Palette.ink)
                    .lineLimit(1)
                if place == nil, Needs.isIdle(row) {
                    // Doing nothing while others wait: the one row here the person may want to stop.
                    Text("Looks stuck")
                        .font(Typeface.small.weight(.semibold))
                        .foregroundStyle(Palette.accentInk)
                        .help("Its processes haven't done anything for \(Span.of(row.idleFor ?? 0)).")
                } else if place == nil, row.pausedText == nil, let p = row.progress(at: now) {
                    Bar(fill: 1 - p, height: 4).frame(width: 70)
                }
            }
            .frame(width: RankTable.time, alignment: .trailing)
        }
    }

    // On now is a red pill; the rest are their place, the next one in yellow.
    @ViewBuilder
    private var badge: some View {
        if let place {
            Text("\(place)")
                .font(Typeface.sized(15, .bold).monospacedDigit())
                .foregroundStyle(place == 1 ? Palette.onYellow : Palette.ink)
                .frame(width: 32, height: 32)
                .background(place == 1 ? Palette.yellow : Palette.sunken, in: Circle())
        } else {
            Pill("Now", tone: .hot)
        }
    }
}

// Why someone moved, with how far: "3 min" up or down and the reason in a word.
struct Delta: View {
    let move: Move

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: move.up ? "arrow.up" : "arrow.down")
                .font(Typeface.sized(9, .bold))
            if let amount = move.amount { Text(amount).monospacedDigit() }
            Text(move.word).opacity(0.8)
        }
        .font(Typeface.small.weight(.semibold))
        .foregroundStyle(move.up ? Palette.working : Palette.ink2)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(move.up ? Palette.working.opacity(0.13) : Palette.sunken, in: Capsule())
        .lineLimit(1)
        .fixedSize()
        .help(move.sentence)
    }
}
