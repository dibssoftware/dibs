import SwiftUI

// The web page's Machines: this Mac's figures and what dibs checks before it
// starts a job, the other machines in the group, quotas, the private
// simulators and dibs's own services.
struct MachinesScreen: View {
    @Environment(Store.self) private var store

    // Services ask launchctl and the pool asks simctl: half a minute between reads.
    private static let reload: Duration = .seconds(30)

    var body: some View {
        let board = store.board
        let others = board?.peers(excluding: store.hostName) ?? []
        VStack(alignment: .leading, spacing: Space.xxl) {
            PageHead(title: "Machines", summary: summary(others: others))
            if let board {
                PageSection("This Mac", note: "\(Speed(board.machine.pace ?? "normal").title) speed") {
                    VStack(alignment: .leading, spacing: Space.m) {
                        gauges(board.machine)
                        if let limits = board.limits {
                            Text("Before starting a job, dibs checks: \(limits).")
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let hold = board.hold {
                            Text("Nothing new starts right now: \(hold)")
                                .padding(.horizontal, Space.l)
                                .padding(.vertical, Space.m)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Palette.yellow.opacity(0.16), in: .rect(cornerRadius: 10, style: .continuous))
                        }
                    }
                }
                PageSection("Other machines") { group(board, others: others) }
                if !board.quotas.isEmpty {
                    PageSection("Quotas", note: "Rate limits shared by every script here") {
                        StatTable(columns: ["Quota", "Left", "Per"], numeric: [false, true, false], rows: board.quotas.map { q in
                            StatTable.Row(id: q.name, cells: [
                                AnyView(Text(q.name).fontWeight(.semibold)),
                                AnyView(Text(q.error == nil ? "\(Int(q.left ?? 0)) of \(Int(q.limit ?? 0))" : "-")),
                                AnyView(Text(q.error ?? q.per ?? "-")),
                            ])
                        }, onPick: nil)
                    }
                }
            } else {
                Loading("Looking at the machines")
            }
            if let pool = store.pool, !pool.room.isEmpty {
                PageSection("Private simulators", note: "sim-own: one each, booted for the job and shut down after") { simulators(pool) }
            }
            PageSection("Services", note: "dibs service install <name> keeps one running") { services }
        }
        .page()
        .navigationTitle("Machines")
        .task {
            while !Task.isCancelled {
                await store.loadMachines()
                try? await Task.sleep(for: Self.reload)
            }
        }
    }

    private func summary(others: [Peer]) -> String {
        let pace = Speed(store.board?.machine.pace ?? "normal").title
        let group = store.board?.elsewhere == nil ? ", on its own" : ", in a group of \(others.count + 1) machines"
        return "\(store.hostName) runs at \(pace) speed\(group). What dibs checks before it starts a job, and what keeps it going."
    }

    private func gauges(_ m: Machine) -> some View {
        VStack(spacing: 0) {
            if let free = m.memFree { gauge("Memory", "\(Int(free.rounded()))% free", used: 1 - free / 100, bad: free < 15, first: true) }
            if let disk = m.diskFree { gauge("Disk", "\(Format.gb(disk)) free", used: min(1, Meters.floor / max(1, disk)), bad: disk < Meters.floor) }
            if let load = m.load {
                let limit = m.maxLoad ?? m.cores.map(Double.init) ?? 1
                gauge("Load", "\(String(format: "%.1f", load)) on \(m.cores.map(String.init) ?? "?") cores", used: load / limit, bad: m.maxLoad.map { load > $0 } ?? false)
            }
        }
        .card()
    }

    private func gauge(_ label: String, _ value: String, used: Double, bad: Bool, first: Bool = false) -> some View {
        HStack(spacing: Space.l) {
            Text(label).foregroundStyle(Palette.ink2).frame(width: 70, alignment: .leading)
            GeometryReader { g in
                Capsule().fill(Palette.sunken)
                    .overlay(alignment: .leading) {
                        Capsule().fill(bad ? Palette.accent : Palette.ink3).frame(width: max(2, g.size.width * min(1, max(0, used))))
                    }
            }
            .frame(height: 6)
            Text(value)
                .font(Typeface.small.weight(.semibold))
                .foregroundStyle(bad ? Palette.accentInk : Palette.ink2)
                .monospacedDigit()
                .frame(minWidth: 110, alignment: .trailing)
        }
        .padding(.horizontal, Space.l + 2)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }

    @ViewBuilder
    private func group(_ board: Board, others: [Peer]) -> some View {
        if let error = board.elsewhere?.error {
            quiet("Can't reach the coordinator.", "\(error). This Mac keeps its own queue meanwhile.")
        } else if board.elsewhere == nil {
            quiet("This Mac works alone.", "To share work with another machine: dibs serve here, then dibs invite <machine> and run the join line it prints there.")
        } else if others.isEmpty {
            quiet("No other machine has joined yet.", "On the coordinator: dibs invite <machine>, then run the join line it prints there.")
        } else {
            StatTable(columns: ["Machine", "State", "Load", "Memory free", "Disk free", "Jobs"], numeric: [false, false, true, true, true, true],
                      rows: others.sorted { $0.name < $1.name }.map { p in
                let st = Self.state(p)
                return StatTable.Row(id: p.name, cells: [
                    AnyView(HStack(spacing: Space.s) { StateDot(kind: st.dot); Text(p.name).fontWeight(.semibold) }),
                    AnyView(Text(st.text).foregroundStyle(Palette.ink2)),
                    AnyView(Text(p.load.map { String(format: "%.1f", $0) } ?? "-")),
                    AnyView(Text(p.memFree.map { "\(Int($0.rounded()))%" } ?? "-")),
                    AnyView(Text(p.diskFree.map(Format.gb) ?? "-")),
                    AnyView(Text(p.board.map { "\($0.held.count + $0.waiting.count)" } ?? "-")),
                ])
            }, onPick: nil)
        }
    }

    // Another machine as a person would say it, with the dot it gets: the web page's words.
    static func state(_ p: Peer) -> (dot: StateDot.Kind, text: String) {
        if let od = p.ondemand {
            if let problem = od.problem { return (.blocked, "On-demand VM dibs can't use: \(problem)") }
            if od.state == "asleep", let cw = od.cantWake { return (.blocked, "Can't wake: \(cw.why)") }
            if od.state != "running" { return (.idle, "On-demand VM, \(od.state ?? "unknown")\(od.state == "asleep" ? ": a job sent there wakes it" : "")") }
        }
        if p.lost == true { return (.blocked, "Not reporting for \(ProgressTask.short((p.age ?? 0) / 1000))") }
        guard let b = p.board else { return (.idle, "Runs dibs \(p.version ?? "of an older version"), which doesn't share its queues") }
        return b.held.isEmpty ? (.busy, "Nothing running") : (.running, "\(b.held.count) running")
    }

    private func simulators(_ pool: SimPool) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(pool.room.keys.sorted().enumerated()), id: \.element) { i, res in
                let r = pool.room[res]!
                row(first: i == 0, main: Text("\(Text(res).fontWeight(.semibold).foregroundStyle(Palette.ink)) \(r.inUse ?? 0) in use, at most \(r.max ?? 0) at once; memory fits \(r.fits ?? 0) more now"),
                    side: r.per.map { "\(Format.gb($0)) each" } ?? "")
            }
            ForEach(pool.devices) { d in
                row(first: false, main: Text("\(Text(d.name).font(.system(size: 12, design: .monospaced)).foregroundStyle(Palette.ink)) \(d.inUse ? "in use by \(d.who ?? "an agent")" : d.lastWho.map { "idle, last used by \($0)" } ?? "never used")"),
                    side: d.state ?? "")
            }
        }
        .card()
    }

    @ViewBuilder
    private var services: some View {
        if let list = store.services, !list.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(list.enumerated()), id: \.element.id) { i, x in
                    row(first: i == 0, main: Text("\(Text(x.name).fontWeight(.semibold).foregroundStyle(Palette.ink)) \(x.what)"), side: x.state,
                        dot: x.running ? .busy : x.installed ? .waiting : .idle)
                }
            }
            .card()
        } else {
            Loading("Asking the services")
        }
    }

    private func row(first: Bool, main: Text, side: String, dot: StateDot.Kind? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.l) {
            if let dot { StateDot(kind: dot).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 } }
            main.foregroundStyle(Palette.ink2).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.m)
            Text(side).font(Typeface.small.weight(.medium)).foregroundStyle(Palette.ink2)
        }
        .padding(.horizontal, Space.l + 2)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }

    private func quiet(_ title: String, _ detail: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(Typeface.title).foregroundStyle(Palette.ink)
            Text(detail).foregroundStyle(Palette.ink3).fixedSize(horizontal: false, vertical: true)
        }
    }
}

// While a screen's data is on its way: a small spinner, shown only once the
// wait passes 150 ms, so a quick answer never flashes it. The web page's too.
struct Loading: View {
    let text: String
    @State private var shown = false

    init(_ text: String) { self.text = text }

    var body: some View {
        HStack(spacing: Space.s + 2) {
            ProgressView().controlSize(.small)
            Text(text).foregroundStyle(Palette.ink3)
        }
        .opacity(shown ? 1 : 0)
        .animation(.easeOut(duration: 0.16), value: shown)
        .task {
            try? await Task.sleep(for: .milliseconds(150))
            shown = true
        }
        .accessibilityElement(children: .combine)
    }
}
