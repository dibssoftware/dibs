import AppKit
import CoreText
import SwiftUI

// Clean and bright: near-white or near-black, crisp ink, and one vivid red
// for what's running now and what needs the person, with a deep yellow for
// what's waiting and next, the logo's two colors. Surfaces are set apart by
// a hairline and a soft shadow.
enum Palette {
    static let canvas = dynamic(light: 0xF6F6F4, dark: 0x0F0F10)
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x19191B)
    static let sunken = dynamic(light: 0xEEEEEB, dark: 0x252527)
    static let ink = dynamic(light: 0x111113, dark: 0xF4F4F5)
    static let ink2 = dynamic(light: 0x55555B, dark: 0xB4B4BA)
    static let ink3 = dynamic(light: 0x8E8E94, dark: 0x7A7A80)
    static let hairline = Color(nsColor: NSColor(name: nil) { a in
        a.isDark ? NSColor(white: 1, alpha: 0.09) : NSColor(white: 0, alpha: 0.08)
    })
    // Borders: a hairline, so surfaces separate without shouting.
    static let edge = hairline
    // The red: fills, bars, the line at now.
    static let accent = Color(nsColor: rgb(0xFF2B1F))
    // The red as text: a touch deeper on white so it reads.
    static let accentInk = dynamic(light: 0xE01A10, dark: 0xFF4A3D)
    static let accentWash = Color(nsColor: NSColor(name: nil) { a in
        rgb(0xFF2B1F).withAlphaComponent(a.isDark ? 0.2 : 0.12)
    })
    // Text on a solid red fill.
    static let onAccent = Color.white
    // The person's own messages.
    static let mine = dynamic(light: 0xFFDCD8, dark: 0x4A1410)
    static let failed = dynamic(light: 0xE01A10, dark: 0xFF4A3D)
    // Busy and fine: a vivid green, for calm dots and passed jobs.
    static let working = dynamic(light: 0x00A85A, dark: 0x22D47B)
    // The logo's red ticket and the deep yellow of its queue.
    static let ticket = Color(nsColor: rgb(0xF0281E))
    // Waiting and next: the logo's deep yellow, with ink on it.
    static let yellow = Color(nsColor: rgb(0xFFB000))
    static let onYellow = Color(nsColor: rgb(0x111113))
    // The ink the icon's ticket sits on, the same in both modes.
    static let iconInk = Color(nsColor: rgb(0x1E1C1A))
    // The page's --surface: the panel every screen sits on, a little
    // see-through so the backdrop's dither reads under it.
    static let panel = Color(nsColor: NSColor(name: nil) { a in
        a.isDark ? rgb(0x19191B).withAlphaComponent(0.88) : NSColor(white: 1, alpha: 0.86)
    })
    // The lit top edge of a well (--sunken-light).
    static let lit = Color(nsColor: NSColor(name: nil) { a in NSColor(white: 1, alpha: a.isDark ? 0.07 : 0.9) })
    // The page's --hover: rows lighten or darken under the pointer, never change hue.
    static let hover = Color(nsColor: NSColor(name: nil) { a in NSColor(white: a.isDark ? 1 : 0, alpha: a.isDark ? 0.06 : 0.045) })
    // The page's --shadow, near and far.
    static let shadowNear = Color(nsColor: NSColor(name: nil) { a in NSColor(white: 0, alpha: a.isDark ? 0.4 : 0.05) })
    static let shadowFar = Color(nsColor: NSColor(name: nil) { a in NSColor(white: 0, alpha: a.isDark ? 0.35 : 0.05) })

    private static func dynamic(light: Int, dark: Int) -> Color {
        Color(nsColor: NSColor(name: nil) { $0.isDark ? rgb(dark) : rgb(light) })
    }

    static func rgb(_ hex: Int) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
}

// Schibsted Grotesk, the web page's face, at the page's sizes (web/app.css):
// a 40 point title, 17 point section heads, 14 point rows. The font file is
// web/SchibstedGrotesk.woff2 itself, bundled and registered at launch, so the
// two can never drift apart. It's variable (weight 400 to 900), so .weight()
// at a call site moves along the axis like it would on SF Pro.
enum Typeface {
    static let family = "Schibsted Grotesk"

    static let display = sized(40, .bold)
    static let title = sized(17, .semibold)
    // A section's heading on a page (section h2: 17px, 650).
    static let section = exact(17, 650)
    static let name = sized(14, .semibold)
    static let headline = sized(14, .semibold)
    static let body = sized(14)
    static let lede = sized(17)
    static let small = sized(12.5)
    static let eyebrow = sized(12, .semibold)
    static let time = sized(13, .semibold).monospacedDigit()
    static let figure = sized(28, .bold).monospacedDigit()
    static let button = sized(13.5, .semibold)
    // SF Symbols keep the system face: they're drawn to match it.
    static let glyph = Font.system(size: 15, weight: .semibold)
    static let chevron = Font.system(size: 10, weight: .semibold)
    static let question = sized(19, .semibold)
    static let send = sized(12, .bold)
    // A chart's axis (.chart .ax: 11px, 550).
    static let axis = sized(11, .medium)

    static func sized(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(family, size: size).weight(weight)
    }

    // A CSS weight between SwiftUI's steps (650 for headings, 560 for the
    // rail). Such a font ignores .weight(), so it's only for text that never
    // changes weight.
    static func exact(_ size: CGFloat, _ weight: CGFloat) -> Font {
        let d = CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: family,
                                                      kCTFontVariationAttribute: [wght: weight]] as CFDictionary)
        return Font(CTFontCreateWithFontDescriptor(d, size, nil))
    }

    // The variation axis tag 'wght'.
    private static let wght = 0x7767_6874

    // Once, before the first window: the face from the app's own resources.
    static func register() {
        guard let url = Bundle.main.url(forResource: "SchibstedGrotesk", withExtension: "woff2") else { return }
        CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
}

// A 4-point grid.
enum Space {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 36
}

// The icon's ticket: a rounded rectangle with a half-circle bitten out of
// each side. `stub` is where the perforation runs, as a share of the width.
struct TicketShape: InsettableShape {
    var corner: CGFloat = 9
    var notch: CGFloat = 7
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: inset, dy: inset)
        var p = Path(roundedRect: r, cornerRadius: corner, style: .continuous)
        let n = notch - inset
        guard n > 0 else { return p }
        p = p.subtracting(Path(ellipseIn: CGRect(x: r.minX - n, y: r.midY - n, width: n * 2, height: n * 2)))
        p = p.subtracting(Path(ellipseIn: CGRect(x: r.maxX - n, y: r.midY - n, width: n * 2, height: n * 2)))
        return p
    }

    func inset(by amount: CGFloat) -> TicketShape {
        var t = self
        t.inset += amount
        return t
    }
}

// The dotted tear line between a ticket's stub and its body.
struct Perforation: View {
    var color: Color = Palette.hairline

    var body: some View {
        Canvas { context, size in
            let count = max(2, Int(size.height / 7))
            let step = size.height / CGFloat(count)
            for i in 0..<count {
                let dot = CGRect(x: 0, y: step * (CGFloat(i) + 0.5) - 1.25, width: 2.5, height: 2.5)
                context.fill(Path(ellipseIn: dot), with: .color(color))
            }
        }
        .frame(width: 2.5)
        .padding(.vertical, 8)
        .accessibilityHidden(true)
    }
}

// The quiet label over a group: "Needs you", "Queues".
struct Eyebrow: View {
    let text: String
    var trailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(text)
                .font(Typeface.eyebrow)
                .foregroundStyle(Palette.ink2)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
            }
        }
    }
}

// Buttons: a red one for the action that matters, a quiet one for the rest.
struct InkButton: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typeface.button)
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(prominent ? Palette.onAccent : Palette.ink)
            .padding(.horizontal, 13)
            .padding(.vertical, 7)
            .background(prominent ? Palette.accent : Palette.sunken, in: Capsule())
            // The page's .btn: a well with a hairline and a lit top edge.
            .overlay {
                if !prominent {
                    Capsule().strokeBorder(Palette.hairline.opacity(0.6))
                        .overlay(alignment: .top) { Capsule().fill(Palette.lit).frame(height: 1).padding(.horizontal, 10) }
                }
            }
            .opacity(configuration.isPressed ? 0.8 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
            .contentShape(Capsule())
    }
}

extension View {
    // The panel's scrolling page: the whole width, as on the web page, where
    // the jobs' timeline runs edge to edge and prose keeps its own measure.
    func page() -> some View {
        ScrollView {
            self
                // The page's .panel padding: 36 on top, 44 at the sides, 72 below.
                .padding(.horizontal, 44)
                .padding(.top, 36)
                .padding(.bottom, 72)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .defaultScrollAnchor(.top)
        .scrollContentBackground(.hidden)
    }

    // A card: a step lighter than the page, a hairline, a soft shadow. The
    // shadow is the shape's alone, so the card's contents are drawn straight,
    // never through an offscreen shadow layer (cards on Home were seen with
    // their text and buttons upside down).
    func card(_ radius: CGFloat = 12, fill: Color = Palette.surface) -> some View {
        background {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(fill)
                .shadow(color: .black.opacity(0.04), radius: 1, y: 1)
        }
        .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Palette.hairline))
    }

    // Text the person may want to paste elsewhere: Copy on right-click.
    // Not .textSelection, which puts an AppKit text view inside the card:
    // the text and everything under it in a card was seen upside down.
    func copyable(_ text: String) -> some View {
        contextMenu {
            Button("Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }
}

extension View {
    // A text field's box: sunk a step into the card.
    func field() -> some View {
        padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Palette.sunken, in: .rect(cornerRadius: 10, style: .continuous))
    }
}

// A screen with nothing on it: a picture in a soft circle and one line.
struct Quiet: View {
    let symbol: String
    let title: String
    var detail: String? = nil

    var body: some View {
        HStack(spacing: Space.l) {
            Image(systemName: symbol)
                .font(Typeface.sized(18, .semibold))
                .foregroundStyle(Palette.working)
                .frame(width: 44, height: 44)
                .background(Palette.working.opacity(0.14), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typeface.title)
                    .foregroundStyle(Palette.ink)
                if let detail {
                    Text(detail)
                        .foregroundStyle(Palette.ink3)
                }
            }
        }
        .padding(.vertical, Space.s)
    }
}

// An agent's look in a conversation: a monogram on a muted color picked
// from its name, so the same agent always looks the same.
struct AgentTile: View {
    let name: String
    var size: CGFloat = 32

    // The same loud set as the resources, minus red, which means "needs you".
    private static let hues: [(light: Int, dark: Int)] = [
        (0x2F5BFF, 0x2F5BFF), (0x00C266, 0x00C266), (0xFF3EA5, 0xFF3EA5), (0x8A4DFF, 0x8A4DFF),
        (0xFF8A00, 0xFF8A00), (0x00B8F5, 0x00B8F5), (0xFFD000, 0xFFD000), (0xC4F235, 0xC4F235),
    ]

    var body: some View {
        let hue = Self.hues[Self.index(name)]
        let lum = 0.299 * Double((hue.light >> 16) & 0xFF) + 0.587 * Double((hue.light >> 8) & 0xFF) + 0.114 * Double(hue.light & 0xFF)
        Text(Format.monogram(name))
            .font(Typeface.sized(size * 0.38, .bold))
            .foregroundStyle(lum > 150 ? Color(nsColor: Palette.rgb(0x111113)) : .white)
            .frame(width: size, height: size)
            .background(Color(nsColor: Palette.rgb(hue.light)), in: Circle())
            .accessibilityHidden(true)
    }

    // A steady hash: Swift's own hashValue changes every launch.
    static func index(_ name: String) -> Int {
        Int(name.unicodeScalars.reduce(UInt32(5381)) { ($0 << 5) &+ $0 &+ $1.value } % UInt32(hues.count))
    }
}

// Each kind of resource keeps one loud color everywhere it shows: its chip
// in the sidebar, its pill on a row, its block on the timeline. Red stays the
// app's own color for what's running and what needs the person.
enum Tint {
    private static let fixed: [String: Int] = [
        "sim": 0x2F5BFF, "sim-own": 0x8A4DFF, "xcode-build": 0x00C266, "playwright": 0xFF3EA5,
        "test": 0x00B8F5, "deploy": 0xFF8A00, "heavy": 0x64748B,
    ]
    // For quotas and names dibs doesn't know, picked by a steady hash.
    private static let spare = [0x00D1B2, 0xB44DFF, 0x3DDC84, 0x4D7CFF, 0xE879F9]

    static func hex(_ res: String) -> Int {
        if let h = fixed[res] { return h }
        // Every file lock shares one color: they're one group.
        if res == "files" || res.hasPrefix("files:") { return 0xC4F235 }
        let n = res.unicodeScalars.reduce(UInt32(5381)) { ($0 << 5) &+ $0 &+ $1.value }
        return spare[Int(n % UInt32(spare.count))]
    }

    static func of(_ res: String) -> Color { Color(nsColor: Palette.rgb(hex(res))) }

    // Black or white text, whichever reads on the color.
    static func on(_ res: String) -> Color {
        let h = hex(res)
        let lum = 0.299 * Double((h >> 16) & 0xFF) + 0.587 * Double((h >> 8) & 0xFF) + 0.114 * Double(h & 0xFF)
        return lum > 150 ? Color(nsColor: Palette.rgb(0x0D0D0D)) : .white
    }

    static func wash(_ res: String) -> Color {
        let base = Palette.rgb(hex(res))
        return Color(nsColor: NSColor(name: nil) { a in base.withAlphaComponent(a.isDark ? 0.22 : 0.14) })
    }

    // The color as text on its wash: deeper on white, lighter on black.
    static func ink(_ res: String) -> Color {
        let base = Palette.rgb(hex(res))
        return Color(nsColor: NSColor(name: nil) { a in
            a.isDark ? base.blended(withFraction: 0.25, of: .white)! : base.blended(withFraction: 0.3, of: .black)!
        })
    }
}

// A resource's mark: a dot of its color.
struct ResDot: View {
    let res: String
    var size: CGFloat = 8

    var body: some View {
        Circle().fill(Tint.of(res)).frame(width: size, height: size).accessibilityHidden(true)
    }
}

// A resource's name on a wash of its color.
struct ResPill: View {
    let res: String
    var prefix = ""

    var body: some View {
        Text(prefix + Plain.name(res))
            .font(Typeface.small.weight(.semibold))
            .foregroundStyle(Tint.ink(res))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Tint.wash(res), in: Capsule())
    }
}

// The label over a column or a figure: "Time left", "Waiting".
struct ColumnLabel: View {
    let text: String

    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(Typeface.small.weight(.medium))
            .foregroundStyle(Palette.ink3)
            .lineLimit(1)
            .fixedSize()
    }
}

// How full something is: a solid bar in a quiet track.
struct Bar: View {
    let fill: Double
    var color: Color = Palette.accent
    var height: CGFloat = 6

    var body: some View {
        Capsule()
            .fill(Palette.sunken)
            .frame(height: height)
            .overlay {
                Capsule()
                    .fill(color)
                    .scaleEffect(x: max(0.06, min(1, fill)), anchor: .leading)
                    .animation(.easeOut(duration: 0.5), value: fill)
            }
            .accessibilityHidden(true)
    }
}

// Figures side by side, each its own card. One that needs attention fills red. When they don't fit on one row, the first
// three go over the rest.
struct Tiles<Content: View>: View {
    // Narrower than this and a tile's number and trend line stop reading.
    static var minTile: CGFloat { 128 }
    @ViewBuilder let content: Content

    var body: some View {
        Group(subviews: content) { tiles in
            ViewThatFits(in: .horizontal) {
                row(Array(tiles))
                // Split as evenly as they go: 3 over 2, 2 over 2.
                VStack(spacing: Space.m) {
                    row(Array(tiles.prefix((tiles.count + 1) / 2)))
                    row(Array(tiles.dropFirst((tiles.count + 1) / 2)))
                }
            }
        }
    }

    private func row(_ tiles: [Subview]) -> some View {
        HStack(spacing: Space.m) {
            ForEach(Array(tiles.enumerated()), id: \.offset) { _, tile in
                tile.frame(minWidth: Self.minTile, maxWidth: .infinity)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct Tile<Footer: View>: View {
    let label: String
    let value: String
    // Fills the tile red: something here wants the person's eye.
    var hot = false
    // Fills it the logo's yellow: something is waiting, nothing is wrong.
    var waiting = false
    // The past hours of this figure, oldest first, drawn beside the number.
    var trend: [Double] = []
    var trendColor: Color = Palette.ink
    @ViewBuilder let footer: Footer

    private var onFill: Color? { hot ? Palette.onAccent : waiting ? Palette.onYellow : nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label)
                .font(Typeface.small.weight(.medium))
                .foregroundStyle(onFill?.opacity(0.8) ?? Palette.ink2)
                .lineLimit(1)
            // The trend line only when there's room for it beside the number.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .bottom, spacing: Space.s) {
                    number.fixedSize()
                    if trend.count > 1 {
                        Sparkline(values: trend, color: onFill ?? trendColor)
                            .frame(width: 52, height: 26)
                            .padding(.bottom, 6)
                    }
                }
                number
            }
            footer
                .font(Typeface.small)
                .foregroundStyle(onFill?.opacity(0.85) ?? Palette.ink3)
                .lineLimit(1)
                .frame(height: 14, alignment: .leading)
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(14, fill: hot ? Palette.accent : waiting ? Palette.yellow : Palette.surface)
        .accessibilityElement(children: .combine)
    }

    private var number: some View {
        Text(value)
            .font(Typeface.figure)
            .foregroundStyle(onFill ?? Palette.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.55)
            .contentTransition(.numericText())
    }
}

// A figure's last hours as a small line with a soft fill under it, ending in
// a dot at now.
struct Sparkline: View {
    let values: [Double]
    var color: Color = Palette.ink3

    var body: some View {
        Canvas { context, size in
            let top = max(values.max() ?? 1, 0.0001)
            let step = size.width / CGFloat(max(1, values.count - 1))
            let points = values.enumerated().map { i, v in
                CGPoint(x: CGFloat(i) * step, y: size.height * (1 - CGFloat(v / top) * 0.9) - 1)
            }
            var area = Path { p in p.addLines(points) }
            area.addLine(to: CGPoint(x: points.last!.x, y: size.height))
            area.addLine(to: CGPoint(x: 0, y: size.height))
            area.closeSubpath()
            context.fill(area, with: .linearGradient(Gradient(colors: [color.opacity(0.22), color.opacity(0)]),
                                                    startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
            context.stroke(Path { p in p.addLines(points) }, with: .color(color),
                           style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            let end = points.last!
            context.fill(Path(ellipseIn: CGRect(x: end.x - 2, y: end.y - 2, width: 4, height: 4)), with: .color(color))
        }
        .accessibilityHidden(true)
    }
}

// The machine's figures: what's running and waiting, how hard it's working,
// and what's left of memory and disk.
struct MachineTiles: View {
    let counters: [Counter]
    let load: Double?
    let ceiling: Double?
    let memFree: Double?
    let diskFree: Double?
    // The memory dibs shares out to jobs, and how much running jobs have.
    // Only this Mac's board says.
    var memHandedOut: Double? = nil
    var memBudget: Double? = nil
    // Only known for this Mac's own disk; without it the disk shows no bar.
    var diskTotal: Double? = nil
    // The past day by hour, for each figure's trend line. Only this Mac's.
    var history: History? = nil

    // The last 12 hours of one figure.
    private func trend(_ value: (History.Hour) -> Double?) -> [Double] {
        Array((history?.hourly ?? []).suffix(12)).compactMap(value)
    }

    var body: some View {
        // Held files aren't jobs; they're counted in the footer instead.
        let running = counters.queues.runningCount
        let holding = Set(counters.fileLocks.flatMap(\.serving).map(\.who)).count
        let waiting = counters.waitingCount
        let longest = counters.flatMap(\.waiting).map(\.since).min()
        Tiles {
            Tile(label: "Running", value: "\(running)", trend: trend(\.held)) {
                let queues = counters.queues.filter { !$0.serving.isEmpty }.count
                Text(running == 0 ? "Nothing right now" : queues == 1 ? "In 1 queue" : "In \(queues) queues")
                    .help(holding == 0 ? "" : holding == 1 ? "1 agent is also holding files" : "\(holding) agents are also holding files")
            }
            Tile(label: "Waiting", value: "\(waiting)", waiting: waiting > 0,
                 trend: trend { $0.waiting }, trendColor: Palette.yellow) {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(longest.map { "Longest \(Span.of(context.date.timeIntervalSince($0)))" } ?? "Nobody in line")
                }
            }
            if let load {
                let share = load / max(1, ceiling ?? 8)
                Tile(label: "Workload", value: share >= 1 ? "Hot" : share >= 0.5 ? "Busy" : "Calm", hot: share >= 1,
                     trend: trend(\.load), trendColor: share >= 0.5 ? Palette.accent : Palette.working) {
                    HStack(spacing: 6) {
                        Circle().fill(share >= 1 ? Palette.onAccent : share >= 0.5 ? Palette.accent : Palette.working).frame(width: 7, height: 7)
                        Text(String(format: "Load %.1f", load))
                            .help(ceiling.map { String(format: "Load %.1f of %.0f", load, $0) } ?? "")
                    }
                }
            }
            if let memBudget, memBudget > 0, let memHandedOut {
                // What dibs starts work by: the Mac can have plenty free while
                // the memory set aside for agents is all handed out, and then
                // jobs wait for "room in memory". Showing only the Mac's free
                // memory said calm while eight jobs waited.
                let left = max(0, memBudget - memHandedOut)
                let full = left < Self.memFull
                Tile(label: "Memory for agents", value: full ? "Full" : "\(Format.gb(left)) left", hot: (memFree ?? 100) < 15,
                     waiting: full && (memFree ?? 100) >= 15) {
                    Text(memFree.map { "\(Int($0))% free on this Mac" } ?? "Of \(Format.gb(memBudget))")
                        .help("Running jobs have \(Format.gb(memHandedOut)) of the \(Format.gb(memBudget)) dibs sets aside for agents.")
                }
            } else if let memFree {
                Tile(label: "Free memory", value: "\(Int(memFree))%", hot: memFree < 15) {
                    Bar(fill: memFree / 100, color: memFree < 15 ? Palette.onAccent : Palette.working)
                        .frame(maxWidth: 110)
                }
            }
            if let diskFree {
                // Under 10 GB, builds start failing.
                Tile(label: "Free disk", value: Format.gb(diskFree), hot: diskFree < 10e9) {
                    if let diskTotal {
                        Bar(fill: diskFree / diskTotal, color: diskFree < 10e9 ? Palette.onAccent : Palette.working)
                            .frame(maxWidth: 110)
                    } else {
                        Text(diskFree < 10e9 ? "Running low" : "Plenty")
                    }
                }
            }
        }
    }

    // Under half a gigabyte left is no room for any real job.
    static let memFull: Double = 0.5 * 1_073_741_824

    // This Mac's disk size, for the disk bar.
    static let localDiskTotal: Double? = (try? URL(fileURLWithPath: NSHomeDirectory())
        .resourceValues(forKeys: [.volumeTotalCapacityKey]).volumeTotalCapacity).flatMap { $0.map(Double.init) }
}

// A capsule for a short fact: a place in line, a time, a count, a tag. Hot
// is solid red for what's running now or needs the person; plain is a soft
// grey; faint is just a hairline.
struct Pill<Content: View>: View {
    enum Tone { case plain, hot, next, faint }
    var tone: Tone = .plain
    @ViewBuilder let content: Content

    var body: some View {
        content
            .font(Typeface.small.weight(.semibold))
            .foregroundStyle(tone == .hot ? Palette.onAccent : tone == .next ? Palette.onYellow : tone == .faint ? Palette.ink3 : Palette.ink2)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tone == .hot ? Palette.accent : tone == .next ? Palette.yellow : tone == .faint ? Color.clear : Palette.sunken, in: Capsule())
            .overlay(Capsule().strokeBorder(tone == .faint ? Palette.hairline : .clear))
    }
}

extension Pill where Content == Text {
    init(_ text: String, tone: Tone = .plain) {
        self.init(tone: tone) { Text(text) }
    }
}

// Chips in rows, wrapping to the next row when one runs out of width.
struct Flow: Layout {
    var spacing: CGFloat = Space.s

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(subviews, width: proposal.width ?? .infinity)
        return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.last.map { $0.y + $0.height } ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for row in arrange(subviews, width: bounds.width) {
            var x = bounds.minX
            for i in row.items {
                let size = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: bounds.minY + row.y + (row.height - size.height) / 2), proposal: .unspecified)
                x += size.width + spacing
            }
        }
    }

    private func arrange(_ subviews: Subviews, width: CGFloat) -> [(items: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] {
        var rows: [(items: [Int], y: CGFloat, width: CGFloat, height: CGFloat)] = []
        var items: [Int] = [], x: CGFloat = 0, y: CGFloat = 0, height: CGFloat = 0
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            if !items.isEmpty && x + size.width > width {
                rows.append((items, y, x - spacing, height))
                y += height + spacing
                items = []; x = 0; height = 0
            }
            items.append(i)
            x += size.width + spacing
            height = max(height, size.height)
        }
        if !items.isEmpty { rows.append((items, y, x - spacing, height)) }
        return rows
    }
}

// Chips in one row, as many as fit. The rest are left out whole rather than
// cut off or pushed into the next column; callers put them in a tooltip.
struct FitRow: Layout {
    var spacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let shown = fitting(subviews, width: proposal.width ?? .infinity)
        let sizes = shown.map { subviews[$0].sizeThatFits(.unspecified) }
        let width = sizes.map(\.width).reduce(0, +) + spacing * CGFloat(max(sizes.count - 1, 0))
        return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: sizes.map(\.height).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let shown = Set(fitting(subviews, width: bounds.width))
        var x = bounds.minX
        for i in subviews.indices {
            let size = subviews[i].sizeThatFits(.unspecified)
            guard shown.contains(i) else {
                // Out of sight; the caller clips to its bounds.
                subviews[i].place(at: CGPoint(x: bounds.maxX + 10_000, y: bounds.minY), proposal: .unspecified)
                continue
            }
            subviews[i].place(at: CGPoint(x: x, y: bounds.midY - size.height / 2), proposal: .unspecified)
            x += size.width + spacing
        }
    }

    private func fitting(_ subviews: Subviews, width: CGFloat) -> [Int] {
        var x: CGFloat = 0, shown: [Int] = []
        for i in subviews.indices {
            let w = subviews[i].sizeThatFits(.unspecified).width
            if x + w > width + 0.5 { break }
            shown.append(i)
            x += w + spacing
        }
        return shown
    }
}

// An agent as a person reads it: what it's working on, then which tool and
// its short handle, small. Without a title, just the name it gave dibs.
struct AgentLabel: View {
    @Environment(Store.self) private var store
    let who: String
    // A subagent's own name, after its session's.
    var sub: String? = nil
    var font: Font = Typeface.headline

    var body: some View {
        if let agent = store.agents.byName[who], let title = agent.title {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(sub.map { "\(title) \u{00B7} \($0)" } ?? title)
                    .font(font)
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                Text("\(agent.tool) \u{00B7} \(Self.handle(who))")
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
                    .fixedSize()
            }
            .help("\(agent.tool) session \(who)")
        } else {
            Text(sub.map { "\(who) \u{00B7} \($0)" } ?? who)
                .font(font)
                .foregroundStyle(Palette.ink)
                .lineLimit(1)
        }
    }

    // "alex-b8" is the person's name and the session's short id; the id is the part that tells sessions apart.
    static func handle(_ who: String) -> String {
        who.split(separator: "-").last.map(String.init) ?? who
    }
}

// The top of every screen, as on the web page: the day, the time and the
// machine in small grey, the title, then one plain sentence.
struct PageHead<Summary: View>: View {
    @Environment(Store.self) private var store
    let title: String
    var tint: Color = Palette.ink
    @ViewBuilder var summary: Summary

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text("\(context.date.formatted(.dateTime.weekday(.wide))), \(Format.clock(context.date))  \u{00B7}  \(store.hostName)")
                    .font(Typeface.eyebrow)
                    .foregroundStyle(Palette.ink3)
            }
            Text(title)
                .font(Typeface.display)
                // The page's h1: -0.03em, tight as display type should be.
                .tracking(-1.2)
                .foregroundStyle(tint)
                .contentTransition(.numericText())
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            summary
                .font(Typeface.lede)
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 620, alignment: .leading)
        }
        // Clear of the logo, which sits over the panel's top right corner.
        .padding(.trailing, 48)
    }
}

extension PageHead where Summary == Text {
    init(title: String, tint: Color = Palette.ink, summary: String) {
        self.init(title: title, tint: tint) { Text(summary) }
    }
}

// A section on a page: its heading, a quiet note on the right, then what's in it.
struct PageSection<Note: View, Content: View>: View {
    let title: String
    @ViewBuilder var note: Note
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s + 2) {
            HStack(alignment: .firstTextBaseline, spacing: Space.m) {
                Text(title)
                    .font(Typeface.section)
                    .tracking(-0.17)
                    .foregroundStyle(Palette.ink)
                Spacer(minLength: Space.s)
                note
                    .font(Typeface.small)
                    .foregroundStyle(Palette.ink3)
                    .lineLimit(1)
            }
            content
        }
    }
}

extension PageSection where Note == Text {
    init(_ title: String, note: String = "", @ViewBuilder content: () -> Content) {
        self.init(title: title, note: { Text(note) }, content: content)
    }
}

// One dot for a state, the same everywhere on the app and the web page:
// red running now, a red ring paused, yellow waiting in line, green busy and
// fine, a yellow ring late, a heavier red ring blocked, a grey ring done or idle.
struct StateDot: View {
    enum Kind { case running, paused, waiting, busy, late, blocked, idle }
    let kind: Kind
    var size: CGFloat = 8

    var body: some View {
        Group {
            switch kind {
            case .running: Circle().fill(Palette.accent).background(Circle().fill(Palette.accentWash).padding(-3))
            case .waiting: Circle().fill(Palette.yellow).background(Circle().fill(Palette.yellow.opacity(0.18)).padding(-3))
            case .busy: Circle().fill(Palette.working).background(Circle().fill(Palette.working.opacity(0.14)).padding(-3))
            case .paused: Circle().strokeBorder(Palette.accent, lineWidth: 1.5)
            case .late: Circle().strokeBorder(Palette.yellow, lineWidth: 1.5)
            case .blocked: Circle().strokeBorder(Palette.accent, lineWidth: 2)
            case .idle: Circle().strokeBorder(Palette.ink3, lineWidth: 1.5)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// The machine at the foot of the sidebar: how much room is left, red when
// it's short. Short is what dibs itself holds jobs for: under 15% memory
// free, under the 5 GB disk floor, load past the core count.
struct Meters: View {
    let name: String
    let machine: Machine

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s + 2) {
            Text(name)
                .font(Typeface.small.weight(.semibold))
                .foregroundStyle(Palette.ink2)
            if let free = machine.memFree {
                meter("Memory", "\(Int(free.rounded()))% free", used: 1 - free / 100, bad: free < 15)
            }
            if let disk = machine.diskFree {
                meter("Disk", "\(Format.gb(disk)) free", used: min(1, Self.floor / max(1, disk)), bad: disk < Self.floor)
            }
            if let load = machine.load {
                let cores = Double(machine.cores ?? 0)
                meter("Load", "\(String(format: "%.1f", load)) on \(machine.cores.map(String.init) ?? "?") cores",
                      used: cores > 0 ? load / cores : 0, bad: cores > 0 && load > cores)
            }
        }
    }

    // dibs's disk floor (src/config.mjs): below it, nothing new starts.
    static let floor = 5.0 * 1024 * 1024 * 1024

    private func meter(_ label: String, _ value: String, used: Double, bad: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).foregroundStyle(Palette.ink3)
                Spacer()
                Text(value)
                    .foregroundStyle(bad ? Palette.accentInk : Palette.ink2)
                    .fontWeight(.semibold)
            }
            .font(Typeface.sized(12))
            GeometryReader { g in
                RoundedRectangle(cornerRadius: 2).fill(Palette.sunken)
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2).fill(bad ? Palette.accent : Palette.ink3)
                            .frame(width: max(2, g.size.width * min(1, max(0, used))))
                    }
            }
            .frame(height: 4)
        }
    }
}
