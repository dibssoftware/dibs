import Foundation

// `dibs pair` (src/web.mjs) prints the code on its first line, like K7QM-4XNA.
// It works once, for ten minutes from when dibs made it.
struct PairCode: Sendable, Equatable {
    static let life: TimeInterval = 10 * 60

    var code: String
    var issued: Date

    var expires: Date { issued.addingTimeInterval(Self.life) }

    init?(output: String, issued: Date = .now) {
        guard let first = output.split(whereSeparator: \.isNewline).first.map({ $0.trimmingCharacters(in: .whitespaces) }),
              first.range(of: #"^[0-9A-Z]{4}-[0-9A-Z]{4,}$"#, options: .regularExpression) != nil else { return nil }
        code = first
        self.issued = issued
    }
}

// One browser or MCP client signed in, from a line of `dibs pair --list`:
// "1a2b3c4d  MCP: Claude Code  signed in 11/1/2026, 8:05:00 PM".
struct PairedClient: Sendable, Hashable, Identifiable {
    var id: String
    var what: String
    var since: String

    var isPage: Bool { what == "web page" }
    // A phone or browser paired through the relay (dibs pair --remote).
    var isRemote: Bool { what.hasPrefix("remote: ") }
    var name: String { isPage ? "Browser" : what.hasPrefix("MCP: ") ? String(what.dropFirst(5)) : isRemote ? String(what.dropFirst(8)) : what }

    static func list(_ output: String) -> [PairedClient] {
        output.split(whereSeparator: \.isNewline).compactMap { line in
            let parts = line.components(separatedBy: "  ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard parts.count >= 3, parts[0].range(of: #"^[0-9a-f]{8}$"#, options: .regularExpression) != nil else { return nil }
            // The page and MCP clients are "signed in"; devices through the relay are "paired", with when they last connected.
            for word in ["signed in ", "paired "] where parts[2].hasPrefix(word) {
                return PairedClient(id: parts[0], what: parts[1], since: String(parts[2].dropFirst(word.count)))
            }
            return nil
        }
    }
}

// A line of `dibs service status web`: "web       running (pid 812)   the page ...".
struct ServiceState: Sendable, Equatable {
    var installed: Bool
    var running: Bool
    var detail: String

    init(output: String) {
        let line = output.split(whereSeparator: \.isNewline).first { $0.hasPrefix("web ") }.map(String.init) ?? ""
        let rest = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
        // The state is padded to 28 characters; a longer one ("installed, not
        // running (last exit 1)") runs into the description with one space.
        let state = rest.components(separatedBy: "  ").first ?? ""
        detail = (state.range(of: " the page").map { String(state[..<$0.lowerBound]) } ?? state).trimmingCharacters(in: .whitespaces)
        installed = !detail.isEmpty && !detail.hasPrefix("not installed")
        running = detail.hasPrefix("running") || detail == "active"
    }
}
