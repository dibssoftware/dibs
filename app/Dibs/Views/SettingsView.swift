import SwiftUI

struct SettingsView: View {
    @Environment(Store.self) private var store
    @State private var start = Self.time("09:00")
    @State private var end = Self.time("23:00")

    @State private var icon = IconChoice.current

    var body: some View {
        // The reader is for a notification about a waiting browser: it scrolls to the account group.
        ScrollViewReader { proxy in
        VStack(alignment: .leading, spacing: Space.xxl) {
            PageHead(title: "Settings", summary: "The same settings the web page and the command line change. Each change is logged as yours.")

            group("Speed", "How hard agents can work this Mac.") {
                HStack(spacing: Space.m) {
                    // Off as the web page has it: the numbers in config.json, no limit on load.
                    ForEach(Speed.all + [Speed("off")], id: \.pace) { option in speedCard(option) }
                }
                if let info = store.paceInfo {
                    DisclosureGroup("What each speed sets on this Mac") {
                        VStack(alignment: .leading, spacing: Space.s) {
                            ForEach(info.lines, id: \.name) { p in
                                HStack(alignment: .firstTextBaseline) {
                                    Text(Speed(p.name).title).font(Typeface.headline).frame(width: 70, alignment: .leading)
                                    Text(p.line).font(Typeface.small).foregroundStyle(Palette.ink2)
                                }
                            }
                            if !info.pinned.isEmpty {
                                Text("Some limits were set by hand in dibs's settings, and those stay put whatever the speed: \(Needs.list(info.pinned.map(ActionText.knob))).")
                                    .font(Typeface.small)
                                    .foregroundStyle(Palette.ink3)
                            }
                        }
                        .padding(.top, Space.s)
                    }
                    .font(Typeface.small.weight(.medium))
                    .foregroundStyle(Palette.ink2)
                }
            }

            group("Working hours", store.questions?.hours == nil
                  ? "None set: agents' questions reach you at any hour."
                  : "Outside these hours, questions below urgent wait for the morning.") {
                if store.hoursSupported && store.questionsSupported {
                    HStack(spacing: Space.l) {
                        DatePicker("From", selection: $start, displayedComponents: .hourAndMinute)
                            .fixedSize()
                        DatePicker("To", selection: $end, displayedComponents: .hourAndMinute)
                            .fixedSize()
                        Spacer()
                        if store.questions?.hours != nil {
                            Button("Clear") { Task { await store.setHours(start: nil, end: nil) } }
                                .buttonStyle(InkButton())
                                .disabled(store.running.contains("hours"))
                        }
                        Button("Set hours") {
                            Task { await store.setHours(start: Self.clock(start), end: Self.clock(end)) }
                        }
                        .buttonStyle(InkButton(prominent: true))
                        .disabled(store.running.contains("hours") || hoursUnchanged)
                    }
                    .padding(Space.l)
                    .card()
                } else {
                    Text("This dibs (\(store.version ?? "an older version")) has no working hours. Update to \(Store.ownerVersion) or newer.")
                        .foregroundStyle(Palette.ink2)
                }
            }

            group("Claude Code hook", "dibs guard install") {
                HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                    Text(hookText)
                        .foregroundStyle(Palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: Space.s)
                    Button(store.guardStatus?.installed == true ? "Update hook" : "Set up hook") { Task { await store.installGuard() } }
                        .buttonStyle(InkButton(prominent: store.guardStatus?.complete != true))
                        .disabled(store.running.contains("guard"))
                        .fixedSize()
                }
                .padding(Space.l)
                .card()
                ForEach(hookDetails, id: \.self) { line in
                    Text(line).font(Typeface.small).foregroundStyle(Palette.ink3).fixedSize(horizontal: false, vertical: true)
                }
            }

            group("The dibs page", "dibs web is this app in a browser at 127.0.0.1:7421, and a read-only MCP server for Claude.") {
                if store.webSupported {
                    webCard
                    PairedList()
                } else {
                    NeedsWeb()
                }
            }

            group("Your dibs account", "Sign in at app.dibs.cc/account and every browser you use opens this Mac, end to end encrypted. A new browser gets the account's key from here once you type the code it shows.") {
                AccountsCard()
            }
            .id("accounts")

            group("App icon", "Shows in the Dock while dibs runs.") {
                HStack(spacing: Space.l) {
                    ForEach(IconChoice.allCases) { choice in
                        Button {
                            icon = choice
                            IconChoice.current = choice
                        } label: {
                            VStack(spacing: Space.s) {
                                AppIconArt(choice: choice, size: 64)
                                    .padding(4)
                                    .overlay(RoundedRectangle(cornerRadius: 19, style: .continuous)
                                        .strokeBorder(icon == choice ? Palette.accent : .clear, lineWidth: 2.5))
                                Text(choice.title)
                                    .font(Typeface.small.weight(icon == choice ? .semibold : .regular))
                                    .foregroundStyle(icon == choice ? Palette.ink : Palette.ink2)
                            }
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            group("Notify me when", "Questions only you can answer, and what needs you on Now. The queues moving along never notify you.") {
                if store.notificationsOff { NotificationsOff() }
                VStack(spacing: 0) {
                    toggle("An agent needs your answer", .question, first: true)
                    toggle("A deploy can't start", .ship)
                    toggle("Work has waited a long time", .stuck)
                    toggle("A job looks stuck while others wait", .idle)
                    toggle("The disk is too full for work to start", .disk)
                    toggle("Memory or swap holds work back", .memory)
                    toggle("A job failed, was stopped or was lost", .ended)
                    toggle("dibs itself has a problem", .broken)
                    toggle("A browser wants your account's key", .account)
                }
                .card()
            }

            group("About", nil) {
                if let update = store.update { updateCard(update) }
                VStack(spacing: 0) {
                    about("This app", "Version \(UpdateFeed.running)", first: true)
                    about("dibs command line", store.version.map { "Version \($0)" } ?? "Not found")
                    HStack {
                        Text("Check dibs.cc for a new version once a day").foregroundStyle(Palette.ink)
                        Spacer()
                        Toggle("Check for updates", isOn: Bindable(store).checkUpdates)
                            .toggleStyle(.switch)
                            .labelsHidden()
                    }
                    .padding(.horizontal, Space.l)
                    .padding(.vertical, Space.m)
                    .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
                }
                .card()
                HStack(spacing: Space.m) {
                    Button(store.updateChecking ? "Checking\u{2026}" : "Check now") {
                        Task { await store.checkForUpdate(byHand: true) }
                    }
                    .buttonStyle(InkButton())
                    .disabled(store.updateChecking)
                    if let note = store.updateNote, store.update == nil {
                        Text(note).font(Typeface.small).foregroundStyle(Palette.ink3)
                    }
                }
            }
        }
        .page()
        .onChange(of: store.focusAccounts, initial: true) { _, on in
            guard on else { return }
            withAnimation { proxy.scrollTo("accounts", anchor: .top) }
            store.focusAccounts = false
        }
        }
        .navigationTitle("Settings")
        .task {
            await store.loadSettings()
            await store.loadPairing()
        }
        .onChange(of: store.questions?.hours, initial: true) { _, hours in
            if let hours {
                start = Self.time(hours.start)
                end = Self.time(hours.end)
            }
        }
    }

    private func group<C: View>(_ title: String, _ caption: String?, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: Space.m) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typeface.title).foregroundStyle(Palette.ink)
                if let caption { Text(caption).font(Typeface.small).foregroundStyle(Palette.ink3) }
            }
            content()
        }
    }

    private static let speedSymbols = ["quiet": "tortoise.fill", "normal": "gauge.with.dots.needle.50percent", "max": "hare.fill", "off": "slider.horizontal.3"]

    private func speedCard(_ option: Speed) -> some View {
        let on = option.pace == speed
        return Button { Task { await store.setPace(option.pace) } } label: {
            VStack(alignment: .leading, spacing: Space.s) {
                Image(systemName: Self.speedSymbols[option.pace] ?? "gauge")
                    .font(Typeface.sized(18, .semibold))
                    .foregroundStyle(on ? Palette.onAccent : Palette.ink2)
                    .frame(width: 34, height: 34)
                    .background(on ? Palette.accent : Palette.sunken, in: Circle())
                Text(option.title)
                    .font(Typeface.title)
                    .foregroundStyle(Palette.ink)
                Text(option.line)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(Space.l)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .card(12, fill: on ? Palette.accentWash : Palette.surface)
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(on ? Palette.accent : .clear, lineWidth: 2))
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(store.running.contains("pace"))
    }

    // The page's service and the way in: is it up, start or stop it, pair something.
    private var webCard: some View {
        let state = store.webService
        return VStack(spacing: 0) {
            HStack(spacing: Space.m) {
                Circle().fill(state?.running == true ? Palette.working : Palette.ink3.opacity(0.5))
                    .frame(width: 8, height: 8)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("The dibs page").foregroundStyle(Palette.ink)
                    Text(webLine).font(Typeface.small).foregroundStyle(Palette.ink3)
                }
                Spacer()
                if state?.running == true {
                    Button("Open") { NSWorkspace.shared.open(PairSheet.page) }
                        .buttonStyle(InkButton())
                }
                if let state {
                    Button(state.installed ? "Stop" : "Start") { Task { await store.setWebService(on: !state.installed) } }
                        .buttonStyle(InkButton())
                        .disabled(store.running.contains("web-service"))
                }
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            HStack {
                Text("A one-time code signs in a browser or Claude.").foregroundStyle(Palette.ink)
                Spacer()
                Button("Pair a browser or Claude") { store.pairing = true }
                    .buttonStyle(InkButton(prominent: true))
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
        }
        .card()
    }

    private var webLine: String {
        guard let state = store.webService else { return "Checking\u{2026}" }
        if state.running { return "Running, and starts again when you log in" }
        if state.installed { return "Set up, but not running. Its log is ~/.dibs/web.log." }
        return "Not running"
    }

    private func toggle(_ label: String, _ kind: Alert.Kind, first: Bool = false) -> some View {
        HStack {
            Text(label).foregroundStyle(Palette.ink)
            Spacer()
            Toggle(label, isOn: notify(kind))
                .toggleStyle(.switch)
                .labelsHidden()
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }

    // A newer build is out: what it is and a link to the DMG. Installing is
    // the person's call, so this never downloads on its own.
    private func updateCard(_ update: UpdateFeed) -> some View {
        HStack(alignment: .top, spacing: Space.l) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Version \(update.version) is out")
                    .font(Typeface.headline)
                    .foregroundStyle(Palette.onYellow)
                Text(update.notes ?? "Download it, open it and drag dibs to Applications to replace this one.")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.onYellow.opacity(0.8))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.m)
            Button("Download") { NSWorkspace.shared.open(update.url) }
                .buttonStyle(InkButton(prominent: true))
        }
        .padding(Space.l)
        .background(Palette.yellow, in: .rect(cornerRadius: 14, style: .continuous))
    }

    private func about(_ label: String, _ value: String, first: Bool = false) -> some View {
        HStack {
            Text(label).foregroundStyle(Palette.ink)
            Spacer()
            Text(value).foregroundStyle(Palette.ink2)
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }

    // The rest of dibs guard status, as the web page shows it: how heavy commands
    // are handled, the subagent cap, which events the hook hears.
    private var hookDetails: [String] {
        guard let g = store.guardStatus, g.installed else { return [] }
        var out = ["Heavy commands an agent runs outside dibs: \(g.rewrite == "bypass" ? "run through dibs in bypassPermissions sessions, turned away in others" : "run through dibs in \"\(g.rewrite)\" sessions, turned away in others")."]
        out.append("Subagents: \(g.subagents.map { "at most \($0.slots) at once across every session" } ?? "no limit (agents.slots in config.json sets one)").")
        var events: [String] = []
        for m in g.matchers where !events.contains(m.event) { events.append(m.event) }
        if !events.isEmpty { out.append("It hears \(events.joined(separator: ", ")).") }
        return out
    }

    // The web page's words for the hook.
    private var hookText: String {
        guard let status = store.guardStatus else { return "Checking\u{2026}" }
        if !status.installed { return "The Claude Code hook isn't set up, so agents only see your messages when they run dibs say." }
        if !status.complete { return "The hook is set up but missing some events. Update it to get all of them." }
        return "The Claude Code hook is set up: agents get your messages with their next tool call, and file leases are enforced."
    }

    // No speed set is Off: config.json's numbers, as the CLI and the web page say it.
    private var speed: String { store.board?.machine.pace ?? store.paceInfo?.pace ?? "off" }

    private var hoursUnchanged: Bool {
        guard let hours = store.questions?.hours else { return false }
        return hours.start == Self.clock(start) && hours.end == Self.clock(end)
    }

    private func notify(_ kind: Alert.Kind) -> Binding<Bool> {
        Binding(get: { !store.muted.contains(kind) },
                set: { on in if on { store.muted.remove(kind) } else { store.muted.insert(kind) } })
    }

    // dibs writes hours as 24-hour "HH:MM".
    static func time(_ s: String) -> Date {
        let parts = s.split(separator: ":").compactMap { Int($0) }
        return Calendar.current.date(bySettingHour: parts.first ?? 9, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: .now) ?? .now
    }

    static func clock(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
}

// macOS has dibs's notifications turned off: say so where it matters, with
// the way to turn them on.
struct NotificationsOff: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.m) {
            Text("Notifications are off for dibs in System Settings, so questions only show here in the app.")
                .foregroundStyle(Palette.accentInk)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.s)
            Button("Turn on") {
                NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "cc.dibs.mac")")!)
            }
            .buttonStyle(InkButton(prominent: true))
            .fixedSize()
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .background(Palette.accentWash, in: .rect(cornerRadius: 12, style: .continuous))
    }
}
