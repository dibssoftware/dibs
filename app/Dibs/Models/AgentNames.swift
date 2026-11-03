import Foundation

// Claude Code names a session by user and a short id ("alex-b8"), which
// says nothing about the work. Each session's transcript carries a title
// Claude wrote for it ("Atlas build and deploy status"), or one the person
// gave it; this finds that title by the session's name.
//
// ~/.claude/sessions/<pid>.json has the name, the session id and its folder;
// the transcript is ~/.claude/projects/<folder, see projectFolder>/<id>.jsonl.
// Transcripts run to hundreds of megabytes; see scan for how little is read.
struct AgentNames: Sendable {
    struct Agent: Sendable, Equatable {
        var tool: String
        var title: String?
    }

    var byName: [String: Agent] = [:]

    // The person's own title wins over Claude's.
    private static let keys = [#""customTitle":""#, #""aiTitle":""#]

    // What was read of each transcript: how far, and the title found so far.
    struct Read: Sendable { var size: UInt64; var title: String? }

    // Transcripts only grow at the end, so each is read whole once, and after
    // that only the part written since (with a little overlap, so a title
    // split across the boundary still matches).
    static func scan(previous: [String: Read], home: URL = FileManager.default.homeDirectoryForCurrentUser)
        -> (names: AgentNames, seen: [String: Read]) {
        let dir = home.appendingPathComponent(".claude/sessions")
        var names = AgentNames()
        var seen: [String: Read] = [:]
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        for f in files where f.hasSuffix(".json") {
            guard let data = try? Data(contentsOf: dir.appendingPathComponent(f)),
                  let s = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let name = s["name"] as? String, let id = s["sessionId"] as? String, let cwd = s["cwd"] as? String else { continue }
            let path = home.appendingPathComponent(".claude/projects")
                .appendingPathComponent(projectFolder(cwd))
                .appendingPathComponent("\(id).jsonl").path
            let size = ((try? FileManager.default.attributesOfItem(atPath: path)[.size]) as? NSNumber)?.uint64Value ?? 0
            var read = previous[path] ?? Read(size: 0, title: nil)
            if size != read.size {
                let from = read.size > overlap ? read.size - overlap : 0
                if let found = title(in: path, from: size < read.size ? 0 : from) { read.title = found }
                read.size = size
            }
            seen[path] = read
            names.byName[name] = Agent(tool: "Claude", title: read.title)
        }
        return (names, seen)
    }

    private static let overlap: UInt64 = 64 * 1024

    // Claude Code names a project's folder after its path with every
    // character but letters and digits made "-": /Users/me/.claude/x is
    // -Users-me--claude-x.
    static func projectFolder(_ cwd: String) -> String {
        String(cwd.unicodeScalars.map { $0.isASCII && CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" })
    }

    // The last title written into a transcript.
    static func title(in path: String, from offset: UInt64 = 0) -> String? {
        let data: Data
        if offset == 0 {
            guard let whole = try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped) else { return nil }
            data = whole
        } else {
            guard let h = FileHandle(forReadingAtPath: path) else { return nil }
            defer { try? h.close() }
            try? h.seek(toOffset: offset)
            guard let tail = try? h.readToEnd() else { return nil }
            data = tail
        }
        var best: (Int, String)?
        for key in keys {
            guard let k = key.data(using: .utf8), let r = data.range(of: k, options: .backwards) else { continue }
            // Read the JSON string that follows, escapes and all.
            var end = r.upperBound
            var escaped = false
            while end < data.count {
                let b = data[end]
                if escaped { escaped = false } else if b == UInt8(ascii: "\\") { escaped = true } else if b == UInt8(ascii: "\"") { break }
                end += 1
            }
            guard end < data.count,
                  let raw = String(data: data[(r.upperBound - 1)...end], encoding: .utf8),
                  let text = try? JSONDecoder().decode(String.self, from: Data(raw.utf8)),
                  !text.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            if key == keys[0] { return text }
            if best == nil || r.lowerBound > best!.0 { best = (r.lowerBound, text) }
        }
        return best?.1
    }
}
