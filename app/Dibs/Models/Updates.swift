import Foundation

// The app checks dibs.cc once a day for a newer build. The feed is one small
// file that app/release.sh writes next to each DMG:
//
//   {"version": "0.0.83", "url": "https://dibs.cc/mac/dibs-0.0.83.dmg",
//    "notes": "What changed, in a sentence or two."}
//
// The check sends nothing but the request itself, and never installs anything:
// a newer version shows in Settings with a link to download it.
struct UpdateFeed: Decodable, Sendable, Equatable {
    var version: String
    var url: URL
    var notes: String?

    // DIBS_UPDATE_FEED points a test build at another feed, a file:// one included.
    static let feed = ProcessInfo.processInfo.environment["DIBS_UPDATE_FEED"].flatMap(URL.init(string:))
        ?? URL(string: "https://dibs.cc/mac/latest.json")!

    // This build's version, from the bundle.
    static var running: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    // Compares dotted numbers, so 0.0.100 is newer than 0.0.99. A missing part
    // counts as 0 and anything after a dash is ignored.
    static func isNewer(_ a: String, than b: String) -> Bool {
        func parts(_ s: String) -> [Int] {
            let core = s.split(separator: "-").first.map(String.init) ?? s
            return core.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".").map { Int($0) ?? 0 }
        }
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    static func fetch(from url: URL = feed) async throws -> UpdateFeed {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.setValue("dibs-mac/\(running)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(UpdateFeed.self, from: data)
    }
}
