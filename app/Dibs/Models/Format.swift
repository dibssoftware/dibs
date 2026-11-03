import Foundation

// Durations and sizes written the way the CLI writes them (src/util.mjs), so
// the app and a terminal never disagree about what "5m42s" means.
enum Format {
    static func dur(_ seconds: TimeInterval) -> String {
        let t = max(0, Int(seconds.rounded()))
        if t < 60 { return "\(t)s" }
        if t < 3600 { return "\(t / 60)m" + String(format: "%02ds", t % 60) }
        return "\(t / 3600)h" + String(format: "%02dm", (t / 60) % 60)
    }

    static func dur(ms: Double) -> String { dur(ms / 1000) }

    static func gb(_ bytes: Double) -> String {
        let g = bytes / 1_073_741_824
        return g < 10 ? String(format: "%.1f GB", g) : String(format: "%.0f GB", g)
    }

    static func clock(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .shortened)
    }

    // The clock today; with the weekday within a week, the date further off,
    // so yesterday's 6:40 PM doesn't read as later today (src/alerts.mjs stamp).
    static func stamp(_ date: Date, now: Date = .now) -> String {
        if Calendar.current.isDate(date, inSameDayAs: now) { return clock(date) }
        let day = abs(date.timeIntervalSince(now)) < 6 * 86400
            ? date.formatted(.dateTime.weekday(.abbreviated)) : date.formatted(.dateTime.month(.abbreviated).day())
        return "\(day) \(clock(date))"
    }

    // How far one rule moved a waiter in line. dibs counts a positive shift as
    // moving up (a short job, a near deadline) and a negative one as back.
    static func rank(_ part: Waiter.Rank.Part) -> String {
        "\(part.label): \(part.shift < 0 ? "back" : "up") \(dur(ms: abs(part.shift)))"
    }

    static func hourName(_ h: Int) -> String {
        switch h % 24 {
        case 0: "midnight"
        case 12: "noon"
        case let h where h < 12: "\(h) AM"
        default: "\(h % 12) PM"
        }
    }

    // "web-app" is WA, "onboarding" is ON. Sessions named "alex-75" and
    // "alex-b8" differ only at the end, so a short last part is the monogram.
    static func monogram(_ name: String) -> String {
        let parts = name.split { "-_/ .".contains($0) }.filter { !$0.isEmpty }
        if parts.count >= 2, let last = parts.last, last.count <= 2 || (last.count <= 3 && last.contains(where: \.isNumber)) {
            return last.uppercased()
        }
        if parts.count >= 2 { return (String(parts[0].prefix(1)) + String(parts[1].prefix(1))).uppercased() }
        return String(name.prefix(2)).uppercased()
    }
}

// "14 min", "1 hr 5 min": how long, with nothing around it.
enum Span {
    static func of(_ t: TimeInterval) -> String {
        let m = Int((max(0, t) / 60).rounded())
        if m < 1 { return "under a min" }
        if m < 60 { return "\(m) min" }
        let h = m / 60, r = m % 60
        return r == 0 ? "\(h) hr" : "\(h) hr \(r) min"
    }

    // The web page's ago(): "just now", "12m ago", "3h 5m ago", "2d ago".
    static func ago(_ t: TimeInterval) -> String {
        let m = Int((max(0, t) / 60).rounded())
        if m < 1 { return "just now" }
        if m < 60 { return "\(m)m ago" }
        let h = m / 60
        return h < 24 ? "\(h)h \(m % 60 > 0 ? "\(m % 60)m " : "")ago" : "\(h / 24)d ago"
    }

    // The web page's span(): a stretch of time as a person says it, 40s, 12m, 3h 20m, 31h.
    static func short(ms: Double?) -> String {
        guard let ms else { return "-" }
        let s = Int((ms / 1000).rounded())
        if s < 60 { return "\(s)s" }
        let m = Int((Double(s) / 60).rounded())
        if m < 60 { return "\(m)m" }
        let h = m / 60
        return h < 10 ? "\(h)h\(m % 60 > 0 ? " \(m % 60)m" : "")" : "\(h)h"
    }
}

// dibs once numbered releases 0.7.0 where it now says 0.0.70. An old-style
// number is read the new way, so 0.6.3 counts as 0.0.63, not as newer.
enum DibsVersion {
    static func normalized(_ v: String) -> String {
        let p = v.split(separator: ".").compactMap { Int($0) }
        guard p.count == 3, p[0] == 0, p[1] > 0 else { return v }
        return "0.0.\(p[1] * 10 + p[2])"
    }
    static func atLeast(_ v: String, _ floor: String) -> Bool {
        normalized(v).compare(normalized(floor), options: .numeric) != .orderedAscending
    }

}
