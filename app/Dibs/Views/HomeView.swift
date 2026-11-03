import SwiftUI

// Now, the web page's first screen too: does anything need the person, what
// runs and waits, who holds which files, and how the day went. With an agent
// picked in the sidebar, only that agent's.
struct HomeView: View {
    @Environment(Store.self) private var store

    var body: some View {
        Group {
            if store.board == nil, let error = store.boardError {
                CLIProblemView(error: error)
            } else {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    content(now: context.date).page()
                }
            }
        }
        .navigationTitle("Now")
        .navigationSubtitle(store.lastAction ?? "")
    }

    private func content(now: Date) -> some View {
        let chosen = store.chosen
        let needs = store.needs.filter { need in chosen == nil || need.row?.who == chosen }
        let rows = store.rows.filter { chosen == nil || $0.who == chosen }
        let posts = (store.progress ?? []).filter { chosen == nil || $0.who == chosen }
        let tasks = ProgressBoard.agents(posts).flatMap(\.tasks)
        let calm = needs.isEmpty && store.asks.isEmpty
        let files = store.counters.fileLocks.filter { !$0.isFree }
            .map { c in
                var c = c
                c.serving = c.serving.filter { chosen == nil || $0.who == chosen }
                c.waiting = c.waiting.filter { chosen == nil || $0.who == chosen }
                return c
            }
            .filter { !$0.isFree }
        return VStack(alignment: .leading, spacing: Space.xxl) {
            VStack(alignment: .leading, spacing: Space.m) {
                PageHead(title: chosen.map(store.displayName) ?? store.status.headline, tint: chosen != nil || calm ? Palette.ink : Palette.accentInk) {
                    summary(rows, now: now)
                }
                StaleNote()
                if chosen == nil { AsksNote() }
                if let hold = store.board?.hold {
                    // The reason without dibs's numbers, which are on hover.
                    let short = hold.components(separatedBy: " (").first ?? hold
                    Text("Nothing new starts right now: \(short.hasSuffix(".") ? String(short.dropLast()) : short). Jobs already running carry on.")
                        .font(Typeface.body)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Palette.yellow.opacity(0.16), in: .rect(cornerRadius: 10, style: .continuous))
                        .help(hold)
                }
                if let who = chosen, store.ownerActions { CapRow(who: who) }
            }
            let alerts = store.dibsAlerts.filter { chosen == nil || $0.who == nil || $0.who == chosen }
            if !alerts.isEmpty {
                let open = alerts.filter(\.open).count
                PageSection("Alerts", note: open == 0 ? "All resolved" : "\(open) open") {
                    VStack(alignment: .leading, spacing: Space.m) {
                        ForEach(alerts) { AlertCard(alert: $0) }
                    }
                }
            }
            if !needs.isEmpty {
                PageSection("Needs you", note: needs.count == 1 ? "1 thing" : "\(needs.count) things") {
                    VStack(alignment: .leading, spacing: Space.m) {
                        ForEach(needs) { need in
                            NeedCard(need: need)
                                .transition(.asymmetric(insertion: .opacity, removal: .opacity.combined(with: .move(edge: .leading))))
                        }
                    }
                }
            }
            PageSection("Jobs", note: JobsTimeline.note(rows: rows, tasks: tasks, now: now)) {
                JobsTimeline(rows: rows, tasks: tasks, now: now)
            }
            if !files.isEmpty {
                let held = FileLocks.unique(files.flatMap(\.serving)).count, waiting = FileLocks.unique(files.flatMap(\.waiting)).count
                PageSection("File locks", note: "\(held == 1 ? "1 lease" : "\(held) leases") held\(waiting > 0 ? ", \(waiting) waiting" : "")") {
                    FileLockList(counters: files, now: now)
                }
            }
            PageSection("Today", note: "Agents running and waiting at the busiest point of each hour") {
                TodayChart()
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.9), value: needs.map(\.id))
    }

    // One plain sentence on the line, the web page's: what runs, what waits, who goes next.
    private func summary(_ rows: [Row], now: Date) -> Text {
        let running = rows.filter(\.held).count, waiting = rows.count - running
        let total = store.agentRows.count
        let working = store.agentRows.filter { $0.state != .idle && (store.chosen == nil || $0.who == store.chosen) }.count
        let first: String
        if running + waiting > 0 {
            first = "\(running) job\(running == 1 ? "" : "s") running\(waiting > 0 ? " and \(waiting) waiting" : "")\(store.chosen == nil ? ", \(working) of \(total) agents busy" : "")."
        } else {
            first = store.chosen != nil ? "No jobs right now." : "No jobs right now\(working > 0 ? "; \(working) of \(total) agents posting" : "")."
        }
        let next = rows.filter { !$0.held }.sorted { ($0.startsAt ?? .distantFuture, $0.place ?? 0) < ($1.startsAt ?? .distantFuture, $1.place ?? 0) }.first
        let soon = rows.filter { $0.endsAt != nil }.sorted { $0.endsAt! < $1.endsAt! }.first
        if let next {
            return Text("\(first) Next: \(Text(store.displayName(next.who)).fontWeight(.semibold).foregroundStyle(Palette.ink)) on \(next.res.joined(separator: ", "))\(next.startsAt.map { " around \(Format.clock($0))" } ?? "").")
        }
        if let soon, let end = soon.endsAt {
            return Text("\(first) First to finish: \(Text(store.displayName(soon.who)).fontWeight(.semibold).foregroundStyle(Palette.ink)) around \(Format.clock(end)).")
        }
        return Text(first)
    }
}

// One of dibs's alerts: a dot for how bad, what's wrong, why, and the one
// fix. Once resolved it stays a quiet line saying when, for a couple of hours.
struct AlertCard: View {
    @Environment(Store.self) private var store
    let alert: DibsAlert

    var body: some View {
        if let gone = alert.resolvedDate {
            HStack(alignment: .firstTextBaseline, spacing: Space.s + 2) {
                StateDot(kind: .busy)
                Text("\(alert.title).").foregroundStyle(Palette.ink3).lineLimit(2)
                Spacer(minLength: Space.m)
                Text("\(alert.dismissed == true ? "Dismissed" : "Resolved") \(Format.clock(gone))")
                    .font(Typeface.small).foregroundStyle(Palette.ink3).fixedSize()
            }
            .padding(.horizontal, Space.l + 2)
        } else {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s + 2) {
                    StateDot(kind: alert.level == "urgent" ? .running : alert.level == "warn" ? .waiting : .idle)
                    Text(alert.title)
                        .font(Typeface.headline)
                        .foregroundStyle(Palette.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: Space.m)
                    Text("since \(Format.clock(alert.sinceDate))")
                        .font(Typeface.small).foregroundStyle(Palette.ink3).fixedSize()
                }
                let more = [alert.why.map { "Why: \($0.prefix(1).uppercased())\($0.dropFirst())" }, alert.detail].compactMap { $0 }.joined(separator: " ")
                if !more.isEmpty {
                    Text(more).foregroundStyle(Palette.ink2).fixedSize(horizontal: false, vertical: true).copyable(more)
                }
                Text("\(Text("Fix: ").fontWeight(.semibold).foregroundStyle(Palette.ink))\(alert.fix)")
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                    .copyable(alert.fix)
                HStack(spacing: Space.s) {
                    Button("Dismiss") { Task { await store.dismiss(alert) } }
                        .buttonStyle(InkButton())
                        .disabled(store.running.contains("alert-\(alert.id)"))
                        .help("Clears it for a day. If the cause is still there after that, it comes back.")
                    if alert.job != nil {
                        Button("See the queue") { store.section = .queues }
                            .buttonStyle(.plain)
                            .font(Typeface.small)
                            .foregroundStyle(Palette.ink2)
                    }
                }
                .padding(.top, 2)
            }
            .padding(.horizontal, Space.l + 2)
            .padding(.vertical, Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }
}

// An agent picked: its slowdown, which the person sets with dibs cap.
struct CapRow: View {
    @Environment(Store.self) private var store
    let who: String

    var body: some View {
        let cap = store.board?.caps[who]?.prio
        HStack(spacing: Space.m) {
            Text("Hold \(store.displayName(who)) back:")
                .font(Typeface.body.weight(.medium))
                .foregroundStyle(Palette.ink)
            Picker("Hold back", selection: Binding(get: { cap ?? "off" }, set: { p in
                Task { await store.cap(who, at: p == "off" ? nil : Prio(p)) }
            })) {
                Text("Runs normally").tag("off")
                Text("Behind others").tag("low")
                Text("Only when idle").tag("idle")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .disabled(store.running.contains("cap-\(who)"))
            Text("Caps every job it runs from now on. dibs cap, logged as you.")
                .font(Typeface.small)
                .foregroundStyle(Palette.ink3)
        }
    }
}

// File leases from dibs hold 'files:...', the web page's list: who holds which
// files and for how long, then who waits for them. A row opens in Queues.
struct FileLockList: View {
    @Environment(Store.self) private var store
    let counters: [Counter]
    let now: Date

    var body: some View {
        let rows = FileLocks.unique(counters.flatMap(\.serving)) + FileLocks.unique(counters.flatMap(\.waiting))
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
                if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                let files = row.res.compactMap(Counter.fileName)
                Button {
                    store.sheetRow = row.id
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                        Text("\(Text(store.displayName(row.who)).fontWeight(.semibold).foregroundStyle(Palette.ink)) \(row.held ? "holds" : "waits for") \(Text(files.count == 1 ? files[0] : "\(files.first ?? "") and \(files.count - 1) more").font(.system(size: 12, design: .monospaced)))")
                            .foregroundStyle(Palette.ink2)
                            .lineLimit(2)
                        Spacer(minLength: Space.m)
                        Text(row.held ? "for \(ProgressTask.short(now.timeIntervalSince(row.since)))" : "#\(row.place ?? 1) in line")
                            .font(Typeface.small.weight(.medium))
                            .foregroundStyle(Palette.ink2)
                    }
                    .padding(.horizontal, Space.l + 2)
                    .padding(.vertical, Space.m)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .help(files.joined(separator: "\n"))
            }
        }
        .card()
    }
}

// Questions have their own screen. Now says how many are waiting and takes
// the person there, in the web page's words.
struct AsksNote: View {
    @Environment(Store.self) private var store

    var body: some View {
        let asks = store.asks
        if let first = asks.first {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Text(asks.count == 1 ? "1 question from \(store.chatName(first)) is waiting for you: \(first.text)"
                     : "\(asks.count) questions from agents are waiting for you, the first from \(store.chatName(first)).")
                    .font(Typeface.body)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(2)
                Spacer(minLength: Space.m)
                Button("Answer") { store.section = .questions }
                    .buttonStyle(InkButton(prominent: true))
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            .background(Palette.yellow.opacity(0.16), in: .rect(cornerRadius: 10, style: .continuous))
        }
    }
}

// Said when the screen is showing an old board: dibs stopped answering, so
// "Nothing needs you" may no longer be true.
struct StaleNote: View {
    @Environment(Store.self) private var store

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            if let f = store.freshness(now: context.date), f.stale {
                Label(f.text, systemImage: "exclamationmark.triangle.fill")
                    .font(Typeface.body.weight(.medium))
                    .foregroundStyle(Palette.accentInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// The icon's ticket, drawn small and calm, next to "Nothing needs you."
struct CalmTicket: View {
    var body: some View {
        ZStack {
            TicketShape(corner: 7, notch: 7).fill(Palette.yellow)
            Perforation(color: Palette.canvas.opacity(0.9)).offset(x: -9)
            // The logo's short queue, in its red.
            VStack(alignment: .leading, spacing: 3) {
                ForEach([20.0, 15, 10], id: \.self) { w in
                    Capsule().fill(Palette.ticket).frame(width: w, height: 3.5)
                }
            }
            .frame(width: 22, alignment: .leading)
            .offset(x: 7)
        }
        .frame(width: 58, height: 36)
        .accessibilityHidden(true)
    }
}

// A thing that needs the person: who it's from, what it says, what they can do.
struct NeedCard: View {
    let need: Need

    var body: some View {
        NeedBody(need: need)
            .padding(.horizontal, Space.l + 2)
            .padding(.vertical, Space.l)
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
    }
}

extension Need {
    // The agent it's about, for its name in bold.
    func who(in threads: [AgentThread]) -> String? {
        if let q = question { return q.agent ?? q.who }
        if let row { return row.who }
        return thread.flatMap { to in threads.first { $0.to == to }?.name }
    }
}

// What a need says and the one or two things the person can do about it.
struct NeedBody: View {
    @Environment(Store.self) private var store
    let need: Need
    // The menu bar's version: no typing, shorter text.
    var compact = false
    @State private var reply = ""
    @State private var confirmStop = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline) {
                title
                Spacer(minLength: Space.m)
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(Self.ago(need.since, now: context.date))
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .monospacedDigit()
                }
            }
            Text(need.detail)
                .font(need.kind == .question && !compact ? Typeface.question : Typeface.body)
                .foregroundStyle(need.kind == .question || need.kind == .note ? Palette.ink : Palette.ink2)
                .lineLimit(compact ? 3 : nil)
                .fixedSize(horizontal: false, vertical: true)
                .copyable(need.detail)
            actions
                .padding(.top, 2)
                .disabled(store.running.contains(need.question.map { "q-\($0.id)" } ?? need.row?.id ?? ""))
        }
        .confirmationDialog("Stop \(need.row.map { store.rowName($0) } ?? "it")?", isPresented: $confirmStop) {
            Button("Yes, stop it", role: .destructive) {
                if let row = need.row { Task { await store.stop(row) } }
            }
        } message: {
            Text(need.row.map { "\(store.rowName($0))'s job ends right away, and the agent is told you stopped it. The next in the queue starts." } ?? "")
        }
    }

    // "web-app is asking": the agent's name in ink, the rest quiet.
    private var title: some View {
        // The agent as the title names it: its session's title, or its handle,
        // and a subagent's own name after it.
        let who = need.row.map { store.rowName($0) } ?? need.who(in: store.threads).map { store.displayName($0) }
        let rest = who.flatMap { need.title.hasPrefix($0) ? String(need.title.dropFirst($0.count)) : nil }
        return Text("\(Text(who != nil && rest != nil ? who! : need.title).foregroundStyle(Palette.ink))\(Text(rest ?? "").foregroundStyle(Palette.ink2))")
            .font(Typeface.headline)
    }

    @ViewBuilder
    private var actions: some View {
        if let q = need.question {
            // On one line when there's room; options above the reply when there isn't.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: Space.s) {
                    options(q)
                    reply(q)
                }
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack(spacing: Space.s) { options(q) }
                    HStack(spacing: Space.s) { reply(q) }
                }
            }
        } else if need.kind == .note, let to = need.thread {
            HStack(spacing: Space.s) {
                Button("Reply") { open(to) }
                    .buttonStyle(InkButton(prominent: true))
                Button("Mark as read") {
                    if let t = store.threads.first(where: { $0.to == to }) { Task { await store.markRead(t) } }
                }
                .buttonStyle(InkButton())
            }
        } else if need.kind == .disk {
            StorageButton()
        } else if need.kind == .idle, let row = need.row {
            HStack(spacing: Space.s) {
                if store.ownerActions {
                    Button("Stop it\u{2026}") { confirmStop = true }
                        .buttonStyle(InkButton(prominent: true))
                }
                Button("Leave it") { store.gotIt.insert(need.id) }
                    .buttonStyle(InkButton(prominent: !store.ownerActions))
                    .help("Clears this. \(store.rowName(row)) keeps its turn.")
                if !compact { seeQueue }
            }
        } else if need.row == nil {
            Button("See the queue") { openQueue() }
                .buttonStyle(InkButton(prominent: true))
        } else if let row = need.row {
            HStack(spacing: Space.s) {
                Button("Got it") { store.gotIt.insert(need.id) }
                    .buttonStyle(InkButton(prominent: true))
                    .help("Clears this. It starts by itself when its turn comes.")
                // Going first can't help a wait on a file (the other agent is
                // mid-change) or on the Mac itself (memory, disk, load).
                if store.ownerActions, row.prio != .urgent, need.line?.hasPrefix("files:") != true, !Needs.waitsOnMac(row) {
                    Button("Let it go first") { Task { await store.boost(row, to: .urgent) } }
                        .buttonStyle(InkButton())
                }
                if !compact { seeQueue }
            }
        }
    }

    private var seeQueue: some View {
        Button("See the queue") { openQueue() }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.ink2)
    }

    // Queues, opened at the line this card is about.
    private func openQueue() {
        store.focusRes = need.line
        store.openRequest = .queues
    }

    @ViewBuilder
    private func options(_ q: Question) -> some View {
        ForEach(q.options ?? [], id: \.self) { option in
            Button(option == q.recommend ? "\(option) (recommended)" : option) { Task { await store.answer(q, option) } }
                .buttonStyle(InkButton(prominent: option == q.recommend))
        }
    }

    @ViewBuilder
    private func reply(_ q: Question) -> some View {
        if compact {
            if q.options == nil {
                Button("Answer\u{2026}") { store.openRequest = .questions }
                    .buttonStyle(InkButton(prominent: true))
            }
        } else {
            TextField(q.options == nil ? "Your answer" : "Or say something else", text: $reply)
                .textFieldStyle(.plain)
                .field()
                .frame(minWidth: 170, maxWidth: 260)
                .onSubmit { send(q) }
            if !reply.trimmingCharacters(in: .whitespaces).isEmpty {
                Button("Send") { send(q) }
                    .buttonStyle(InkButton(prominent: true))
            }
        }
        Spacer(minLength: Space.s)
        if !compact, let to = need.thread {
            Button("Conversation") { open(to) }
                .buttonStyle(.plain)
                .foregroundStyle(Palette.ink2)
                .fixedSize()
        }
        Button("Not now") { Task { await store.dismiss(q) } }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.ink3)
            .fixedSize()
            .help("Ends the agent's wait without an answer. Nothing is decided for it.")
    }

    private func open(_ thread: String) {
        store.replyTo = thread
        store.chosen = nil
        store.openRequest = .messages
    }

    private func send(_ q: Question) {
        let text = reply
        Task {
            await store.answer(q, text)
            reply = ""
        }
    }

    static func ago(_ since: Date, now: Date) -> String {
        let t = now.timeIntervalSince(since)
        return t < 60 ? "just now" : "\(Plain.about(t).replacingOccurrences(of: "about ", with: "")) ago"
    }
}

// Where a person frees disk space on a Mac.
struct StorageButton: View {
    var prominent = true

    var body: some View {
        Button("Open Storage settings") {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.settings.Storage")!)
        }
        .buttonStyle(InkButton(prominent: prominent))
    }
}
