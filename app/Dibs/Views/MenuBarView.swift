import SwiftUI

// The menu bar item: the icon's ticket, plain while nothing needs the person,
// amber with a count when something does. It lives as long as the app, so it
// also opens the window when a notification is clicked while the window is closed.
struct MenuBarLabel: View {
    @Environment(Store.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        // Only questions waiting on the person's answer count here.
        Image(nsImage: Self.glyph(count: store.asks.count))
            .accessibilityLabel(store.asks.isEmpty ? "dibs: no questions for you" : "dibs: \(store.asks.count) waiting on your answer")
            .onChange(of: store.openRequest) { _, section in
                guard let section else { return }
                store.section = section
                store.openRequest = nil
                openWindow(id: "main")
                NSApp.activate()
            }
    }

    // A status item shows one image, so the ticket and the count are drawn
    // together. Plain, it's a template the menu bar tints like its neighbors;
    // with a count it takes the logo's red so it stands out.
    static func glyph(count: Int) -> NSImage {
        let label = count > 0 ? "\(count)" as NSString : nil
        let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let textWidth = label.map { ceil($0.size(withAttributes: [.font: font]).width) + 4 } ?? 0
        let size = NSSize(width: 19 + textWidth, height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            let color = count > 0 ? Palette.rgb(0xF0281E) : NSColor.black
            let ticket = NSBezierPath(roundedRect: NSRect(x: 1, y: 3, width: 17, height: 10.5), xRadius: 2.2, yRadius: 2.2)
            ticket.append(NSBezierPath(ovalIn: NSRect(x: -1.6, y: 5.6, width: 5.2, height: 5.2)).reversed)
            ticket.append(NSBezierPath(ovalIn: NSRect(x: 15.4, y: 5.6, width: 5.2, height: 5.2)).reversed)
            color.setFill()
            ticket.fill()
            // The perforation, punched out.
            NSGraphicsContext.current?.compositingOperation = .destinationOut
            for i in 0..<4 { NSBezierPath(ovalIn: NSRect(x: 5.6, y: 4.4 + CGFloat(i) * 2.2, width: 1.3, height: 1.3)).fill() }
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            if let label {
                label.draw(at: NSPoint(x: 22, y: 1), withAttributes: [.font: font, .foregroundColor: color])
            }
            return true
        }
        image.isTemplate = count == 0
        return image
    }
}

struct MenuBarView: View {
    @Environment(Store.self) private var store
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let error = store.boardError, store.board == nil {
                Text(error.kind == .notInstalled ? "dibs isn't installed." : error.message)
                    .foregroundStyle(Palette.ink2)
                    .lineLimit(3)
                    .padding(Space.l)
            } else {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(store.status.headline)
                        .font(Typeface.title)
                        .foregroundStyle(store.needs.isEmpty && store.asks.isEmpty ? Palette.ink : Palette.accentInk)
                    Text(store.status.detail)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                    if let f = store.freshness(), f.stale {
                        Text(f.text)
                            .font(Typeface.small.weight(.medium))
                            .foregroundStyle(Palette.accentInk)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(Space.l)
                ForEach(store.asks.prefix(3)) { item in
                    Divider().overlay(Palette.hairline)
                    MenuAsk(item: item)
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.m)
                }
                if store.asks.count > 3 {
                    Divider().overlay(Palette.hairline)
                    Button("\(store.asks.count - 3) more in Questions") { open(.questions) }
                        .buttonStyle(.plain)
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink2)
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.s)
                }
                // dibs's alerts that need the person, with their fix; failed jobs stay in the window.
                ForEach(store.openAlerts.filter { $0.level != "note" }.prefix(3)) { alert in
                    Divider().overlay(Palette.hairline)
                    VStack(alignment: .leading, spacing: Space.xs) {
                        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                            StateDot(kind: alert.level == "urgent" ? .running : .waiting)
                            Text(alert.title).font(Typeface.headline).foregroundStyle(Palette.ink).lineLimit(3)
                        }
                        Text("Fix: \(alert.fix)").font(Typeface.small).foregroundStyle(Palette.ink2).lineLimit(3)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Space.l)
                    .padding(.vertical, Space.m)
                }
                ForEach(store.needs.prefix(3)) { need in
                    Divider().overlay(Palette.hairline)
                    NeedBody(need: need, compact: true)
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.m)
                }
                if store.needs.count > 3 {
                    Divider().overlay(Palette.hairline)
                    Text("\(store.needs.count - 3) more on Now")
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink2)
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.s)
                }
            }
            Divider().overlay(Palette.hairline)
            HStack {
                Button("Open dibs") { open(store.asks.isEmpty ? .now : .questions) }
                    .buttonStyle(InkButton())
                    .keyboardShortcut("o")
                Button("Queues") { open(.queues) }
                    .buttonStyle(InkButton())
                if store.webSupported {
                    Button("Pair\u{2026}") {
                        store.pairing = true
                        openWindow(id: "main")
                        NSApp.activate()
                    }
                    .buttonStyle(InkButton())
                    .help("Pair a browser or Claude")
                }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut("q")
                    .buttonStyle(.plain)
                    .foregroundStyle(Palette.ink3)
            }
            .padding(.horizontal, Space.l)
            .padding(.vertical, Space.m)
        }
        .frame(width: 360, alignment: .leading)
        .background(Palette.canvas)
        .onAppear { store.menuOpen = true }
        .onDisappear { store.menuOpen = false }
    }

    private func open(_ section: Store.Section) {
        store.section = section
        openWindow(id: "main")
        NSApp.activate()
    }
}

// A question waiting on the person, short enough for the menu: who, what,
// and the options. Other words need the window.
struct MenuAsk: View {
    @Environment(Store.self) private var store
    @Environment(\.openWindow) private var openWindow
    let item: ChatItem

    var body: some View {
        let q = item.question
        VStack(alignment: .leading, spacing: Space.s) {
            Text("\(Text(store.chatName(item)).foregroundStyle(Palette.ink)) needs your answer")
                .font(Typeface.headline)
                .foregroundStyle(Palette.ink2)
            Text(item.text)
                .foregroundStyle(Palette.ink)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
            if let pick = q?.recommend {
                Text("Recommends: \(pick)")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink2)
            }
            Flow(spacing: Space.s) {
                ForEach(q?.options ?? [], id: \.self) { option in
                    Button(option == q?.recommend ? "\(option) (recommended)" : option) {
                        Task { await store.answer(questionId: q?.id ?? "", option, agent: item.agent) }
                    }
                    .buttonStyle(InkButton(prominent: option == q?.recommend))
                }
                Button("Reply\u{2026}") {
                    store.section = .questions
                    openWindow(id: "main")
                    NSApp.activate()
                }
                .buttonStyle(InkButton(prominent: q?.options.isEmpty ?? true))
            }
            .disabled(store.running.contains("q-\(q?.id ?? "")"))
        }
    }
}
