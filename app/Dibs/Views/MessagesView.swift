import SwiftUI

// The web page's Messages: every thread on the left (dibs's desk first, then
// each agent with its state), one conversation on the right with its box.
// Questions inside a thread keep their buttons. Picking an agent in the
// sidebar opens its thread.
struct MessagesView: View {
    @Environment(Store.self) private var store

    var body: some View {
        let threads = Self.ordered(store.threads, desk: store.threadList?.desk)
        let current = Self.current(threads, store: store)
        let unread = threads.reduce(0) { $0 + $1.unread }
        VStack(alignment: .leading, spacing: Space.xl) {
            PageHead(title: "Messages", summary: threads.isEmpty
                     ? "No threads yet. Agents start one with dibs say or dibs question."
                     : "\(threads.count == 1 ? "1 thread" : "\(threads.count) threads")\(unread > 0 ? ", \(unread) unread" : ""). A message reaches its agent with its next tool call.")
                .padding(.horizontal, 44)
            if !threads.isEmpty {
                // The panes get exactly what's left of the window and scroll inside it.
                GeometryReader { g in
                    HStack(alignment: .top, spacing: Space.l) {
                        ScrollView {
                            VStack(spacing: 2) {
                                // By place: dibs can list two threads under one name.
                                ForEach(Array(threads.enumerated()), id: \.offset) { _, t in threadRow(t, current: current) }
                            }
                        }
                        .scrollIndicators(.never)
                        .frame(width: 250)
                        if let t = current {
                            conversation(t)
                        }
                    }
                    .frame(width: g.size.width, height: g.size.height, alignment: .top)
                }
                .padding(.horizontal, 44)
                .padding(.bottom, Space.l)
            }
        }
        .padding(.top, 36)
        .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle("Messages")
        .navigationSubtitle(store.lastAction ?? "")
        .task(id: "\(current?.to ?? "")-\(current?.last ?? 0)") {
            if let current { await store.markRead(current) }
        }
    }

    // The desk first: it answers for dibs. Then as dibs lists them, newest first.
    static func ordered(_ threads: [AgentThread], desk: String?) -> [AgentThread] {
        threads.filter { Chat.isDesk($0, desk) } + threads.filter { !Chat.isDesk($0, desk) }
    }

    // The thread picked here, or the sidebar's agent's, or the first.
    static func current(_ threads: [AgentThread], store: Store) -> AgentThread? {
        if let who = store.chosen, let t = threads.first(where: { $0.agent == who || $0.to == who }) { return t }
        return threads.first { $0.to == store.replyTo } ?? threads.first
    }

    private func name(_ t: AgentThread) -> String {
        Chat.isDesk(t, store.threadList?.desk) ? "dibs" : store.threadName(t)
    }

    private func threadRow(_ t: AgentThread, current: AgentThread?) -> some View {
        let picked = t.to == current?.to && t.agentId == current?.agentId && t.last == current?.last
        let last = store.chat.last { $0.to == t.to }
        return Button {
            store.chosen = nil
            store.replyTo = t.to
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.s + 1) {
                    StateDot(kind: Self.dot(t))
                    Text(name(t))
                        .font(Typeface.name)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Spacer(minLength: Space.xs)
                    if t.unread > 0 {
                        CountPill(count: t.unread)
                    } else {
                        Text(Span.ago(Date.now.timeIntervalSince(Date(ms: t.last))))
                            .font(Typeface.small)
                            .foregroundStyle(Palette.ink3)
                            .fixedSize()
                    }
                }
                if let last {
                    Text("\(last.kind == .mine ? "You: " : "")\(last.text)")
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(1)
                        .padding(.leading, 17)
                }
            }
            .padding(.horizontal, Space.s + 2)
            .padding(.vertical, Space.s)
            .background(picked ? Palette.ink.opacity(0.07) : .clear, in: .rect(cornerRadius: 9, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    // The thread's agent as the sidebar shows it: running, waiting, posting, or gone.
    static func dot(_ t: AgentThread) -> StateDot.Kind {
        guard t.alive else { return .idle }
        if t.working?.hasPrefix("using ") == true { return .running }
        if t.working?.hasPrefix("waiting for ") == true { return .waiting }
        return .busy
    }

    private func conversation(_ t: AgentThread) -> some View {
        let items = store.chat.filter { $0.to == t.to }
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Text(name(t))
                    .font(Typeface.title)
                    .foregroundStyle(Palette.ink)
                Text(t.alive ? t.activity : "Not running; your messages wait for it")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, Space.l + 2)
            .padding(.vertical, Space.m + 2)
            Rectangle().fill(Palette.hairline).frame(height: 1)
            if items.isEmpty {
                Text("Nothing in this thread yet.")
                    .foregroundStyle(Palette.ink3)
                    .padding(Space.l + 2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ChatList(items: items)
                    .frame(maxHeight: .infinity)
            }
            Composer(to: t.to, name: name(t))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .card()
    }
}

struct ChatList: View {
    @Environment(Store.self) private var store
    let items: [ChatItem]

    var body: some View {
        let waiting = Chat.waiting(items)
        let history = items.filter { item in !waiting.contains { $0.id == item.id } }
        ScrollViewReader { scroller in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.m) {
                    ForEach(Array(history.enumerated()), id: \.element.id) { i, item in
                        if i == 0 || !Calendar.current.isDate(item.date, inSameDayAs: history[i - 1].date) {
                            Text(ChatList.day(item.date))
                                .font(Typeface.eyebrow)
                                .foregroundStyle(Palette.ink3)
                                .frame(maxWidth: .infinity)
                                .padding(.top, Space.s)
                        }
                        line(item)
                    }
                    if !waiting.isEmpty {
                        Eyebrow(text: waiting.count == 1 ? "Waiting on you" : "\(waiting.count) waiting on you")
                            .padding(.top, Space.m)
                        if store.notificationsOff { NotificationsOff() }
                        ForEach(waiting) { AskCard(item: $0) }
                    }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, Space.l + 2)
                .padding(.vertical, Space.l)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .defaultScrollAnchor(.bottom)
            .onChange(of: items.last?.id) { scroller.scrollTo("end", anchor: .bottom) }
        }
    }

    @ViewBuilder
    private func line(_ item: ChatItem) -> some View {
        switch item.kind {
        case .mine: MineLine(item: item)
        case .note: NoteLine(item: item)
        case .decided: DecidedLine(item: item)
        case .ask: AnsweredAsk(item: item)
        }
    }

    static func day(_ date: Date, now: Date = .now) -> String {
        let cal = Calendar.current
        if cal.isDateInToday(date) { return "Today" }
        if cal.isDateInYesterday(date) { return "Yesterday" }
        return date.formatted(.dateTime.weekday(.wide).month().day())
    }
}

// Picks the agent the box writes to. The whole line is the target, so the
// person never has to find a small reply button.
private struct Replying: ViewModifier {
    @Environment(Store.self) private var store
    let item: ChatItem

    // The thread picked is who the box writes to, so a line needs nothing more.
    func body(content: Content) -> some View { content }
}

// An agent telling the person something: the name, the words, nothing to do.
struct NoteLine: View {
    @Environment(Store.self) private var store
    let item: ChatItem

    var body: some View {
        HStack(alignment: .top, spacing: Space.s + 2) {
            ChatTile(item: item, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                    Text(store.chatName(item))
                        .font(Typeface.small.weight(.semibold))
                        .foregroundStyle(Palette.ink2)
                    Text(Format.clock(item.date))
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                }
                Text(item.text)
                    .font(Typeface.body)
                    .foregroundStyle(Palette.ink2)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .copyable(item.text)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .modifier(Replying(item: item))
    }
}

// A two-way question an agent settled itself: one small line, on the record.
struct DecidedLine: View {
    @Environment(Store.self) private var store
    let item: ChatItem

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "checkmark")
                .font(Typeface.sized(9, .bold))
                .foregroundStyle(Palette.ink3)
            // What it chose and why; the question it settled is on hover.
            Text("\(Text(store.chatName(item)).fontWeight(.semibold)) decided: \(item.chose ?? item.text)\(item.why.map { ", because \($0)" } ?? "")")
                .font(Typeface.small)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
                .copyable(item.text)
                .help(item.chose == nil ? "" : item.text)
            Spacer(minLength: Space.s)
        }
        .padding(.leading, 34)
        .modifier(Replying(item: item))
    }
}

// What the person said or answered, or an agent said in their place.
struct MineLine: View {
    @Environment(Store.self) private var store
    let item: ChatItem

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Text(item.text)
                .font(Typeface.lede)
                .foregroundStyle(Palette.ink)
                .lineSpacing(2.5)
                .fixedSize(horizontal: false, vertical: true)
                .copyable(item.text)
                .padding(.horizontal, 13)
                .padding(.vertical, 9)
                .background(Palette.mine, in: .rect(cornerRadius: 14, style: .continuous))
            Text((item.by.map { "Sent by \(store.displayName($0)), not you \u{00B7} \(Format.clock(item.date))" } ?? Format.clock(item.date))
                 + (item.queued ? " \u{00B7} not delivered yet" : ""))
                .font(Typeface.small)
                .foregroundStyle(item.by == nil ? Palette.ink3 : Palette.accentInk)
                .padding(.horizontal, 4)
        }
        .opacity(item.by == nil ? 1 : 0.75)
        .frame(maxWidth: 520, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

// A question the person already settled, or one that expired: what was asked.
struct AnsweredAsk: View {
    @Environment(Store.self) private var store
    let item: ChatItem

    var body: some View {
        let state = item.question?.state
        HStack(alignment: .top, spacing: Space.s + 2) {
            ChatTile(item: item, size: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text("\(store.chatName(item)) asked\(state == "dismissed" ? " (you said not now)" : state == "expired" ? " (nobody answered in time)" : "")")
                    .font(Typeface.small.weight(.semibold))
                    .foregroundStyle(Palette.ink2)
                Text(item.text)
                    .font(Typeface.lede)
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .copyable(item.text)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 9)
                    .background(Palette.surface, in: .rect(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hairline))
            }
            Spacer(minLength: 0)
        }
        .modifier(Replying(item: item))
    }
}

// A one-way question waiting on the person, as a ticket, in the web page's
// layout: who asked and when, the question, why, what can't be undone, the
// options with the agent's pick in red, then the person's own words.
struct AskCard: View {
    @Environment(Store.self) private var store
    let item: ChatItem
    @State private var reply = ""

    var body: some View {
        let q = item.question
        let id = q?.id ?? ""
        let full = store.questions?.questions.first { $0.id == id }
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s + 2) {
                Text(store.chatName(item))
                    .font(Typeface.headline)
                    .foregroundStyle(Palette.ink)
                Text(meta(full))
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                if full?.held == true { Pill("held for your hours", tone: .faint) }
            }
            Text(item.text)
                .font(Typeface.question.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
                .copyable(item.text)
            if let why = q?.why {
                Text(why)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let cant = q?.cantUndo {
                Text("Can't be undone: \(cant)")
                    .font(Typeface.body.weight(.medium))
                    .foregroundStyle(Palette.accentInk)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: Space.m) {
                Flow(spacing: Space.s) {
                    ForEach(q?.options ?? [], id: \.self) { option in
                        Button(option == q?.recommend ? "\(option) (recommended)" : option) {
                            Task { await store.answer(questionId: id, option, agent: item.agent) }
                        }
                        .buttonStyle(InkButton(prominent: option == q?.recommend))
                    }
                    Button("Not now") { Task { await store.dismiss(questionId: id, agent: item.agent) } }
                        .buttonStyle(.plain)
                        .font(Typeface.button)
                        .foregroundStyle(Palette.ink3)
                        .padding(.vertical, 6)
                        .help("Ends the agent's wait without an answer. Nothing is decided for it.")
                }
                HStack(spacing: Space.s) {
                    TextField(q.map { $0.options.isEmpty } == false ? "Or answer in your own words" : "Your answer", text: $reply)
                        .textFieldStyle(.plain)
                        .field()
                        .onSubmit(send)
                    Button("Send", action: send)
                        .buttonStyle(InkButton())
                        .disabled(reply.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .padding(.top, Space.xs)
            .disabled(store.running.contains("q-\(id)"))
        }
        .padding(.horizontal, Space.xl + 2)
        .padding(.vertical, Space.l + 2)
        .frame(maxWidth: 760, alignment: .leading)
        .background {
            TicketShape(corner: 12, notch: 8)
                .fill(Palette.surface)
                .shadow(color: .black.opacity(0.05), radius: 1, y: 1)
                .shadow(color: .black.opacity(0.04), radius: 10, y: 4)
        }
        .overlay(TicketShape(corner: 12, notch: 8).stroke(Palette.hairline))
    }

    // "asked 10m ago, urgent, waiting on you now": the web page's words.
    private func meta(_ q: Question?) -> String {
        var out = "asked \(Span.ago(Date.now.timeIntervalSince(item.date)))"
        if let p = q?.prio, p != .normal { out += ", \(p.rawValue)" }
        if q?.waiting == true { out += ", waiting on you now" }
        return out
    }

    private func send() {
        let text = reply
        guard let id = item.question?.id, !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        Task {
            await store.answer(questionId: id, text, agent: item.agent)
            reply = ""
        }
    }
}

// The box under a conversation: what the person types goes to that thread's
// agent with its next tool call. Return sends, Shift-Return starts a line.
struct Composer: View {
    @Environment(Store.self) private var store
    let to: String
    let name: String
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        let ready = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        HStack(alignment: .bottom, spacing: Space.s) {
            TextField("Message \(name)", text: $draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(Typeface.lede)
                .lineLimit(2...6)
                .focused($focused)
                .padding(.horizontal, Space.m)
                .padding(.vertical, Space.s + 1)
                .background(Palette.sunken, in: .rect(cornerRadius: 10, style: .continuous))
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.shift) { return .ignored }
                    send()
                    return .handled
                }
            Button("Send", action: send)
                .buttonStyle(InkButton(prominent: ready))
                .disabled(!ready || store.running.contains("tell-\(to)"))
                .padding(.bottom, 3)
        }
        .padding(Space.m + 2)
        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        store.replyTo = to
        Task {
            if await store.say(text) { draft = "" }
        }
    }
}

// An agent's tile, or for the desk, dibs's own: the app's red.
struct ChatTile: View {
    let item: ChatItem
    var size: CGFloat = 24

    var body: some View {
        if item.desk {
            Text("d")
                .font(Typeface.sized(size * 0.5, .heavy))
                .foregroundStyle(Palette.onAccent)
                .frame(width: size, height: size)
                .background(Palette.ticket, in: Circle())
                .accessibilityHidden(true)
        } else {
            AgentTile(name: item.agent, size: size)
        }
    }
}
