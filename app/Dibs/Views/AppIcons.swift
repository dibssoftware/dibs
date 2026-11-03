import AppKit
import SwiftUI

// The logo in a few colorways the person can pick from in Settings. The
// bundle's icon is the first; a pick shows in the Dock while dibs runs.
enum IconChoice: String, CaseIterable, Identifiable {
    case yellow, red, classic, paper

    var id: String { rawValue }

    var title: String {
        switch self {
        case .yellow: "Yellow"
        case .red: "Red"
        case .classic: "Amber"
        case .paper: "Paper"
        }
    }

    // Background, ticket, the queue's lines.
    var colors: (bg: Int, ticket: Int, lines: Int) {
        switch self {
        case .yellow: (0x1E1C1A, 0xFFB000, 0xF0281E)
        case .red: (0x1E1C1A, 0xF0281E, 0xFFB000)
        case .classic: (0x1E1C1A, 0xF3A640, 0x24201A)
        case .paper: (0xF4F2EE, 0x111113, 0xFFB000)
        }
    }

    @MainActor static var current: IconChoice {
        get { UserDefaults.standard.string(forKey: "icon").flatMap(IconChoice.init(rawValue:)) ?? .yellow }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "icon")
            newValue.apply()
        }
    }

    // The bundle already carries the first colorway; the others are drawn.
    @MainActor
    func apply() {
        if self == .yellow {
            NSApp.applicationIconImage = nil
            return
        }
        let renderer = ImageRenderer(content: AppIconArt(choice: self, size: 512, dockInset: true))
        renderer.scale = 2
        if let image = renderer.nsImage { NSApp.applicationIconImage = image }
    }
}

// The logo drawn at any size, from the same measurements as brand/make_icon.py
// on a 1024 canvas: a 700 by 420 ticket, notches of 58, a perforation 236 in,
// and three lines of 300, 230 and 160.
struct AppIconArt: View {
    let choice: IconChoice
    var size: CGFloat = 64
    // The Dock wants macOS's margin around the rounded square.
    var dockInset = false

    var body: some View {
        let c = choice.colors
        let k = size / 1024
        let square = dockInset ? size * 824 / 1024 : size
        ZStack {
            RoundedRectangle(cornerRadius: square * 0.225, style: .continuous)
                .fill(Color(nsColor: Palette.rgb(c.bg)))
                .frame(width: square, height: square)
                .shadow(color: .black.opacity(dockInset ? 0.25 : 0), radius: size * 0.02, y: size * 0.01)
            let s = square / size
            ZStack(alignment: .topLeading) {
                TicketShape(corner: 44 * k, notch: 58 * k)
                    .fill(Color(nsColor: Palette.rgb(c.ticket)))
                    .frame(width: 700 * k, height: 420 * k)
                // The perforation, punched in the background's color.
                VStack(spacing: 24 * k) {
                    ForEach(0..<7, id: \.self) { _ in
                        Circle().fill(Color(nsColor: Palette.rgb(c.bg))).frame(width: 26 * k, height: 26 * k)
                    }
                }
                .offset(x: 223 * k, y: 34 * k)
                VStack(alignment: .leading, spacing: 36 * k) {
                    ForEach([300.0, 230, 160], id: \.self) { w in
                        Capsule().fill(Color(nsColor: Palette.rgb(c.lines))).frame(width: w * k, height: 36 * k)
                    }
                }
                .offset(x: 316 * k, y: 118 * k)
            }
            .frame(width: 700 * k, height: 420 * k, alignment: .topLeading)
            .scaleEffect(s)
            .offset(y: 10 * k * s)
        }
        .frame(width: size, height: size)
    }
}
