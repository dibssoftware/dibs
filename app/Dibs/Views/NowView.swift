import AppKit
import SwiftUI

// What the person may be about to do to a row, waiting for them to confirm.
enum PendingAction: Identifiable {
    case goFirst(Row)
    case stop(Row)
    case slowDown(String)

    var id: String {
        switch self {
        case .goFirst(let r): "first-\(r.id)"
        case .stop(let r): "stop-\(r.id)"
        case .slowDown(let who): "slow-\(who)"
        }
    }
}

struct QueuesView: View {
    @Environment(Store.self) private var store
    // nil is this Mac; otherwise another machine in the group, by name.
    @State private var machine: String?
    @State private var pending: PendingAction?
    // The row open in the inspector, by id.
    @State private var selected: String?
    // The queue's tab open, by resource.
    @State private var tab: String?
    // The screen's width, to decide whether the row's panel sits beside the
    // queues or over them.
    @State private var width: CGFloat = 1000
    // Below this the queues would be too cramped to share the width.
    private static let sideBySide: CGFloat = 900

    var body: some View {
        panelled
            .navigationTitle("Queues")
            .navigationSubtitle(store.lastAction ?? "")
            // Over the page like the web page's view tools; the window has no toolbar.
            .safeAreaInset(edge: .top, spacing: 0) {
                if !peers.isEmpty {
                    Picker("Machine", selection: $machine) {
                        Text("This Mac").tag(String?.none)
                        ForEach(peers) { Text($0.name).tag(Optional($0.name)) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .fixedSize()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 44)
                    .padding(.top, 20)
                }
            }
            .jobConfirm($pending)
    }

    // SwiftUI's inspector keeps its width even while closed, which pushed the
    // queues past the window's edge at small sizes, so the panel is drawn here.
    private var panelled: some View {
        let wide = width >= Self.sideBySide
        return ZStack(alignment: .trailing) {
            HStack(spacing: 0) {
                content
                    .frame(maxWidth: .infinity)
                if wide, let (row, line) = selectedRow {
                    Rectangle().fill(Palette.hairline).frame(width: 1)
                    panel(row, line)
                }
            }
            if !wide, let (row, line) = selectedRow {
                panel(row, line)
                    .overlay(alignment: .leading) { Rectangle().fill(Palette.hairline).frame(width: 1) }
                    .shadow(color: .black.opacity(0.18), radius: 18, x: -4)
            }
        }
        .animation(.easeOut(duration: 0.2), value: selected)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private func panel(_ row: Row, _ line: String) -> some View {
        RowInspector(row: row, line: line, canAct: store.ownerActions && machine == nil,
                     onConfirm: { pending = $0 }, onClose: { selected = nil })
            .frame(width: RowInspector.width)
            .transition(.move(edge: .trailing).combined(with: .opacity))
    }

    private var peers: [Peer] { store.board?.peers(excluding: store.hostName) ?? [] }

    // The selected row as it is now, with the queue it was picked in. Gone
    // when its job ends, which closes the inspector.
    private var selectedRow: (Row, String)? {
        guard let selected else { return nil }
        let counters = machine.flatMap { name in peers.first { $0.name == name }?.rows().counters() } ?? store.counters
        for c in counters {
            if let r = (c.serving + c.waiting).first(where: { $0.id == selected }) { return (r, c.res) }
        }
        return nil
    }

    @ViewBuilder
    private var content: some View {
        if let board = store.board {
            ScrollViewReader { scroller in
                VStack(alignment: .leading, spacing: Space.l) {
                    if let name = machine, let peer = peers.first(where: { $0.name == name }) {
                        peerBoard(peer)
                    } else {
                        localBoard(board)
                    }
                }
                .page()
                .onChange(of: store.focusRes, initial: true) { _, res in
                    guard let res else { return }
                    machine = nil
                    tab = res.hasPrefix("files:") ? "files" : res
                    store.focusRes = nil
                }
                .onChange(of: store.focusRow, initial: true) { _, row in
                    guard let row else { return }
                    machine = nil
                    selected = row
                    store.focusRow = nil
                }
            }
        } else if let error = store.boardError {
            CLIProblemView(error: error)
        } else {
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private func localBoard(_ board: Board) -> some View {
        let counters = store.counters
        let me = board.elsewhere?.machines?.first { $0.name == store.hostName }
        PageHead(title: "Queues", summary: Self.summary(counters))
            .padding(.bottom, Space.m)
        if let stale = store.freshness().flatMap({ $0.stale ? $0.text : nil }) {
            Text(stale).foregroundStyle(Palette.accentInk).lineLimit(2)
        }
        Lines(counters: counters, free: freeNames(counters, extra: me?.board?.free ?? []), canAct: store.ownerActions,
              tab: $tab, selected: $selected, onConfirm: { pending = $0 })
        if !board.caps.isEmpty {
            SlowedDown(caps: board.caps, canAct: store.ownerActions)
        }
        JustFinished(history: store.today)
            .padding(.top, Space.l)
        Footnotes(quotas: board.quotas,
                  note: store.ownerActions || store.version == nil ? nil
                      : "Letting jobs go first, pausing and stopping need dibs \(Store.ownerVersion) or newer. This Mac has \(store.version ?? "").",
                  limits: board.limits)
    }

    @ViewBuilder
    private func peerBoard(_ peer: Peer) -> some View {
        let counters = peer.rows().counters()
        PageHead(title: peer.name, summary: MachineHeader.note(peer) ?? Self.summary(counters))
            .padding(.bottom, Space.m)
        Lines(counters: counters, free: freeNames(counters, extra: peer.board?.free ?? []), canAct: false,
              tab: $tab, selected: $selected, onConfirm: { _ in })
    }

    // The web page's sentence: how many queues are in use and how many wait.
    static func summary(_ counters: [Counter]) -> String {
        let busy = counters.filter { !$0.isFree }
        guard !busy.isEmpty else { return "Every queue is free." }
        let waiting = Set(busy.flatMap(\.waiting).map(\.id)).count
        return "\(busy.count == 1 ? "1 queue" : "\(busy.count) queues") in use, \(waiting) waiting. Click a row for its job."
    }

    // Free lines come from `lines` on 0.0.80; older boards list the free
    // resources by name, some with a count of free places: "test(3)".
    private func freeNames(_ counters: [Counter], extra: [String]) -> [String] {
        let fromLines = counters.filter(\.isFree).map(\.name)
        guard fromLines.isEmpty else { return fromLines }
        let busy = Set(counters.map(\.res))
        return extra.map { $0.replacingOccurrences(of: #"\(\d+\)$"#, with: "", options: .regularExpression) }
            .filter { !busy.contains($0) }
            .map(Plain.name)
    }
}

// What the person may be about to do to a job, asked once more before it happens:
// the same dialogs wherever a job's panel is open (Queues, the job sheet, Schedule).
struct JobConfirm: ViewModifier {
    @Environment(Store.self) private var store
    @Binding var pending: PendingAction?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(title, isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                                presenting: pending) { action in
                buttons(action)
            } message: { action in
                Text(message(action))
            }
            // A row that started, ended or left while its dialog was open:
            // the dialog was about something that's no longer there.
            .onChange(of: store.rows.map(\.id)) { _, ids in
                switch pending {
                case .goFirst(let row), .stop(let row):
                    if !ids.contains(row.id) { pending = nil }
                default: break
                }
            }
            .confirmationDialog("Pause it anyway?", isPresented: Binding(get: { store.refusedPause != nil }, set: { if !$0 { store.refusedPause = nil } }),
                                presenting: store.refusedPause) { refused in
                Button("Pause anyway") { Task { await store.setPaused(refused.row, true, force: true) } }
                Button("Stop instead", role: .destructive) { Task { await store.stop(refused.row) } }
            } message: { refused in
                Text("Freezing \(Plain.inSentence(refused.row.res.first ?? "")) halfway through can leave it in a bad state for whoever goes next. Stopping is safer.")
            }
    }

    private var title: String {
        switch pending {
        case .goFirst(let row): "Let \(store.rowName(row)) go first?"
        case .stop(let row): row.held ? "Stop \(store.rowName(row))?" : "Take \(store.rowName(row)) out of line?"
        case .slowDown(let who): "Only run \(store.displayName(who)) when nothing else is waiting?"
        case nil: ""
        }
    }

    private func message(_ action: PendingAction) -> String {
        switch action {
        case .goFirst(let row):
            return "It moves to the front of the \(Plain.queueName(row.res.first ?? "")), ahead of everyone waiting. Background work that's running may be paused to make room."
        case .stop(let row) where row.held:
            let who = store.rowName(row)
            return "This ends \(who)'s command and everything it started. It can't be undone. The next in the queue starts."
        case .stop(let row):
            let who = store.rowName(row)
            return "\(who)'s dibs gets told it was taken out, and its command never runs. If it starts before you confirm, it's left running."
        case .slowDown(let who):
            return "\(store.displayName(who))'s jobs will wait until every other agent's work is done and this Mac is quiet. You can undo this under Held back."
        }
    }

    @ViewBuilder
    private func buttons(_ action: PendingAction) -> some View {
        switch action {
        case .goFirst(let row):
            Button("Let it go first") { Task { await store.boost(row, to: .urgent) } }
        case .stop(let row):
            Button(row.held ? "Yes, stop it" : "Yes, take it out", role: .destructive) { Task { await store.stop(row) } }
        case .slowDown(let who):
            Button("Only when idle") { Task { await store.cap(who, at: .idle) } }
        }
    }
}

extension View {
    func jobConfirm(_ pending: Binding<PendingAction?>) -> some View { modifier(JobConfirm(pending: pending)) }
}

// A job's panel over whatever screen it was picked on (Now's jobs and file
// locks, the palette), as the web page's job sheet: everything about it and
// what the person can do, without leaving the screen.
struct JobSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    let rowID: String
    @State private var pending: PendingAction?
    // What the panel's content measures; until it's measured, a height most jobs fit in.
    @State private var height: CGFloat = 520

    // The sheet grows with the job, up to this share of the window, then scrolls.
    static let maxShare: CGFloat = 0.85

    var body: some View {
        Group {
            if let (row, line) = found {
                RowInspector(row: row, line: line, canAct: store.ownerActions, onConfirm: { pending = $0 }, onClose: { dismiss() },
                             onHeight: { height = $0 })
                    .frame(width: RowInspector.width, height: min(height, Self.cap))
            } else {
                VStack(alignment: .leading, spacing: Space.m) {
                    Text("It's gone").font(Typeface.title)
                    Text("It ended or left the line.").foregroundStyle(Palette.ink2)
                    Button("Close") { dismiss() }.buttonStyle(InkButton()).keyboardShortcut(.cancelAction)
                }
                .padding(Space.xl)
                .frame(width: 360, alignment: .leading)
            }
        }
        .jobConfirm($pending)
    }

    // 85% of the window the sheet hangs from, so a normal job shows every action without scrolling.
    static var cap: CGFloat {
        let window = NSApp.mainWindow?.contentLayoutRect.height ?? NSApp.windows.first { $0.isVisible }?.frame.height ?? 800
        return max(320, window * maxShare)
    }

    private var found: (Row, String)? {
        for c in store.counters {
            if let r = (c.serving + c.waiting).first(where: { $0.id == rowID }) { return (r, c.res) }
        }
        return store.rows.first { $0.id == rowID }.map { ($0, $0.res.first ?? "") }
    }
}

// What the queues say about another machine in the group when it isn't reporting.
enum MachineHeader {
    static func note(_ peer: Peer) -> String? {
        if peer.lost == true { return "Not reporting. Last heard from \(Plain.about((peer.age ?? 0) / 1000)) ago." }
        if peer.board == nil { return "It runs dibs \(peer.version ?? "of an older version"), which doesn't share its queues." }
        // Boards older than 20s say how old they are, as the CLI's does.
        if let age = peer.age, age > 20_000 { return "As of \(Plain.about(age / 1000)) ago." }
        return nil
    }
}

struct Lines: View {
    let counters: [Counter]
    let free: [String]
    let canAct: Bool
    @Binding var tab: String?
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void

    var body: some View {
        let busy = counters.queues.filter { !$0.isFree }
        let files = counters.fileLocks.filter { !$0.isFree }
        if busy.isEmpty && files.isEmpty {
            Text("Every queue is free. Agents show up here when they wait for something.").foregroundStyle(Palette.ink3)
        }
        if !busy.isEmpty || !files.isEmpty {
            QueueTabs(counters: busy, files: files, canAct: canAct, tab: $tab, selected: $selected, onConfirm: onConfirm)
        }
        if !free.isEmpty {
            Flow {
                Text("Free")
                    .font(Typeface.eyebrow)
                    .foregroundStyle(Palette.ink3)
                ForEach(free, id: \.self) { name in
                    HStack(spacing: 6) {
                        ResDot(res: counters.first { $0.name == name }?.res ?? name, size: 6)
                        Text(name)
                    }
                    .font(Typeface.small.weight(.medium))
                    .foregroundStyle(Palette.ink2)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .overlay(Capsule().strokeBorder(Palette.hairline))
                    .fixedSize()
                }
            }
                .padding(.top, Space.l)
        }
    }
}

// Agents the owner slowed down, each with a way to undo it.
struct SlowedDown: View {
    @Environment(Store.self) private var store
    let caps: [String: Board.Cap]
    let canAct: Bool

    var body: some View {
        PageSection("Held back", note: "dibs cap") {
            VStack(spacing: 0) {
                ForEach(Array(caps.keys.sorted().enumerated()), id: \.element) { i, agent in
                    if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                    let cap = caps[agent]!
                    HStack(alignment: .firstTextBaseline) {
                        // One Text built from pieces: adding a String to an interpolated
                        // Text prints the Text's debug description instead.
                        Text("\(Text(store.displayName(agent)).fontWeight(.semibold).foregroundStyle(Palette.ink)) \(Self.line(cap.prio))\(cap.at.map { ", since \(Format.clock(Date(ms: $0)))" } ?? "")")
                            .foregroundStyle(Palette.ink2)
                        Spacer()
                        if canAct {
                            Button("Let it run normally") { Task { await store.cap(agent, at: nil) } }
                                .buttonStyle(InkButton())
                                .disabled(store.running.contains("cap-\(agent)"))
                        }
                    }
                    .padding(.horizontal, Space.l + 2)
                    .padding(.vertical, Space.m)
                }
            }
            .card()
        }
        .padding(.top, Space.l)
    }

    static func line(_ prio: String) -> String {
        switch Prio(prio) {
        case .idle: "only runs when nothing else is waiting"
        case .low: "lets everyone else go first"
        default: "never goes ahead of \(prio) work"
        }
    }
}

struct Footnotes: View {
    let quotas: [Quota]
    let note: String?
    // 0.0.86's limits line: what dibs checks before it starts a job.
    var limits: String? = nil

    var body: some View {
        if !quotas.isEmpty || note != nil || limits != nil {
            VStack(alignment: .leading, spacing: 4) {
                if let limits {
                    Text("Before starting a job, dibs checks: \(limits).")
                        .fixedSize(horizontal: false, vertical: true)
                }
                ForEach(quotas, id: \.self) { q in
                    if let error = q.error {
                        Text("\(q.name) limit: \(error)")
                    } else {
                        Text("\(q.name): \(Int(q.left ?? 0)) of \(Int(q.limit ?? 0)) calls left \(Self.per(q.per))")
                    }
                }
                if let note { Text(note) }
            }
            .font(Typeface.small)
            .foregroundStyle(Palette.ink3)
            .padding(.top, Space.s)
        }
    }

    static func per(_ per: String?) -> String {
        switch per {
        case "1h": "this hour"
        case "1d", "24h": "today"
        case "1m": "this minute"
        case let p?: "per \(p)"
        case nil: ""
        }
    }
}
