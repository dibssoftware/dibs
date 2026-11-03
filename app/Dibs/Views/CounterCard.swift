import SwiftUI

// One resource's queue: a header with its color, how many wait and when it
// clears, then who has it and everyone waiting, one row each. A row opens in
// the inspector for the rest.
struct CounterCard: View {
    let counter: Counter
    let canAct: Bool
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void
    @State private var collapsed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            header
            if !collapsed {
                ForEach(counter.serving) { row in
                    ServingRow(row: row, line: counter.res, canAct: canAct, selected: $selected, onConfirm: onConfirm)
                        .transition(.opacity)
                }
                ForEach(counter.waiting) { row in
                    WaitingRow(row: row, line: counter.res, nobodyServing: counter.serving.isEmpty, canAct: canAct,
                               selected: $selected, onConfirm: onConfirm)
                        .transition(.opacity)
                }
            }
        }
        .animation(.spring(response: 0.38, dampingFraction: 0.9), value: counter.serving.map(\.id) + counter.waiting.map(\.id))
    }

    private var header: some View {
        HStack(spacing: Space.s) {
            Button {
                withAnimation(.easeOut(duration: 0.2)) { collapsed.toggle() }
            } label: {
                HStack(spacing: Space.s) {
                    Image(systemName: "chevron.down")
                        .font(Typeface.sized(9, .bold))
                        .foregroundStyle(Palette.ink3)
                        .rotationEffect(.degrees(collapsed ? -90 : 0))
                        .frame(width: 12)
                    ResDot(res: counter.res)
                    Text(counter.shortName)
                        .font(Typeface.title)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(counter.shortName == counter.name ? "" : counter.name)
                    if collapsed, !counter.waiting.isEmpty {
                        Pill("\(counter.waiting.count) waiting", tone: .hot)
                    }
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            Spacer(minLength: Space.l)
            if let clears = counter.clearsAt, !counter.waiting.isEmpty {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    ColumnLabel(clears > context.date ? "Clear in \(Span.of(clears.timeIntervalSince(context.date)))" : "Clearing")
                }
                .help(counter.summary)
            }
            if counter.waiting.count > 1 {
                WhyThisOrder()
            }
        }
        .padding(.bottom, Space.s)
    }
}

// One row of a queue: its place, who and what, tags, the time on the right.
// Clicking selects it for the inspector; right-click has the owner's actions.
struct LineRow<Tags: View, Trailing: View, Actions: View>: View {
    let row: Row
    let place: String
    let canAct: Bool
    var serving = false
    @Binding var selected: String?
    @ViewBuilder let tags: Tags
    @ViewBuilder let trailing: Trailing
    @ViewBuilder let actions: Actions
    @State private var hovering = false

    var body: some View {
        let isSelected = selected == row.id
        Button {
            selected = isSelected ? nil : row.id
        } label: {
            HStack(spacing: Space.m) {
                Pill(place, tone: serving ? .hot : place == "Next" ? .next : .faint)
                    .frame(width: 50, alignment: .leading)
                // The purpose goes when it won't fit whole; it's in the inspector.
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        AgentLabel(who: row.who, sub: row.subagent).fixedSize()
                        if !row.purpose.isEmpty { Text(row.purpose).foregroundStyle(Palette.ink3).fixedSize() }
                    }
                    AgentLabel(who: row.who, sub: row.subagent)
                }
                Spacer(minLength: Space.s)
                // Tags go when the row runs out of room; the inspector has them.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 5) { tags }.fixedSize()
                    Color.clear.frame(width: 0, height: 0)
                }
                trailing
            }
            .padding(.leading, Space.m)
            .padding(.trailing, Space.m)
            .padding(.vertical, Space.s + 1)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isSelected ? Palette.accentWash : hovering ? Palette.sunken.opacity(0.7) : .clear)
            }
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Palette.accent.opacity(0.6), lineWidth: 1.5)
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        // Taking focus on click scrolled the list to show the focused row.
        .focusable(false)
        .onHover { hovering = $0 }
        .contextMenu {
            if canAct { actions }
        }
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct ServingRow: View {
    @Environment(Store.self) private var store
    let row: Row
    let line: String
    let canAct: Bool
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { context in
            LineRow(row: row, place: "Now", canAct: canAct && row.leaseID != nil, serving: true, selected: $selected) {
                if Needs.isIdle(row) {
                    Pill("Looks stuck", tone: .hot)
                        .help("Its processes haven't done anything for \(Span.of(row.idleFor ?? 0)).")
                } else if row.overAsk != nil {
                    Pill("Over its memory", tone: .faint)
                        .help("It's using more memory than it asked for.")
                }
                alsoNeeds(row, line: line)
            } trailing: {
                HStack(spacing: Space.s) {
                    if row.pausedText == nil, let p = row.progress(at: context.date) {
                        Bar(fill: 1 - p, height: 5)
                            .frame(width: 56)
                    }
                    Text(row.pausedText == nil ? row.left(at: context.date) : "Paused")
                        .font(Typeface.time)
                        .foregroundStyle(row.pausedText == nil ? Palette.ink : Palette.accentInk)
                        .frame(minWidth: 84, alignment: .trailing)
                }
            } actions: {
                RowActions(row: row, onConfirm: onConfirm)
            }
        }
    }
}

struct WaitingRow: View {
    let row: Row
    let line: String
    // With nobody using it, why this row is waiting isn't obvious, so it says.
    var nobodyServing = false
    let canAct: Bool
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void

    var body: some View {
        let place = row.place ?? 1
        TimelineView(.periodic(from: .now, by: 30)) { context in
            LineRow(row: row, place: place == 1 ? "Next" : "\(place)", canAct: canAct && row.leaseID != nil, selected: $selected) {
                ForEach(row.moves.prefix(2), id: \.self) { MoveChip(move: $0) }
                alsoNeeds(row, line: line)
            } trailing: {
                Text(row.starts(at: context.date))
                    .font(Typeface.time)
                    .foregroundStyle(place == 1 ? Palette.ink : Palette.ink2)
                    .lineLimit(1)
                    .frame(minWidth: 84, alignment: .trailing)
            } actions: {
                RowActions(row: row, onConfirm: onConfirm)
            }
            .help(nobodyServing ? row.waitingFor.map { "Waiting for \($0)" } ?? "" : "")
        }
    }
}

// What the owner can do to a row. Menu items on right-click, buttons in the inspector.
struct RowActions: View {
    @Environment(Store.self) private var store
    let row: Row
    let onConfirm: (PendingAction) -> Void

    var body: some View {
        // The web page's sheet, in its order: Go first, Normal place, Let
        // others go first, Pause or Resume, then Stop or Take out of line.
        // Going first can't help a wait on the Mac itself (memory, disk, load).
        // A running job goes first too, as on the web page: it moves off background priority.
        if row.prio != .urgent && (row.held || !Needs.waitsOnMac(row)) {
            Button("Go first") { Task { await store.boost(row, to: .urgent) } }
        }
        if row.prio != .normal || row.owner != nil {
            Button("Normal place") { Task { await store.boost(row, to: .normal) } }
        }
        if row.prio != .low && row.prio != .idle {
            Button("Let others go first") { Task { await store.boost(row, to: .low) } }
        }
        // dibs resume lifts a pause made by hand, the person's or an agent's.
        // One dibs made (for an urgent job, for memory or disk) lifts by itself.
        if row.held && !row.isHold {
            if row.pausedByHand {
                Button("Resume") { Task { await store.setPaused(row, false) } }
            } else if row.paused == nil {
                Button("Pause") { Task { await store.setPaused(row, true) } }
            }
        }
        Button(row.held ? "Stop" : "Take out of line", role: .destructive) { onConfirm(.stop(row)) }
    }
}

// A job that needs two resources waits in both lines; the other one shows in
// its own color. Files it holds count as one tag, however many there are.
@MainActor @ViewBuilder
private func alsoNeeds(_ row: Row, line: String) -> some View {
    ForEach(row.res.filter { $0 != line && !$0.hasPrefix("files:") }, id: \.self) { other in
        ResPill(res: other, prefix: "+ ")
            .help("Also needs \(Plain.inSentence(other))")
    }
    let files = row.res.filter { $0 != line && $0.hasPrefix("files:") }
    if !files.isEmpty {
        Pill(files.count == 1 ? "+ 1 file" : "+ \(files.count) files", tone: .faint)
            .help(files.compactMap(Counter.fileName).joined(separator: ", "))
    }
}

// Everything about one row: who, what, when, why it's in that place, and
// what the owner can do about it.
struct RowInspector: View {
    @Environment(Store.self) private var store
    static let width: CGFloat = 320
    let row: Row
    let line: String
    let canAct: Bool
    let onConfirm: (PendingAction) -> Void
    let onClose: () -> Void
    // The height of everything in the panel, for a sheet that sizes itself to it.
    var onHeight: ((CGFloat) -> Void)? = nil

    var body: some View {
        TimelineView(.periodic(from: .now, by: 10)) { context in
            let now = context.date
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text(row.held ? "Running since \(Format.clock(row.since))" : "In line since \(Format.clock(row.since))")
                            .font(Typeface.small)
                            .foregroundStyle(Palette.ink3)
                            .padding(.trailing, 28)
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(store.rowName(row))
                                    .font(Typeface.sized(20, .bold))
                                    .foregroundStyle(Palette.ink)
                                    .lineLimit(2)
                                if store.agents.byName[row.who]?.title != nil || row.subagent != nil {
                                    Text(row.subagent == nil ? "Claude \u{00B7} \(row.who)" : "A subagent of \(row.who)")
                                        .font(Typeface.small)
                                        .foregroundStyle(Palette.ink3)
                                }
                            }
                            Spacer(minLength: Space.m)
                            Text(row.held ? (row.pausedText == nil ? row.left(at: now) : "Paused") : row.starts(at: now))
                                .font(Typeface.sized(15, .semibold).monospacedDigit())
                                .foregroundStyle(row.held ? Palette.accentInk : Palette.ink)
                                .fixedSize()
                        }
                        if !row.purpose.isEmpty {
                            Text(row.purpose)
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if row.held, row.pausedText == nil, let p = row.progress(at: now) {
                            Bar(fill: 1 - p)
                                .padding(.top, Space.xs)
                        }
                    }
                    .padding(Space.l + 2)

                    section {
                        if let id = row.leaseID {
                            fact("Job") { value("#\(id), \(row.held ? (row.pausedText == nil ? "running" : "paused") : "waiting")\(row.isHold ? " (a hold)" : "")") }
                        }
                        fact("Needs") { ResPill(res: line.hasPrefix("files:") ? "files" : line) }
                        fact("Place") {
                            Pill(row.held ? "Now" : row.place == 1 ? "Next" : "\(row.place ?? 1) in line", tone: row.held ? .hot : .plain)
                        }
                        fact("Priority") { Pill(row.prio.word.capitalized, tone: row.prio == .urgent || row.prio == .high ? .hot : .plain) }
                        let others = row.res.filter { $0 != line && !$0.hasPrefix("files:") }
                        if !others.isEmpty {
                            fact("Also needs") {
                                HStack(spacing: 4) { ForEach(others, id: \.self) { ResPill(res: $0) } }
                            }
                        }
                        // The web page's words: when it started, or since when it waits.
                        if row.held {
                            fact("Started") { value("\(Format.clock(row.since)), \(Span.ago(now.timeIntervalSince(row.since)))") }
                            if let end = row.endsAt { fact("Ends") { value("~\(Format.clock(end))") } }
                        } else {
                            fact("Waiting") { value("since \(Format.clock(row.since)), #\(row.place ?? 1) in line") }
                        }
                        if let due = row.due { fact("Due by") { value(Format.clock(due)) } }
                        if let project = row.project { fact("Folder") { value(project) } }
                    }
                    if let owner = row.owner {
                        section(title: "Changed by \(Plain.ownerBy(owner).by.map(store.displayName) ?? "you")") {
                            Text(ActionText.owner(owner, name: store.displayName)).foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } else if let byAgent = row.byAgent {
                        section(title: "Changed by \(store.rowName(row))") {
                            Text(ActionText.agent(byAgent)).foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    let files = row.res.compactMap(Counter.fileName)
                    if !files.isEmpty {
                        section(title: files.count == 1 ? "File" : "\(files.count) files") {
                            Text(files.joined(separator: ", "))
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(Palette.ink2)
                                .copyable(files.joined(separator: ", "))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if !row.held, let waitingFor = row.waitingFor {
                        section(title: "Waiting for") {
                            Text(waitingFor.prefix(1).uppercased() + waitingFor.dropFirst())
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                            if Needs.waitsOnMac(row) {
                                Text("It starts by itself. Letting it go first won't help, since it isn't waiting behind another agent.")
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            if Needs.isDisk(row) { StorageButton(prominent: false) }
                        }
                    }
                    if let paused = row.pausedText {
                        section(title: "Paused") {
                            Text(paused).foregroundStyle(Palette.accentInk)
                                .fixedSize(horizontal: false, vertical: true)
                            if let by = row.pausedByAgent {
                                Text("\(store.displayName(by)) paused it. It keeps its place, and you can resume it.")
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink3)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else if !row.pausedByHand {
                                Text("dibs paused it, and it resumes by itself. It keeps its place.")
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    if Needs.isIdle(row) {
                        section(title: "Looks stuck") {
                            Text("Its processes haven't done anything for \(Span.of(row.idleFor ?? 0)). If \(store.rowName(row)) has stopped working on it, stopping it lets the next one start.")
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if let over = row.overAsk, let used = over.used, let asked = over.asked {
                        section(title: "Memory") {
                            Text("It used \(Format.gb(used)) of memory but asked for \(Format.gb(asked)), so dibs may have started other jobs into memory it was about to take. \(store.rowName(row)) has been told to ask for more next time.")
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    if !row.moves.isEmpty {
                        section(title: "Why this place") {
                            ForEach(row.moves, id: \.self) { move in
                                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                                    Image(systemName: move.up ? "arrow.up" : "arrow.down")
                                        .font(Typeface.small.weight(.semibold))
                                        .foregroundStyle(move.up ? Palette.accentInk : Palette.ink3)
                                    Text(move.sentence)
                                        .foregroundStyle(Palette.ink2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    if !row.cmd.isEmpty {
                        section(title: "Command") {
                            Text(row.cmd)
                                .font(.system(size: 11.5, design: .monospaced))
                                .foregroundStyle(Palette.ink2)
                                .copyable(row.cmd)
                                .fixedSize(horizontal: false, vertical: true)
                                .padding(Space.s + 2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Palette.ink.opacity(0.05), in: .rect(cornerRadius: 8, style: .continuous))
                        }
                    }
                    if canAct && row.leaseID != nil {
                        section {
                            Flow(spacing: Space.s) {
                                RowActions(row: row, onConfirm: onConfirm)
                                    .buttonStyle(InkButton())
                                SlowDownButton(who: row.who, short: true, onConfirm: onConfirm)
                                    .buttonStyle(InkButton())
                            }
                            Text("Each runs the same dibs command you would, and the history says you did it.")
                                .font(Typeface.small)
                                .foregroundStyle(Palette.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                // Held to the panel's width, so a long line wraps instead of
                // pushing everything past the edge.
                .frame(width: RowInspector.width)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight?($0) }
            }
        }
        .background(Palette.surface)
        .overlay(alignment: .topTrailing) {
            Button(action: onClose) {
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

    @ViewBuilder
    private func section<C: View>(title: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        Rectangle().fill(Palette.hairline).frame(height: 1)
        VStack(alignment: .leading, spacing: Space.m) {
            if let title {
                Text(title)
                    .font(Typeface.headline)
                    .foregroundStyle(Palette.ink)
            }
            content()
        }
        .padding(Space.l + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func fact<V: View>(_ label: String, @ViewBuilder _ v: () -> V) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label)
                .foregroundStyle(Palette.ink3)
                .frame(width: 110, alignment: .leading)
            v()
            Spacer(minLength: 0)
        }
    }

    private func value(_ text: String) -> some View {
        Text(text).foregroundStyle(Palette.ink).monospacedDigit()
    }
}

struct SlowDownButton: View {
    @Environment(Store.self) private var store
    let who: String
    // Inside the row's panel, which is already about this agent: no name.
    var short = false
    let onConfirm: (PendingAction) -> Void

    var body: some View {
        if store.board?.caps[who] != nil {
            Button(short ? "Let it run normally" : "Let \(store.displayName(who)) run normally") { Task { await store.cap(who, at: nil) } }
        } else {
            Button(short ? "Only when idle\u{2026}" : "Only run \(store.displayName(who)) when idle\u{2026}") { onConfirm(.slowDown(who)) }
                .help("Only run \(store.displayName(who)) when nothing else is waiting")
        }
    }
}

// Why someone moved, in two or three words. The inspector has the sentence.
struct MoveChip: View {
    let move: Move

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: move.up ? "arrow.up" : "arrow.down")
                .imageScale(.small)
            Text(move.word)
        }
        .font(Typeface.small.weight(.semibold))
        .lineLimit(1)
        .fixedSize()
        .foregroundStyle(move.up ? Palette.onAccent : Palette.ink2)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(move.up ? Palette.accent : Palette.sunken, in: Capsule())
        .help(move.sentence)
    }
}

extension Prio {
    var tint: Color {
        switch self {
        case .urgent, .high: Palette.accentInk
        case .normal: Palette.ink
        case .low, .idle: Palette.ink3
        }
    }
}
