import SwiftUI

// Cmd-K: every screen, agent, job and question, and the speed, found by typing
// a few letters of it. The web page's palette (/ or Cmd-K) holds the same.
struct CommandPalette: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var at = 0
    @FocusState private var focused: Bool

    struct Item: Identifiable {
        var group: String
        var label: String
        var hint = ""
        var words = ""
        var run: () -> Void
        var id: String { "\(group)\u{0}\(label)" }
    }

    var body: some View {
        let items = matches
        VStack(spacing: 0) {
            TextField("Go to a screen, an agent, a job, a question", text: $query)
                .textFieldStyle(.plain)
                .font(Typeface.sized(17))
                .padding(.horizontal, Space.xl - 4)
                .padding(.vertical, Space.l + 1)
                .focused($focused)
                .onChange(of: query) { at = 0 }
                .onKeyPress(.downArrow) { at = min(at + 1, max(0, items.count - 1)); return .handled }
                .onKeyPress(.upArrow) { at = max(at - 1, 0); return .handled }
                .onSubmit { if items.indices.contains(at) { pick(items[at]) } }
            Rectangle().fill(Palette.hairline).frame(height: 1)
            ScrollViewReader { scroller in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                            Button { pick(item) } label: {
                                HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                                    Text(item.group).font(Typeface.small).foregroundStyle(Palette.ink3).frame(width: 64, alignment: .leading)
                                    Text(item.label).fontWeight(.medium).foregroundStyle(Palette.ink).lineLimit(1)
                                    Spacer(minLength: Space.s)
                                    Text(item.hint).font(Typeface.small).foregroundStyle(Palette.ink3).monospacedDigit()
                                }
                                .padding(.horizontal, Space.m)
                                .padding(.vertical, Space.s)
                                .background(i == at ? Palette.ink.opacity(0.07) : .clear, in: .rect(cornerRadius: 9, style: .continuous))
                                .contentShape(.rect)
                            }
                            .buttonStyle(.plain)
                            .id(item.id)
                            .onHover { if $0 { at = i } }
                        }
                        if items.isEmpty {
                            Text("Nothing matches.").foregroundStyle(Palette.ink3).frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
                        }
                    }
                    .padding(6)
                }
                .onChange(of: at) { if items.indices.contains(at) { scroller.scrollTo(items[at].id) } }
            }
        }
        .frame(width: 600, height: 420)
        .background(Palette.surface)
        // A sheet takes focus a beat after it appears; asked for at once, it's lost.
        .task {
            try? await Task.sleep(for: .milliseconds(60))
            focused = true
        }
        .onExitCommand { dismiss() }
    }

    // Every word typed, anywhere in the group, the label or the hint.
    private var matches: [Item] {
        let words = query.lowercased().split(separator: " ").map(String.init)
        return all.filter { item in
            let text = "\(item.group) \(item.label) \(item.hint) \(item.words)".lowercased()
            return words.allSatisfy { text.contains($0) }
        }
        .prefix(40).map { $0 }
    }

    private var all: [Item] {
        var out = Store.Section.allCases.map { s in
            Item(group: "Go to", label: s.title, hint: s.key.map { "\u{2318}\($0)" } ?? "", run: { store.section = s })
        }
        out.append(Item(group: "Agent", label: "Everyone", run: { store.chosen = nil }))
        for a in store.agentRows {
            out.append(Item(group: "Agent", label: store.displayName(a.who), hint: a.jobs > 0 ? "\(a.jobs) job\(a.jobs == 1 ? "" : "s")" : "", words: a.who, run: {
                store.chosen = a.who
                if ![.now, .stats, .messages, .progress].contains(store.section ?? .now) { store.section = .now }
            }))
        }
        for r in store.rows {
            out.append(Item(group: "Job", label: "\(r.leaseID.map { "#\($0) " } ?? "")\(store.rowName(r)): \(r.purpose.isEmpty ? r.cmd : r.purpose)",
                            hint: r.res.map(Plain.name).joined(separator: ", "), words: r.res.joined(separator: " "), run: {
                store.sheetRow = r.id
            }))
        }
        for q in store.asks {
            out.append(Item(group: "Answer", label: "\(store.chatName(q)): \(q.text)", run: { store.section = .questions }))
        }
        for t in store.threads {
            out.append(Item(group: "Message", label: Chat.isDesk(t, store.threadList?.desk) ? "dibs" : store.threadName(t), run: {
                store.chosen = nil
                store.replyTo = t.to
                store.section = .messages
            }))
        }
        for s in Speed.all + [Speed("off")] {
            out.append(Item(group: "Speed", label: s.pace == "off" ? "Off" : s.title, hint: store.board?.machine.pace == s.pace ? "now" : "",
                            run: { Task { await store.setPace(s.pace) } }))
        }
        out.append(Item(group: "Pair", label: "Pair a browser or Claude", run: { store.pairing = true }))
        out.append(Item(group: "Pair", label: "Pair a phone", run: { store.pairing = true }))
        return out
    }

    private func pick(_ item: Item) {
        dismiss()
        // After the palette is gone: a job's sheet can't open while this one is still closing.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { item.run() }
    }
}
