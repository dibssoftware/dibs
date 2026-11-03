import SwiftUI

struct RootView: View {
    @Environment(Store.self) private var store
    @Environment(\.scenePhase) private var phase
    @State private var showWalkthrough = !UserDefaults.standard.bool(forKey: "walkthroughDone")

    @ViewBuilder
    private var screen: some View {
        switch store.section ?? .now {
        case .now: HomeView()
        case .questions: QuestionsScreen()
        case .messages: MessagesView()
        case .progress: ProgressScreen()
        case .queues: QueuesView()
        case .schedule: ScheduleView()
        case .machines: MachinesScreen()
        case .later: LaterScreen()
        case .stats: StatsScreen()
        case .history: HistoryView()
        case .settings: SettingsView()
        }
    }

    var body: some View {
        // The web page's frame: the dither on the canvas, the rail solid on
        // the left, and one surface panel that sits proud of both.
        HStack(spacing: 0) {
            // The traffic lights sit on the rail's top, so it starts below them.
            Sidebar()
                .padding(.top, 28)
                .frame(width: 248)
                .background(Palette.canvas)
            screen
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .clipShape(.rect(cornerRadius: 14, style: .continuous))
                // Translucent like the page's panel, so the dither shows through faintly.
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Palette.panel)
                        .shadow(color: Palette.shadowNear, radius: 1, y: 1)
                        .shadow(color: Palette.shadowFar, radius: 18, y: 8)
                }
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.hairline))
                .padding([.top, .trailing, .bottom], 8)
        }
        .overlay(alignment: .topTrailing) {
            Mark().padding(.top, 14).padding(.trailing, 16)
        }
        .background {
            ZStack {
                Palette.canvas
                Dither()
            }
        }
        .ignoresSafeArea()
        .frame(minWidth: 760, minHeight: 520)
        // Switches, pickers and selections take the app's red.
        .tint(Palette.accent)
        // The past day feeds Home's chart, the trend lines and Just finished.
        // It changes slowly; a minute between reads is plenty.
        .task {
            while !Task.isCancelled {
                await store.loadToday()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .sheet(isPresented: $showWalkthrough) { Walkthrough() }
        .sheet(isPresented: Bindable(store).pairing) { PairSheet() }
        .sheet(isPresented: Bindable(store).paletteOpen) { CommandPalette() }
        .sheet(item: Binding(get: { store.sheetRow.map(SheetRow.init) }, set: { store.sheetRow = $0?.id })) { JobSheet(rowID: $0.id) }
        .onChange(of: phase, initial: true) { _, phase in store.looking = phase == .active }
        .onDisappear { store.looking = false }
        .onChange(of: store.openRequest) { _, section in
            guard let section else { return }
            store.section = section
            store.openRequest = nil
            NSApp.activate()
        }
        .alert("dibs couldn't do that", isPresented: Binding(get: { store.actionError != nil }, set: { if !$0 { store.actionError = nil } })) {
            Button("OK") { store.actionError = nil }
        } message: {
            Text(store.actionError ?? "")
        }
    }
}

// Shown in place of a screen when the CLI can't be reached at all.
struct CLIProblemView: View {
    @Environment(Store.self) private var store
    let error: CLIError

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(Typeface.title)
            Text(detail)
                .foregroundStyle(.secondary)
                .copyable(detail)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again") { store.poke() }
                .padding(.top, 4)
        }
        .frame(maxWidth: 520, alignment: .leading)
        .padding(Space.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var title: String {
        switch error.kind {
        case .notInstalled: "dibs isn't installed"
        case .noNode: "dibs can't find Node"
        case .timedOut: "dibs isn't answering"
        default: "dibs reported an error"
        }
    }

    private var detail: String {
        switch error.kind {
        case .notInstalled:
            "This app shows what the dibs command line sees, and there's no dibs on PATH, in ~/bin or in ~/.local/bin. Install it with the one line in the dibs README, then try again."
        default:
            error.message
        }
    }
}

// The web page's rail (web/app.css .rail): the screens, a hairline, the
// agents, then the machine at the foot. Rows are 34 points with a 9 point
// radius; a screen's count is a pill, red when it waits on the person.
struct Sidebar: View {
    @Environment(Store.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            VStack(alignment: .leading, spacing: 1) {
                ForEach(Store.Section.allCases, id: \.self) { section in
                    let (count, loud) = badge(section)
                    let selected = (store.section ?? .now) == section
                    row(selected: selected) {
                        Text(section.title)
                            .font(Typeface.exact(14.5, selected ? 650 : 560))
                        Spacer(minLength: 0)
                        if count > 0 { CountPill(count: count, loud: loud) }
                    } action: { store.section = section }
                }
            }
            .padding(.bottom, 14)
            .overlay(alignment: .bottom) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            .padding(.bottom, 8)
            agents
            Spacer(minLength: Space.m)
            foot
        }
        .padding(.horizontal, 10)
        .padding(.top, 16)
        .padding(.bottom, 12)
        .frame(maxHeight: .infinity, alignment: .top)
    }

    // Red when it waits on the person, quiet when it's only a count.
    private func badge(_ section: Store.Section) -> (Int, Bool) {
        switch section {
        case .now: (store.rows.count, false)
        case .questions: (store.asks.count, true)
        case .messages: (store.threads.reduce(0) { $0 + $1.unread }, true)
        case .queues: (store.waitingCount, false)
        case .later: ((store.later ?? []).filter { $0.state == "scheduled" }.count, false)
        case .settings: (store.update == nil ? 0 : 1, false)
        default: (0, false)
        }
    }

    // Everyone, then each agent with its state: picking one narrows Now,
    // Progress, Stats and Messages to it.
    @ViewBuilder
    private var agents: some View {
        let list = store.agentRows
        HStack(alignment: .firstTextBaseline) {
            Text("Agents")
                .font(Typeface.sized(13, .semibold))
                .foregroundStyle(Palette.ink2)
            Spacer()
            if !list.isEmpty {
                Text("\(list.count)")
                    .font(Typeface.sized(12, .semibold).monospacedDigit())
                    .foregroundStyle(Palette.ink3)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 9)
        // Scrolls when there are more than fit, instead of pushing the
        // machine off the bottom.
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                row(selected: store.chosen == nil) {
                    EveryoneMark().frame(width: 14)
                    Text("Everyone").font(Typeface.exact(14, 560))
                    Spacer(minLength: 0)
                } action: { pick(nil) }
                ForEach(list) { a in
                    row(selected: store.chosen == a.who) {
                        StateDot(kind: a.state).frame(width: 14)
                        // The handle, as on the page; what it's working on is the tooltip.
                        Text(a.who)
                            .font(Typeface.exact(14, 560))
                            .lineLimit(1)
                        Spacer(minLength: Space.xs)
                        if a.jobs > 0 {
                            meta("\(a.jobs) job\(a.jobs == 1 ? "" : "s")")
                        } else if let last = a.lastPost {
                            meta(Span.ago(Date.now.timeIntervalSince(last)))
                        }
                    } action: { pick(a.who) }
                    .help(store.displayName(a.who))
                }
            }
        }
        .scrollIndicators(.never)
    }

    // The machine, and whether what's on screen is still what dibs says.
    private var foot: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let m = store.board?.machine {
                Meters(name: store.hostName, machine: m)
            }
            TimelineView(.periodic(from: .now, by: 5)) { context in
                if let f = store.freshness(now: context.date) {
                    Text(f.text)
                        .font(Typeface.sized(12, f.stale ? .semibold : .regular))
                        .foregroundStyle(f.stale ? Palette.accentInk : Palette.ink3)
                        .lineLimit(f.stale ? 3 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 14)
        .padding(.bottom, 2)
    }

    // The web page's rule: Now and Stats stay put, Messages opens the agent's
    // thread, Progress narrows; anywhere else goes to Now.
    private func pick(_ who: String?) {
        store.chosen = who
        let here = store.section ?? .now
        if ![.now, .stats, .messages, .progress].contains(here) { store.section = .now }
    }

    private func meta(_ text: String) -> some View {
        Text(text)
            .font(Typeface.sized(12).monospacedDigit())
            .foregroundStyle(Palette.ink3)
            .lineLimit(1)
            .fixedSize()
    }

    private func row<Label: View>(selected: Bool, @ViewBuilder label: () -> Label, action: @escaping () -> Void) -> some View {
        RailRow(selected: selected, action: action) {
            HStack(spacing: 9) { label() }
        }
    }
}

// One row of the rail: its own hover and pressed tones, as the page moves
// lightness and never hue.
struct RailRow<Label: View>: View {
    let selected: Bool
    let action: () -> Void
    @ViewBuilder var label: Label
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            label
                .foregroundStyle(selected || hover ? Palette.ink : Palette.ink2)
                .padding(.horizontal, 10)
                .frame(height: 34)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(selected ? Palette.ink.opacity(0.07) : hover ? Palette.hover : .clear,
                            in: .rect(cornerRadius: 9, style: .continuous))
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// The page's mark for Everyone: four dots in a rounded square.
struct EveryoneMark: View {
    var body: some View {
        Canvas { context, size in
            for (x, y) in [(0.3, 0.3), (0.7, 0.3), (0.3, 0.7), (0.7, 0.7)] {
                let c = CGPoint(x: size.width * x, y: size.height * y)
                context.fill(Path(ellipseIn: CGRect(x: c.x - 1.6, y: c.y - 1.6, width: 3.2, height: 3.2)), with: .color(Palette.ink2))
            }
        }
        .frame(width: 12, height: 12)
        .accessibilityHidden(true)
    }
}

// The logo, top right on every screen as on the page: the ticket on its ink.
// It tips on hover like the page's does; a click goes to Now.
struct Mark: View {
    @Environment(Store.self) private var store
    @State private var hover = false

    var body: some View {
        Button { store.section = .now } label: {
            Image(nsImage: Self.logo)
                .resizable()
                .interpolation(.high)
                .frame(width: 38, height: 38)
                .background(Palette.iconInk)
                .clipShape(.rect(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.white.opacity(0.06)))
                .shadow(color: Palette.shadowNear, radius: 1, y: 1)
                .shadow(color: Palette.shadowFar, radius: 8, y: 4)
                .rotationEffect(.degrees(hover ? -8 : 0))
                .scaleEffect(hover ? 1.06 : 1)
                .animation(.spring(response: 0.25, dampingFraction: 0.55), value: hover)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("dibs")
        .accessibilityLabel("dibs, go to Now")
    }

    static let logo: NSImage = Bundle.main.image(forResource: "logo") ?? NSImage()
}

// A count, red when it's asking for the person, quiet otherwise.
struct CountPill: View {
    let count: Int
    var loud = true

    var body: some View {
        Text("\(count)")
            .font(Typeface.exact(12, 650).monospacedDigit())
            .foregroundStyle(loud ? Palette.onAccent : Palette.ink)
            .frame(minWidth: 6)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(loud ? Palette.accent : Palette.sunken, in: Capsule())
    }
}

// The job sheet's row, by id, as sheet(item:) wants it.
struct SheetRow: Identifiable { var id: String }
