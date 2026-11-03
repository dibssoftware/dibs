import Foundation

// Each machine's load over the past hours, so the schedule can show the load
// at any moment. The board only says what the load is now; the app records it
// as it polls and keeps a few hours, saved so a relaunch doesn't start blank.
struct LoadLog: Codable, Sendable {
    struct Point: Codable, Sendable, Hashable {
        var at: Date
        var load: Double
    }

    var byMachine: [String: [Point]] = [:]

    // A point every 10 s is finer than the guide can draw; six hours covers its window.
    static let every: TimeInterval = 10
    static let keep: TimeInterval = 6 * 3600

    mutating func record(_ machine: String, load: Double, at: Date = .now) {
        var points = byMachine[machine] ?? []
        if let last = points.last, at.timeIntervalSince(last.at) < Self.every { return }
        points.append(Point(at: at, load: load))
        let cutoff = at.addingTimeInterval(-Self.keep)
        if let first = points.firstIndex(where: { $0.at >= cutoff }), first > 0 { points.removeFirst(first) }
        byMachine[machine] = points
    }

    // What was recorded, after the hourly averages dibs keeps for the hours before it.
    func points(_ machine: String, hourly: [History.Hour] = []) -> [Point] {
        let recorded = byMachine[machine] ?? []
        let since = recorded.first?.at ?? .distantFuture
        let older = hourly.compactMap { h in h.load.map { Point(at: Date(ms: h.hour).addingTimeInterval(1800), load: $0) } }
            .filter { $0.at < since }
        return older + recorded
    }

    static var file: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "dibs")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("load.json")
    }

    static func saved() -> LoadLog {
        (try? Data(contentsOf: file)).flatMap { try? JSONDecoder().decode(LoadLog.self, from: $0) } ?? LoadLog()
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { try? data.write(to: Self.file, options: .atomic) }
    }
}
