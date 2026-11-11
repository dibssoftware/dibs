import SwiftUI

// The web page's Messages. Questions waiting on the person sit above
// everything. Below, one conversation per agent on the left (dibs's desk
// first, each agent's subagents under it), then two quiet streams: what agents
// tell each other, and what dibs tells agents. Neither is the person's
// conversation and neither counts as unread. Picking an agent in the sidebar
// opens its conversation, even an empty one.
struct MessagesView: View {
    @Environment(Store.self) private var store
    // nil: a conversation, the one store.replyTo or store.chosen names.
    @State private var stream: Stream?
    // Between agents, narrowed to one agent from its conversation.
    @State private var streamFor: String?

    enum Stream: Hashable { case between, dibs, new }

    var body: some View {
        let desk = store.threadList?.desk
        let talking = Set(store.chat.map(\.to))
        let threads = Self.ordered(store.threads.filter { Chat.isDesk($0, desk) || talking.contains($0.to) }, desk: desk)
        let current = stream == nil ? Self.current(threads, all: store.threads, store: store) : nil
        let asks = store.asks
        VStack(alignment: .leading, spacing: Space.xl) {
            PageHead(title: "Messages", summary: summary(asks, threads))
                .padding(.horizontal, 44)
            if !asks.isEmpty {
                VStack(alignment: .leading, spacing: Space.m) {
                    Text(asks.count == 1 ? "Waiting on you" : "\(asks.count) waiting on you")
                        .font(Typeface.section)
                        .foregroundStyle(Palette.ink)
                    if store.notificationsOff { NotificationsOff() }
                    ForEach(asks) { AskCard(item: $0) }
                }
                .padding(.horizontal, 44)
            }
            // The panes take what's left of the window and scroll inside it.
            HStack(alignment: .top, spacing: Space.l) {
                list(threads, current: current)
                    .frame(width: 250)
                Group {
                    switch stream {
                    case .between: BetweenPane(only: $streamFor)
                    case .dibs: FromDibsPane()
                    case .new: NewMessagePane()
                    case nil:
                        if let t = current { conversation(t) } else { Color.clear }
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .card()
            }
            .frame(maxWidth: .infinity, minHeight: 320, maxHeight: .infinity, alignment: .top)
            .padding(.horizontal, 44)
            .padding(.bottom, Space.l)
        }
        .padding(.top, 36)
        .frame(maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .topLeading)
        .navigationTitle("Messages")
        .navigationSubtitle(store.lastAction ?? "")
        .task(id: "\(current?.to ?? "")-\(current?.last ?? 0)") {
            if let current { await store.markRead(current) }
        }
        .onChange(of: store.chosen) { if store.chosen != nil { stream = nil } }
    }

    private func summary(_ asks: [ChatItem], _ threads: [AgentThread]) -> String {
        let askers = Set(asks.map(\.agent))
        if askers.count == 1, let a = asks.first { return "\(store.chatName(a)) is waiting on your answer." }
        if askers.count > 1 { return "\(askers.count) agents are waiting on your answers." }
        let unread = threads.reduce(0) { $0 + $1.unread }
        return unread > 0 ? "\(unread == 1 ? "1 unread message" : "\(unread) unread messages") from agents." : "Nothing is waiting on you."
    }

    // The desk first, then each agent by its latest word, its subagents under it.
    static func ordered(_ threads: [AgentThread], desk: String?) -> [AgentThread] {
        let mains = threads.filter { !$0.isSub }.sorted { (Chat.isDesk($0, desk) ? 1 : 0, $0.last) > (Chat.isDesk($1, desk) ? 1 : 0, $1.last) }
        var out: [AgentThread] = []
        for m in mains { out.append(m); out += threads.filter { $0.isSub && $0.agent == m.agent }.sorted { $0.last > $1.last } }
        return out + threads.filter { t in t.isSub && !out.contains { $0.to == t.to } }
    }

    // The thread picked here, or the sidebar's agent's (with or without a thread yet), or the first.
    static func current(_ threads: [AgentThread], all: [AgentThread], store: Store) -> AgentThread? {
        if let who = store.chosen {
            return all.first { $0.agent == who || $0.to == who }
                ?? AgentThread(agent: who, to: who, alive: true, working: nil, unread: 0, last: 0, messages: [])
        }
        if let to = store.replyTo, let t = all.first(where: { $0.to == to }) { return t }
        return threads.first
    }

    private func name(_ t: AgentThread) -> String {
        Chat.isDesk(t, store.threadList?.desk) ? "dibs" : store.threadName(t)
    }

    private func list(_ threads: [AgentThread], current: AgentThread?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                Button { pick(.new) } label: {
                    Text("New message")
                        .font(Typeface.name)
                        .foregroundStyle(Palette.ink)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, Space.s + 1)
                        .background(stream == .new ? Palette.ink.opacity(0.09) : Palette.sunken, in: .rect(cornerRadius: 9, style: .continuous))
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .padding(.bottom, Space.s)
                // By place: dibs can list two threads under one name.
                ForEach(Array(threads.enumerated()), id: \.offset) { _, t in
                    threadRow(t, picked: stream == nil && t.to == current?.to, nested: t.isSub && threads.contains { !$0.isSub && $0.agent == t.agent })
                }
                Rectangle().fill(Palette.hairline).frame(height: 1).padding(.vertical, Space.s + 2).padding(.horizontal, 4)
                streamRow(.between, "Between agents", store.threadList?.between ?? []) { "\($0.from ?? "an agent") to \($0.to): \($0.text)" }
                streamRow(.dibs, "From dibs", store.threadList?.fromDibs ?? []) { "To \($0.to): \($0.text)" }
            }
        }
        .scrollIndicators(.never)
    }

    private func pick(_ s: Stream?) {
        store.chosen = nil
        streamFor = nil
        stream = s
    }

    private func threadRow(_ t: AgentThread, picked: Bool, nested: Bool) -> some View {
        let last = store.chat.last { $0.to == t.to }
        return Button {
            pick(nil)
            store.replyTo = t.to
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.s + 1) {
                    StateDot(kind: t.reach.hears ? .busy : .idle)
                    Text(nested ? (t.label ?? t.to) : name(t))
                        .font(nested ? Typeface.body : Typeface.name)
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
                Text(last.map { "\($0.kind == .mine ? "You: " : "")\($0.text)" } ?? t.reach.short)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
                    .padding(.leading, 17)
            }
            .padding(.horizontal, Space.s + 2)
            .padding(.vertical, nested ? Space.xs + 2 : Space.s)
            .background(picked ? Palette.ink.opacity(0.07) : .clear, in: .rect(cornerRadius: 9, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .padding(.leading, nested ? 18 : 0)
    }

    // The two streams nobody has to read: no red, a plain count.
    private func streamRow(_ s: Stream, _ title: String, _ items: [StreamItem], line: @escaping (StreamItem) -> String) -> some View {
        Button { pick(s) } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: Space.s + 1) {
                    Text(title)
                        .font(Typeface.body.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                    Spacer(minLength: Space.xs)
                    if !items.isEmpty {
                        Text("\(items.count)")
                            .font(Typeface.small)
                            .foregroundStyle(Palette.ink3)
                    }
                }
                Text(items.last.map(line) ?? "Nothing yet")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
            }
            .padding(.horizontal, Space.s + 2)
            .padding(.vertical, Space.s)
            .background(stream == s ? Palette.ink.opacity(0.07) : .clear, in: .rect(cornerRadius: 9, style: .continuous))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func conversation(_ t: AgentThread) -> some View {
        let items = store.chat.filter { $0.to == t.to }
        let desk = Chat.isDesk(t, store.threadList?.desk)
        let others = (store.threadList?.between ?? []).filter { $0.to == t.to || $0.from == t.to || $0.from == t.agent }.count
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: Space.m) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(name(t))
                        .font(Typeface.title)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Text(desk ? "dibs answers about the machine and the agents" : t.reach.sentence)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(2)
                }
                Spacer()
                if others > 0 {
                    Button(others == 1 ? "1 message with other agents" : "\(others) messages with other agents") {
                        stream = .between
                        streamFor = t.to
                    }
                    .buttonStyle(.link)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink2)
                }
            }
            .padding(.horizontal, Space.l + 2)
            .padding(.vertical, Space.m + 2)
            Rectangle().fill(Palette.hairline).frame(height: 1)
            if items.isEmpty {
                Text("Nothing between you and \(name(t)) yet.")
                    .foregroundStyle(Palette.ink3)
                    .padding(Space.l + 2)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ChatList(items: items)
                    .frame(maxHeight: .infinity)
            }
            Composer(to: t.to, name: name(t), reach: desk ? nil : t.reach)
        }
    }
}

// The head of a stream pane: its name and what it is.
private struct StreamHead: View {
    let title: String
    let note: String
    var trailing: AnyView? = nil

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Text(title)
                    .font(Typeface.title)
                    .foregroundStyle(Palette.ink)
                Text(note)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                trailing
            }
            .padding(.horizontal, Space.l + 2)
            .padding(.vertical, Space.m + 2)
            Rectangle().fill(Palette.hairline).frame(height: 1)
        }
    }
}

// One line of a stream: who to whom and when, the words (four lines until
// clicked), and whether it reached the agent.
private struct StreamLine: View {
    let head: Text
    let text: String
    let status: String?
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            head
                .font(Typeface.small)
                .foregroundStyle(Palette.ink3)
            Text(text)
                .font(Typeface.body)
                .foregroundStyle(Palette.ink2)
                .lineLimit(open ? nil : 4)
                .fixedSize(horizontal: false, vertical: true)
                .copyable(text)
                .onTapGesture { open.toggle() }
                .accessibilityAddTraits(.isButton)
            if let status {
                Text(status)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
            }
        }
        .padding(.vertical, Space.s + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// What agents tell each other with dibs tell. The person reads it if they
// want to; nothing in it waits on them.
private struct BetweenPane: View {
    @Environment(Store.self) private var store
    @Binding var only: String?

    var body: some View {
        let reach = Dictionary(store.threads.map { ($0.to, $0.reach) }, uniquingKeysWith: { a, _ in a })
        let all = store.threadList?.between ?? []
        let items = all.filter { m in only.map { m.from == $0 || m.to == $0 || m.to.hasPrefix("\($0)/") } ?? true }
        VStack(spacing: 0) {
            StreamHead(title: "Between agents", note: "What agents tell each other. Nothing here needs you.",
                       trailing: only.map { who in AnyView(Button("Only \(store.displayName(who)). Show all") { only = nil }.buttonStyle(.link).font(Typeface.small)) })
            StreamList(empty: "No agent has messaged another this week.", count: items.count) {
                ForEach(items) { m in
                    StreamLine(head: Text("\(Text(store.displayName(m.from ?? "an agent")).fontWeight(.semibold)) to \(Text(store.displayName(m.to)).fontWeight(.semibold)), \(Span.ago(Date.now.timeIntervalSince(m.date)))"),
                               text: m.text,
                               status: Reach.words(state: m.state, deliveredAt: m.deliveredAt, via: m.via, reach: reach[m.to] ?? .working))
                }
            }
        }
    }
}

// What dibs tells agents about their jobs: notices, and the notes it leaves
// in an agent's name (how a dibs later run ended).
private struct FromDibsPane: View {
    @Environment(Store.self) private var store

    var body: some View {
        let items = store.threadList?.fromDibs ?? []
        VStack(spacing: 0) {
            StreamHead(title: "From dibs", note: "What dibs tells agents about their jobs. Nothing here needs you.")
            StreamList(empty: "dibs hasn't told any agent anything this week.", count: items.count) {
                ForEach(items) { m in
                    StreamLine(head: Text("To \(Text(store.displayName(m.to)).fontWeight(.semibold)), \(Span.ago(Date.now.timeIntervalSince(m.date)))"),
                               text: m.text,
                               status: m.kind != "notice" ? nil : m.state == "expired" ? "Never reached it: it stopped mattering after an hour."
                                   : Reach.words(state: m.state, deliveredAt: m.deliveredAt, via: m.via, reach: .working))
                }
            }
        }
    }
}

// A stream's lines, newest at the bottom like a conversation, hairlines between.
private struct StreamList<Content: View>: View {
    let empty: String
    let count: Int
    @ViewBuilder let content: Content

    var body: some View {
        if count == 0 {
            Text(empty)
                .foregroundStyle(Palette.ink3)
                .padding(Space.l + 2)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Group { content }
                        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
                }
                .padding(.horizontal, Space.l + 2)
                .padding(.vertical, Space.s)
            }
            .defaultScrollAnchor(.bottom)
        }
    }
}

// Writing to one agent or several at once: each gets its own copy, in its
// own conversation, and the sidebar's subtitle says how each gets it.
private struct NewMessagePane: View {
    @Environment(Store.self) private var store
    @State private var to: Set<String> = []
    @State private var draft = ""

    var body: some View {
        let reach = Dictionary(store.threads.map { ($0.to, $0.reach) }, uniquingKeysWith: { a, _ in a })
        var names = store.threads.filter { !$0.isSub && $0.reach != .ended && !Chat.isDesk($0, store.threadList?.desk) }.map(\.to)
        for a in store.agentRows where !names.contains(a.who) { names.append(a.who) }
        let ready = !to.isEmpty && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 0) {
            StreamHead(title: "New message", note: "Each agent gets its own copy.")
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    Text("To")
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .padding(.bottom, Space.xs)
                    if names.isEmpty {
                        Text("No agent is running.").foregroundStyle(Palette.ink3)
                    }
                    ForEach(names, id: \.self) { n in
                        Toggle(isOn: Binding(get: { to.contains(n) }, set: { on in if on { to.insert(n) } else { to.remove(n) } })) {
                            HStack {
                                Text(store.displayName(n)).font(Typeface.body).foregroundStyle(Palette.ink)
                                Spacer()
                                Text((reach[n] ?? (store.agentRows.first { $0.who == n }?.listening == true ? .listening : .working)).short)
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink3)
                            }
                        }
                        .toggleStyle(.checkbox)
                        .padding(.vertical, Space.xs + 1)
                    }
                }
                .padding(.horizontal, Space.l + 2)
                .padding(.vertical, Space.m)
            }
            HStack(alignment: .bottom, spacing: Space.s) {
                TextField("Message", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(Typeface.lede)
                    .lineLimit(2...6)
                    .padding(.horizontal, Space.m)
                    .padding(.vertical, Space.s + 1)
                    .background(Palette.sunken, in: .rect(cornerRadius: 10, style: .continuous))
                Button(to.count > 1 ? "Send to \(to.count)" : "Send") {
                    let names = Array(to), text = draft
                    Task { if await store.tell(names, text) { draft = ""; to = [] } }
                }
                .buttonStyle(InkButton(prominent: ready))
                .disabled(!ready || store.running.contains("tell-new"))
                .padding(.bottom, 3)
            }
            .padding(Space.m + 2)
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        }
    }
}

struct ChatList: View {
    @Environment(Store.self) private var store
    let items: [ChatItem]

    // A question still waiting is answered in its card above the panes; here it's a line in the history.
    var body: some View {
        let history = items
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

// What the person said or answered, and whether it reached the agent.
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
            Text("You, \(Format.clock(item.date))" + (item.delivery.map { " \u{00B7} \($0)" } ?? (item.queued ? " \u{00B7} not delivered yet" : "")))
                .font(Typeface.small.weight(item.queued ? .semibold : .regular))
                .foregroundStyle(item.queued ? Palette.ink2 : Palette.ink3)
                .padding(.horizontal, 4)
        }
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
                Text("\(store.chatName(item)) asked\(item.question?.open == true ? " (waiting on your answer, above)" : state == "dismissed" ? " (you said not now)" : state == "expired" ? " (nobody answered in time)" : "")")
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
    // How it reaches the agent; nil for the desk.
    var reach: Reach? = nil
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        let ready = !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: Space.xs + 2) {
        Text("To \(Text(name).foregroundStyle(Palette.ink).fontWeight(.semibold))\(reach.map { " (\($0.short))" } ?? "")")
            .font(Typeface.small)
            .foregroundStyle(Palette.ink3)
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
        }
        .padding(Space.m + 2)
        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
    }

    private func send() {
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        store.replyTo = to
        Task {
            if await store.say(text, reach: reach) { draft = "" }
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
