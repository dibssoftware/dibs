import SwiftUI

// What agents say they're doing, from `dibs progress`: one block per agent,
// its tasks newest first, each with its latest post and when it should be done.
struct ProgressScreen: View {
    @Environment(Store.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            PageHead(title: store.chosen.map(store.displayName) ?? "Progress", summary: "What agents say they're working on, in their own words.")
            content
        }
        .page()
        .navigationTitle("Progress")
        // The store reads it every poll while this screen shows; this is the first read.
        .task { await store.loadProgress() }
    }

    @ViewBuilder
    private var content: some View {
        if store.version != nil && !store.webSupported {
            NeedsWeb(what: "Progress needs")
        } else if let all = store.progress {
            let posts = all.filter { store.chosen == nil || $0.who == store.chosen }
            let agents = ProgressBoard.agents(posts)
            if agents.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("No progress posted yet.")
                        .font(Typeface.title)
                        .foregroundStyle(Palette.ink)
                    Text("Agents post here as they work: dibs progress \"what just happened\" --task name --eta 20m")
                        .foregroundStyle(Palette.ink3)
                }
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    VStack(alignment: .leading, spacing: Space.xxl) {
                        ForEach(agents) { agent in AgentProgressView(agent: agent, now: context.date) }
                        LatestPosts(posts: posts, now: context.date)
                    }
                }
            }
        } else if let error = store.progressError {
            Text(error.message)
                .foregroundStyle(Palette.accentInk)
                .fixedSize(horizontal: false, vertical: true)
        } else {
            Loading("Reading the posts")
        }
    }
}

struct AgentProgressView: View {
    @Environment(Store.self) private var store
    let agent: ProgressAgent
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(spacing: Space.m) {
                AgentTile(name: agent.who, size: 28)
                VStack(alignment: .leading, spacing: 0) {
                    Text(store.displayName(agent.who))
                        .font(Typeface.title)
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                    Text(summary)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                }
            }
            VStack(spacing: 0) {
                ForEach(Array(agent.tasks.enumerated()), id: \.element.id) { i, task in
                    TaskRow(task: task, now: now)
                        .overlay(alignment: .top) { if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) } }
                }
            }
            .card()
        }
    }

    private var summary: String {
        let open = agent.tasks.filter { $0.state != .done && $0.state != .expired }.count
        let late = agent.tasks.filter { $0.late(now: now) }.count
        let parts = [open == 0 ? "nothing open" : "\(open) open", late > 0 ? "\(late) late" : nil,
                     "last posted \(Span.ago(now.timeIntervalSince(agent.last)))"]
        return parts.compactMap { $0 }.joined(separator: " \u{00B7} ")
    }
}

// One task: a dot for its state, its name, the latest post, when it's due.
struct TaskRow: View {
    let task: ProgressTask
    let now: Date
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s + 2) {
                StateDot(kind: dot)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                Text(task.title)
                    .font(Typeface.headline)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                if let place {
                    Text(place)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink3)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: Space.s)
                if let when = task.when(now: now) {
                    Text(when)
                        .font(Typeface.small.weight(task.late(now: now) ? .semibold : .regular))
                        .foregroundStyle(task.late(now: now) ? Palette.accentInk : Palette.ink2)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            Text(task.text)
                .foregroundStyle(task.state == .done || task.state == .expired ? Palette.ink2 : Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 18)
                .copyable(task.text)
            if task.posts.count > 1 {
                DisclosureGroup(isExpanded: $open) {
                    VStack(alignment: .leading, spacing: Space.s) {
                        ForEach(task.posts.dropFirst()) { p in
                            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                                Text(ProgressTask.clock(Date(ms: p.at)))
                                    .font(Typeface.time)
                                    .foregroundStyle(Palette.ink3)
                                    .frame(width: 64, alignment: .leading)
                                Text(p.text)
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink2)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .copyable(p.text)
                            }
                        }
                    }
                    .padding(.top, Space.xs)
                } label: {
                    Text(task.posts.count == 2 ? "1 earlier post" : "\(task.posts.count - 1) earlier posts")
                        .font(Typeface.small.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                }
                .padding(.leading, 18)
            }
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .accessibilityElement(children: .contain)
    }

    // The dots everywhere else use: green while it's being worked on, a yellow
    // ring once it's late, a red ring when it's blocked, a grey ring once done.
    private var dot: StateDot.Kind {
        switch task.state {
        case .doing: task.late(now: now) ? .late : .busy
        case .blocked: .blocked
        case .done, .expired: .idle
        }
    }

    private var place: String? {
        let p = [task.task == nil ? nil : task.project, task.branch].compactMap { $0 }
        return p.isEmpty ? nil : p.joined(separator: " \u{00B7} ")
    }
}

// Every post, newest first, across agents: the web page's feed.
struct LatestPosts: View {
    @Environment(Store.self) private var store
    let posts: [ProgressPost]
    let now: Date
    @State private var shown = Self.step

    // As many as the web page shows at a time.
    static let step = 80

    var body: some View {
        let latest = posts.filter { now.timeIntervalSince(Date(ms: $0.at)) < 24 * 3600 }.reversed()
        PageSection("Latest posts", note: latest.isEmpty ? "" : "\(latest.count) post\(latest.count == 1 ? "" : "s") in the last day") {
            VStack(alignment: .leading, spacing: Space.m) {
                ForEach(Array(latest.prefix(shown))) { p in
                    HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                        Text(Format.clock(Date(ms: p.at)))
                            .font(Typeface.time)
                            .foregroundStyle(Palette.ink3)
                            .frame(width: 64, alignment: .leading)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: Space.s) {
                                Text(store.displayName(p.who)).font(Typeface.headline).foregroundStyle(Palette.ink)
                                if let task = p.task { Pill(task, tone: .faint) }
                                if p.state != "doing" { Pill(p.state, tone: p.state == "blocked" ? .hot : .faint) }
                            }
                            Text(p.text)
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                                .copyable(p.text)
                        }
                    }
                }
                if latest.count > shown {
                    Button("Show \(min(Self.step, latest.count - shown)) more") { shown += Self.step }
                        .buttonStyle(InkButton())
                }
            }
        }
    }
}
