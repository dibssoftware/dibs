import CoreImage
import SwiftUI

// Signing a browser or an MCP client into `dibs web`: one code from
// `dibs pair`, shown as a ticket, good once for ten minutes.
struct PairSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var copied: String?

    static let page = URL(string: "http://127.0.0.1:7421")!
    static let mcpLine = "claude mcp add --transport http dibs http://127.0.0.1:7421/mcp"

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Pair a browser or Claude")
                    .font(Typeface.display)
                    .foregroundStyle(Palette.ink)
                Text("The code signs in one browser or one MCP client. A browser can do what this app does. Claude gets read-only tools.")
                    .font(Typeface.lede)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if store.webSupported {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    code(now: context.date)
                }
                steps
                PhonePairing()
                VStack(alignment: .leading, spacing: Space.s) {
                    ColumnLabel("Signed in")
                    PairedList()
                }
            } else {
                NeedsWeb()
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(InkButton())
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(Space.xxl)
        // Wide enough for the whole claude mcp add line in one row.
        .frame(width: 600)
        .background(Palette.canvas)
        .task {
            await store.loadPairing()
            if store.webSupported && (store.pairCode.map { $0.expires < .now } ?? true) { await store.newPairCode() }
        }
    }

    @ViewBuilder
    private func code(now: Date) -> some View {
        let left = store.pairCode.map { $0.expires.timeIntervalSince(now) } ?? 0
        let live = left > 0
        HStack(spacing: Space.l) {
            ticket(code: store.pairCode?.code, left: left)
                .opacity(live ? 1 : 0.45)
            VStack(alignment: .leading, spacing: Space.s) {
                if live, let c = store.pairCode {
                    Button(copied == c.code ? "Copied" : "Copy code") { copy(c.code) }
                        .buttonStyle(InkButton(prominent: true))
                    Button("New code") { Task { await store.newPairCode() } }
                        .buttonStyle(InkButton())
                        .disabled(store.running.contains("pair"))
                } else {
                    Text(store.pairCode == nil ? "Getting a code\u{2026}" : "This code ran out.")
                        .font(Typeface.small)
                        .foregroundStyle(Palette.ink2)
                    Button("New code") { Task { await store.newPairCode() } }
                        .buttonStyle(InkButton(prominent: store.pairCode != nil))
                        .disabled(store.running.contains("pair"))
                }
            }
        }
    }

    // The stub says how long it's good for; the body holds the code.
    private func ticket(code: String?, left: TimeInterval) -> some View {
        HStack(spacing: 0) {
            VStack(spacing: 2) {
                Text(left > 0 ? Self.countdown(left) : "0:00")
                    .font(Typeface.time)
                Text("left")
                    .font(Typeface.eyebrow)
            }
            .foregroundStyle(Palette.onYellow)
            .frame(width: 70)
            Perforation(color: Palette.canvas.opacity(0.9))
            Text(code ?? "\u{2022}\u{2022}\u{2022}\u{2022}-\u{2022}\u{2022}\u{2022}\u{2022}")
                .font(.system(size: 34, weight: .bold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Palette.onYellow)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Space.l)
                .copyable(code ?? "")
        }
        .frame(height: 92)
        .background(TicketShape(corner: 12, notch: 11).fill(Palette.yellow))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(code.map { "Pairing code \($0), \(Self.countdown(left)) left" } ?? "No code yet")
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 0) {
            step("In a browser", "Open the page and type the code.") {
                Button("Open the page") { NSWorkspace.shared.open(Self.page) }
                    .buttonStyle(InkButton())
            }
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("In Claude Code").font(Typeface.headline).foregroundStyle(Palette.ink)
                        Text("Add the server, then type the code when Claude opens the sign-in page.")
                            .font(Typeface.small).foregroundStyle(Palette.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: Space.s)
                    Button(copied == Self.mcpLine ? "Copied" : "Copy") { copy(Self.mcpLine) }
                        .buttonStyle(InkButton())
                }
                Text(Self.mcpLine)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Palette.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .field()
                    .copyable(Self.mcpLine)
            }
            .padding(Space.l)
            .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            if store.webService?.running == false {
                HStack(alignment: .firstTextBaseline) {
                    Text("The page isn't running, so neither of these can reach it yet.")
                        .font(Typeface.small)
                        .foregroundStyle(Palette.accentInk)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: Space.s)
                    Button("Start it") { Task { await store.setWebService(on: true) } }
                        .buttonStyle(InkButton(prominent: true))
                        .disabled(store.running.contains("web-service"))
                }
                .padding(Space.l)
                .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
            }
        }
        .card()
    }

    private func step<C: View>(_ title: String, _ detail: String, @ViewBuilder trailing: () -> C) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typeface.headline).foregroundStyle(Palette.ink)
                Text(detail).font(Typeface.small).foregroundStyle(Palette.ink3)
            }
            Spacer(minLength: Space.s)
            trailing()
        }
        .padding(Space.l)
    }

    private func copy(_ s: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        copied = s
    }

    static func countdown(_ t: TimeInterval) -> String {
        let s = Int(t.rounded(.up))
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}

// Browsers and MCP clients signed in, each with Sign Out.
struct PairedList: View {
    @Environment(Store.self) private var store

    var body: some View {
        if let list = store.paired {
            if list.isEmpty {
                Text("Nothing is signed in.")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, client in
                        row(client, first: i == 0)
                    }
                    if list.count > 1 {
                        HStack {
                            Spacer()
                            Button("Sign out all") { Task { await store.signOut(nil) } }
                                .buttonStyle(InkButton())
                                .disabled(store.running.contains("revoke-all"))
                        }
                        .padding(.horizontal, Space.l)
                        .padding(.vertical, Space.m)
                        .overlay(alignment: .top) { Rectangle().fill(Palette.hairline).frame(height: 1) }
                    }
                }
                .card()
            }
        }
    }

    private func row(_ client: PairedClient, first: Bool) -> some View {
        HStack(spacing: Space.m) {
            Image(systemName: client.isPage ? "safari" : client.isRemote ? "iphone" : "sparkle")
                .font(Typeface.glyph)
                .foregroundStyle(Palette.ink2)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(client.name).font(Typeface.name).foregroundStyle(Palette.ink)
                Text("\(client.isRemote ? "Paired" : "Signed in") \(client.since)").font(Typeface.small).foregroundStyle(Palette.ink3)
            }
            Spacer(minLength: Space.s)
            Button("Sign out") { Task { await store.signOut(client) } }
                .buttonStyle(InkButton())
                .disabled(store.running.contains("revoke-\(client.id)"))
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }
}

// Said in place of pairing and progress when the dibs on PATH predates them.
struct NeedsWeb: View {
    @Environment(Store.self) private var store
    var what = "Pairing and the dibs page need"

    var body: some View {
        Text("\(what) dibs \(Store.webVersion) or newer. This Mac has \(store.version.map { "dibs \($0)" } ?? "an older dibs").")
            .foregroundStyle(Palette.ink2)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// A phone, or a browser away from this Mac: dibs pair --remote's link through
// the encrypted relay, as a QR code to scan. The web page's Settings has the same.
struct PhonePairing: View {
    @Environment(Store.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("On a phone").font(Typeface.headline).foregroundStyle(Palette.ink)
                    Text("Through the encrypted relay at app.dibs.cc. It can only look unless you let it act.")
                        .font(Typeface.small).foregroundStyle(Palette.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: Space.s)
                Button("Pair a phone to look") { Task { await store.pairRemote(act: false) } }
                    .buttonStyle(InkButton(prominent: true))
                Button("Pair a phone that can act") { Task { await store.pairRemote(act: true) } }
                    .buttonStyle(InkButton())
            }
            .disabled(store.running.contains("pair-remote"))
            TimelineView(.periodic(from: .now, by: 30)) { context in
                if let p = store.remotePair, context.date.timeIntervalSince(p.at) < 10 * 60 {
                    HStack(spacing: Space.l) {
                        QRCode(text: p.link).frame(width: 140, height: 140)
                        VStack(alignment: .leading, spacing: Space.s) {
                            Text(p.act ? "It can act: boost, pause, resume and stop jobs, cap agents, set the speed, cancel runs for later." : "It can only look.")
                                .foregroundStyle(Palette.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Good until \(Format.clock(p.at.addingTimeInterval(10 * 60))).").font(Typeface.small).foregroundStyle(Palette.ink3)
                            Text(p.link).font(.system(size: 11, design: .monospaced)).foregroundStyle(Palette.ink3).lineLimit(2).copyable(p.link)
                        }
                    }
                    .padding(Space.l)
                    .background(TicketShape(corner: 12, notch: 9).fill(Palette.surface))
                    .overlay(TicketShape(corner: 12, notch: 9).stroke(Palette.hairline))
                }
            }
        }
    }
}

// A QR code drawn by Core Image, sharp at any size.
struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.image(text) {
            Image(nsImage: image).interpolation(.none).resizable().scaledToFit()
                .padding(6).background(Color.white, in: .rect(cornerRadius: 6))
                .accessibilityLabel("QR code for the pairing link")
        }
    }

    static func image(_ text: String) -> NSImage? {
        guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        f.setValue(Data(text.utf8), forKey: "inputMessage")
        f.setValue("M", forKey: "inputCorrectionLevel")
        guard let ci = f.outputImage else { return nil }
        let rep = NSCIImageRep(ciImage: ci)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}
