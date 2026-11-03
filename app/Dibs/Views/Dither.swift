import AppKit
import SwiftUI

// The web page's backdrop (web/dither.js), drawn the same way: a slow field
// of interfering waves, ordered-dithered (8x8 Bayer) onto a 4 point grid and
// drawn faintly. The pointer lifts the field where it rests and a click sends
// a ring out; the dots it lifts take the logo's yellow.
//
// The waves are computed 24 times a second into a buffer. The pointer's lift
// is drawn on the mouse event itself, right where the pointer is, so it never
// trails. It stops whenever the window isn't key or can't be seen, and draws
// one still frame under Reduce Motion.
struct Dither: NSViewRepresentable {
    func makeNSView(context: Context) -> DitherView { DitherView() }
    func updateNSView(_ view: DitherView, context: Context) {}
}

final class DitherView: NSView {
    // The numbers are dither.js's, so the two read alike.
    private static let cell: CGFloat = 4
    private static let waveFPS = 24.0
    private static let reach = 26.0
    private static let ringLife = 2.4
    private static let ringSpeed = 70.0
    private static let bayer: [Float] = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
        3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21].map { (Float($0) + 0.5) / 64 }

    private var w = 0, h = 0
    private var wave: [Float] = []
    private var pixels: [UInt32] = []
    private var ink: UInt32 = 0, hot: UInt32 = 0
    // The pointer in cells, off the grid when it's outside the window.
    private var px = -1e4, py = -1e4
    private var rings: [(x: Double, y: Double, at: Double)] = []
    private var lastWave = 0.0
    private var link: CADisplayLink?
    private var mouseDown: Any?
    private var observers: [NSObjectProtocol] = []

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.magnificationFilter = .nearest
        layer?.contentsGravity = .resize
        readInk()
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    // The backdrop never takes a click: everything over it does.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private var still: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    private var now: Double { CACurrentMediaTime() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach { NotificationCenter.default.removeObserver($0); NSWorkspace.shared.notificationCenter.removeObserver($0) }
        observers = []
        if let mouseDown { NSEvent.removeMonitor(mouseDown) }
        mouseDown = nil
        link?.invalidate()
        link = nil
        guard let window else { return }
        link = displayLink(target: self, selector: #selector(frame(_:)))
        link?.add(to: .main, forMode: .common)
        let center = NotificationCenter.default
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.didChangeOcclusionStateNotification] {
            observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wake() }
            })
        }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wake() }
            })
        mouseDown = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            if let self, event.window === self.window, !self.still {
                let p = self.convert(event.locationInWindow, from: nil)
                self.rings.append((Double(p.x / Self.cell), Double((self.bounds.height - p.y) / Self.cell), self.now))
            }
            return event
        }
        wake()
    }

    // Running only while someone can see it move: key, on screen, motion allowed.
    private func wake() {
        let visible = window?.occlusionState.contains(.visible) == true
        let running = visible && window?.isKeyWindow == true && !still
        link?.isPaused = !running
        if !running { px = -1e4; py = -1e4; rings = [] }
        paint(now)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self))
    }

    override func mouseMoved(with event: NSEvent) {
        guard link?.isPaused == false else { return }
        let p = convert(event.locationInWindow, from: nil)
        px = Double(p.x / Self.cell)
        py = Double((bounds.height - p.y) / Self.cell)
        paint(now)
    }

    override func mouseExited(with event: NSEvent) {
        px = -1e4; py = -1e4
        paint(now)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        readInk()
        paint(now)
    }

    override func setFrameSize(_ size: NSSize) {
        super.setFrameSize(size)
        let nw = max(1, Int((size.width / Self.cell).rounded(.up))), nh = max(1, Int((size.height / Self.cell).rounded(.up)))
        guard nw != w || nh != h else { return }
        w = nw; h = nh
        wave = Array(repeating: 0, count: w * h)
        pixels = Array(repeating: 0, count: w * h)
        waves(now)
        paint(now)
    }

    @objc private func frame(_ link: CADisplayLink) {
        let t = now
        let due = t - lastWave >= 1 / Self.waveFPS
        if due { lastWave = t; waves(t) }
        if due || !rings.isEmpty { paint(t) }
    }

    // --dither-ink and --dither-hot from web/app.css, as premultiplied RGBA.
    private func readInk() {
        let dark = effectiveAppearance.isDark
        ink = Self.rgba(dark ? (244, 244, 245, 20) : (17, 17, 19, 24))
        hot = Self.rgba(dark ? (255, 176, 0, 90) : (255, 176, 0, 120))
    }

    private static func rgba(_ c: (Int, Int, Int, Int)) -> UInt32 {
        let a = c.3
        let p = { (v: Int) in UInt32(v * a / 255) }
        return p(c.0) | p(c.1) << 8 | p(c.2) << 16 | UInt32(a) << 24
    }

    // Three slow waves at odd angles: interference without a visible tile.
    private func waves(_ t: Double) {
        let s = Float(t)
        let fw = Float(w), fh = Float(h)
        var i = 0
        for y in 0..<h {
            let fy = Float(y)
            for x in 0..<w {
                let fx = Float(x)
                let v = 0.5 * sinf(fx * 0.045 + s * 0.31) * cosf(fy * 0.052 - s * 0.23)
                    + 0.32 * sinf((fx + fy) * 0.023 + s * 0.17)
                    + 0.18 * sinf(hypotf(fx - fw * 0.7, fy - fh * 0.2) * 0.06 - s * 0.4)
                wave[i] = v * 0.26 + 0.22
                i += 1
            }
        }
    }

    private func put(_ i: Int, _ x: Int, _ y: Int, _ lift: Float) {
        pixels[i] = wave[i] + lift > Self.bayer[((y & 7) << 3) + (x & 7)] ? (lift > 0.09 ? hot : ink) : 0
    }

    private func paint(_ t: Double) {
        guard w > 0, h > 0, !wave.isEmpty else { return }
        rings.removeAll { t - $0.at >= Self.ringLife }
        let ringing = !rings.isEmpty
        var i = 0
        for y in 0..<h {
            for x in 0..<w {
                put(i, x, y, ringing ? ringLift(x, y, t) : 0)
                i += 1
            }
        }
        // The square the pointer's lift reaches; past three spreads it's nothing.
        let r = Self.reach * 3
        let x0 = max(0, Int((px - r).rounded(.down))), x1 = min(w - 1, Int((px + r).rounded(.up)))
        let y0 = max(0, Int((py - r).rounded(.down))), y1 = min(h - 1, Int((py + r).rounded(.up)))
        if x0 <= x1 && y0 <= y1 {
            for y in y0...y1 {
                for x in x0...x1 {
                    let dx = Double(x) - px, dy = Double(y) - py
                    let lift = 0.34 * exp(-(dx * dx + dy * dy) / (2 * Self.reach * Self.reach)) + (ringing ? Double(ringLift(x, y, t)) : 0)
                    put(y * w + x, x, y, Float(lift))
                }
            }
        }
        draw()
    }

    private func ringLift(_ x: Int, _ y: Int, _ t: Double) -> Float {
        var lift = 0.0
        for r in rings {
            let age = t - r.at
            let dist = hypot(Double(x) - r.x, Double(y) - r.y) - age * Self.ringSpeed
            if dist > -6 && dist < 6 { lift += 0.32 * (1 - age / Self.ringLife) * cos(dist * 0.5) }
        }
        return Float(lift)
    }

    private func draw() {
        let image = pixels.withUnsafeBytes { buf -> CGImage? in
            guard let provider = CGDataProvider(data: Data(buf) as CFData) else { return nil }
            return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
                           space: CGColorSpace(name: CGColorSpace.sRGB)!,
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                           provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer?.contents = image
        // The image covers whole cells, so it runs a little past the right
        // and bottom edges rather than stretching cells to fit.
        layer?.contentsRect = CGRect(x: 0, y: 0, width: bounds.width / (CGFloat(w) * Self.cell), height: bounds.height / (CGFloat(h) * Self.cell))
        CATransaction.commit()
    }
}
