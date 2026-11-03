import SwiftUI

// Runs agents scheduled with dibs later: what's coming up, what ended this
// week. The web page's Later, word for word.
struct LaterScreen: View {
    @Environment(Store.self) private var store
    // The run whose Cancel was pressed once: the second press cancels it.
    @State private var confirming: String?

    // As many ended runs as the web page shows.
    private static let endedShown = 40

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(now: context.date)
        }
        .page()
        .navigationTitle("Later")
        .navigationSubtitle(store.lastAction ?? "")
        .task { await store.loadLater() }
    }

    @ViewBuilder
    private func content(now: Date) -> some View {
        let runs = store.later ?? []
        let active = runs.filter(\.active).sorted(by: LaterRun.order)
        let ended = runs.filter { !$0.active }.sorted { ($0.ended ?? 0) > ($1.ended ?? 0) }.prefix(Self.endedShown)
        let scheduled = active.filter { $0.state == "scheduled" }.count
        VStack(alignment: .leading, spacing: Space.xxl) {
            PageHead(title: "Later", summary: active.isEmpty
                     ? "Nothing for later. Agents set runs up with dibs later <resource> --at 02:00 -- <command>."
                     : "\(scheduled == 1 ? "1 run" : "\(scheduled) runs") for later, \(active.count - scheduled) started. Agents set these up with dibs later.")
            if store.later == nil {
                if let e = store.laterError {
                    Text(e.message).foregroundStyle(Palette.accentInk).fixedSize(horizontal: false, vertical: true)
                } else {
                    Loading("Loading runs for later")
                }
            }
            if !active.isEmpty {
                PageSection("Coming up", note: active.contains { $0.state != "scheduled" } ? "A started one is stopped if you cancel it." : "") {
                    list(active, now: now, cancel: true)
                }
            }
            if !ended.isEmpty {
                PageSection("Ended this week", note: "\(ended.filter { $0.code == 0 }.count) of \(ended.count) exited 0") {
                    list(Array(ended), now: now, cancel: false)
                }
            }
            if store.later != nil && active.isEmpty && ended.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("No runs for later this week.").font(Typeface.title).foregroundStyle(Palette.ink)
                    Text("An agent schedules one with dibs later test --at 02:00 -- <command>.").foregroundStyle(Palette.ink3)
                }
            }
        }
    }

    private func list(_ runs: [LaterRun], now: Date, cancel: Bool) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(runs.enumerated()), id: \.element.id) { i, run in
                if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        pill(run)
                        Text("\(Text(store.displayName(run.who)).fontWeight(.semibold).foregroundStyle(Palette.ink)) \(run.what)")
                            .foregroundStyle(Palette.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                            .help("\(run.id): \(run.cmd ?? "")")
                    }
                    Spacer(minLength: Space.m)
                    Text(run.side(now: now))
                        .font(Typeface.small.weight(.medium))
                        .foregroundStyle(Palette.ink2)
                        .multilineTextAlignment(.trailing)
                    if cancel && store.ownerActions {
                        let armed = confirming == run.id
                        Button(armed ? "Yes, cancel" : "Cancel") {
                            if armed {
                                confirming = nil
                                Task { await store.cancelLater(run) }
                            } else {
                                confirming = run.id
                            }
                        }
                        .buttonStyle(InkButton(prominent: armed))
                        .disabled(store.running.contains("later-\(run.id)"))
                    }
                }
                .padding(.horizontal, Space.l + 2)
                .padding(.vertical, Space.m)
            }
        }
        .card()
    }

    // The web page's pills: green exit 0, red another exit, quiet scheduled, yellow started.
    private func pill(_ run: LaterRun) -> some View {
        let (text, fg, bg): (String, Color, Color) = switch run.state {
        case "done" where run.code == 0: ("exit 0", Palette.working, Palette.working.opacity(0.14))
        case "done": ("exit \(run.code.map(String.init) ?? "?")", Palette.accentInk, Palette.accentWash)
        case "scheduled": ("scheduled", Palette.ink3, .clear)
        default: (run.state, Palette.onYellow, Palette.yellow)
        }
        return Text(text)
            .font(Typeface.sized(10.5, .semibold))
            .foregroundStyle(fg)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(bg, in: Capsule())
            .overlay(Capsule().strokeBorder(bg == .clear ? Palette.hairline : .clear))
            .fixedSize()
    }
}
