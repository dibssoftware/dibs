import Foundation

struct CLIError: Error, Sendable, Equatable {
    enum Kind: Sendable, Equatable {
        case notInstalled
        case noNode
        // Exit 2 from a verb this dibs doesn't have: an older version.
        case unsupported
        case timedOut
        case badOutput
        case failed(Int32)
    }

    var kind: Kind
    var message: String
}

// The only way the app talks to dibs: run the binary, read stdout. Nothing
// here reads ~/.dibs. Every call runs on a background queue, so a slow or hung
// CLI never touches the main thread.
struct DibsCLI: Sendable {
    let executable: URL?
    let path: String

    // A Mac app starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which has
    // neither dibs nor the node it runs on. The login shell's PATH has both.
    static func locate() async -> DibsCLI {
        let home = NSHomeDirectory()
        let shellPath = (try? await Self.capture(URL(fileURLWithPath: "/bin/zsh"), ["-l", "-c", "printf %s \"$PATH\""],
                                                  env: ProcessInfo.processInfo.environment, timeout: 3))
            .map { String(decoding: $0.out, as: UTF8.self) } ?? ""
        let appPath = ProcessInfo.processInfo.environment["PATH"] ?? ""
        let candidates: [String] = "\(shellPath):\(appPath)".components(separatedBy: ":")
            + ["\(home)/bin", "\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        var dirs: [String] = []
        for dir in candidates where !dir.isEmpty && !dirs.contains(dir) {
            dirs.append(dir)
        }
        let fm = FileManager.default
        // DIBS_BIN points the app at another dibs: a checkout, or a stand-in for screenshots.
        let pinned = ProcessInfo.processInfo.environment["DIBS_BIN"].map { [$0] } ?? []
        let found = (pinned + dirs.map { "\($0)/dibs" }).first { fm.isExecutableFile(atPath: $0) }
        return DibsCLI(executable: found.map(URL.init(fileURLWithPath:)), path: dirs.joined(separator: ":"))
    }

    func run(_ args: [String], owner: Bool = false, timeout: TimeInterval = 15) async throws -> Data {
        guard let executable else {
            throw CLIError(kind: .notInstalled, message: "No dibs on PATH, in ~/bin or in ~/.local/bin.")
        }
        let env = environment(owner: owner)
        // A read goes to the reader that stays up (dibs _reads), not a new node each poll:
        // under load, starting node was most of every read. Actions always run the CLI.
        if !owner, let r = await Reader.for(args).ask(executable, env: env, args: args, timeout: timeout) {
            if r.timedOut { throw CLIError(kind: .timedOut, message: "dibs \(args.joined(separator: " ")) didn't answer in \(Int(timeout))s.") }
            return try Self.result(code: r.code, out: r.out, stderr: r.err)
        }
        let result: (code: Int32, out: Data, err: Data, timedOut: Bool)
        do {
            result = try await Self.capture(executable, args, env: env, timeout: timeout)
        } catch {
            throw CLIError(kind: .failed(127), message: "Couldn't start \(executable.path): \(error.localizedDescription)")
        }
        let stderr = String(decoding: result.err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if result.timedOut {
            throw CLIError(kind: .timedOut, message: "dibs \(args.joined(separator: " ")) didn't answer in \(Int(timeout))s.")
        }
        return try Self.result(code: result.code, out: result.out, stderr: stderr)
    }

    private func environment(owner: Bool) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        // If the app was opened from a shell an agent's tool once ran in, dibs
        // must not think an agent is calling: owner actions refuse to run for
        // agents. These are the variables dibs reads as one (AGENT_ENV in
        // src/owner.mjs). An app an agent really started is still refused,
        // since dibs also looks at who started the app.
        for key in env.keys where key.hasPrefix("CLAUDE_CODE") || key.hasPrefix("CODEX_") || Self.agentEnv.contains(key) { env[key] = nil }
        env["PATH"] = path
        env["NO_COLOR"] = "1"
        if owner { env["DIBS_OWNER"] = "1" }
        return env
    }

    // What an exit code means to the app, the same from the reader and from a run.
    static func result(code: Int32, out: Data, stderr: String) throws -> Data {
        switch code {
        case 0:
            return out
        case 127 where stderr.contains("node"):
            throw CLIError(kind: .noNode, message: "dibs runs on Node 20 or newer, and there's no node on PATH.\n\(stderr)")
        // A dibs without the verb reads it as a resource and finds no command,
        // or (0.0.167 and later) says it doesn't know it.
        case 2 where stderr.contains("nothing to run") || stderr.contains("unknown command"):
            throw CLIError(kind: .unsupported, message: stderr)
        default:
            let message = stderr.hasPrefix("dibs: ") ? String(stderr.dropFirst(6)) : stderr
            throw CLIError(kind: .failed(code), message: message.isEmpty ? "dibs exited \(code)." : message)
        }
    }

    static let agentEnv: Set<String> = ["CLAUDECODE", "AI_AGENT", "CURSOR_AGENT", "GEMINI_CLI", "OPENCODE"]

    func json<T: Decodable & Sendable>(_ args: [String], as type: T.Type, timeout: TimeInterval = 15) async throws -> T {
        let data = try await run(args, timeout: timeout)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw CLIError(kind: .badOutput, message: "dibs \(args.joined(separator: " ")) printed something this app can't read: \(error)")
        }
    }

    func text(_ args: [String], owner: Bool = false) async throws -> String {
        String(decoding: try await run(args, owner: owner), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func capture(_ exe: URL, _ args: [String], env: [String: String], timeout: TimeInterval) async throws
        -> (code: Int32, out: Data, err: Data, timedOut: Bool) {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(with: Result { try execute(exe, args, env: env, timeout: timeout) })
            }
        }
    }

    // Blocking. stdout and stderr drain at the same time, or a chatty stderr
    // could fill its pipe and stall the CLI.
    private static func execute(_ exe: URL, _ args: [String], env: [String: String], timeout: TimeInterval) throws
        -> (code: Int32, out: Data, err: Data, timedOut: Bool) {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        try p.run()

        let errData = Box<Data>(Data())
        let drained = DispatchGroup()
        let errHandle = err.fileHandleForReading
        DispatchQueue.global().async(group: drained) { errData.value = errHandle.readDataToEndOfFile() }

        let timedOut = Box(false)
        let proc = Box(p)
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            if proc.value.isRunning {
                timedOut.value = true
                proc.value.terminate()
            }
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        drained.wait()
        return (p.terminationStatus, outData, errData.value, timedOut.value)
    }
}

// Passes a value between the queues of one CLI call. Each is written by one
// thread and read only after a wait on it (the group, or the exit).
private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
