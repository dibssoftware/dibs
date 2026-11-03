import Foundation

// `dibs _reads` processes that stay up for the app's lifetime (src/reads.mjs), one
// for the polls and one for the long reports: each poll's
// read is a line to it and a line back, in milliseconds, where a new
// `dibs ... --json` spent most of its time starting node, seconds under load.
// What comes back is exactly what that command would have printed, with its
// exit code. A dibs without the reader, or a read it doesn't answer, returns
// nil, and the caller runs the CLI as it always has.
final class Reader: @unchecked Sendable {
    // Two readers, so a long report never holds up a poll: each answers one read at a
    // time, and a 30-day stats or history read can take a second or more.
    static let polls = Reader()
    static let reports = Reader()
    static func `for`(_ args: [String]) -> Reader { ["stats", "history"].contains(args.first ?? "") ? reports : polls }

    struct Reply: Sendable {
        var code: Int32
        var out: Data
        var err: String
        var timedOut = false
    }

    private struct Wire: Decodable {
        var id: Int?
        var code: Int32
        var out: String
        var err: String
    }

    private let lock = NSLock()
    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var waiting: [Int: CheckedContinuation<Reply?, Never>] = [:]
    private var next = 0
    private var key = ""
    // An older dibs has no reader: once it says so, the app stops asking.
    private var unsupported = false
    // A reader that keeps dying is left alone for a while rather than restarted every poll.
    private var restarts: [Date] = []
    static let restartLimit = 5

    func ask(_ exe: URL, env: [String: String], args: [String], timeout: TimeInterval) async -> Reply? {
        let id: Int? = lock.withLock {
            guard !unsupported, start(exe, env: env) else { return nil }
            next += 1
            return next
        }
        guard let id else { return nil }
        let reply: Reply? = await withCheckedContinuation { cont in
            let line: Data? = lock.withLock {
                guard let input else { return nil }
                waiting[id] = cont
                let req = try? JSONSerialization.data(withJSONObject: ["id": id, "args": args])
                return req.map { $0 + Data("\n".utf8) }
            }
            guard let line, let handle = lock.withLock({ input }) else { return cont.resume(returning: nil) }
            do { try handle.write(contentsOf: line) } catch { finish(id, nil) }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self else { return }
                // Stuck: it answers nothing else either, so it goes, and the next read starts a new one.
                if self.finish(id, Reply(code: 0, out: Data(), err: "", timedOut: true)) { self.stop() }
            }
        }
        // A read the reader turns away runs the CLI instead.
        if let r = reply, r.code == 2, r.err.hasPrefix("the app's reader answers only") { return nil }
        return reply
    }

    // Under the lock. True when a reader is up for this dibs.
    private func start(_ exe: URL, env: [String: String]) -> Bool {
        let want = "\(exe.path)\u{0}\(env["PATH"] ?? "")\u{0}\(env["DIBS_HOME"] ?? "")"
        if let p = process, p.isRunning, key == want { return true }
        if let p = process, p.isRunning { p.terminate() }
        let now = Date.now
        restarts = restarts.filter { now.timeIntervalSince($0) < 60 }
        guard restarts.count < Self.restartLimit else { return false }
        restarts.append(now)
        let p = Process()
        p.executableURL = exe
        p.arguments = ["_reads"]
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            if chunk.isEmpty { h.readabilityHandler = nil } else { self?.received(chunk) }
        }
        let started = Date.now
        p.terminationHandler = { [weak self] proc in
            guard let self else { return }
            let pending: [CheckedContinuation<Reply?, Never>] = self.lock.withLock {
                // Gone at once with "unknown": a dibs from before the reader.
                if proc.terminationStatus == 2 && Date.now.timeIntervalSince(started) < 5 && self.next <= 1 { self.unsupported = true }
                if self.process === proc { self.process = nil; self.input = nil; self.buffer = Data() }
                defer { self.waiting = [:] }
                return Array(self.waiting.values)
            }
            // Whatever was asked runs the CLI instead.
            for c in pending { c.resume(returning: nil) }
        }
        do { try p.run() } catch { return false }
        process = p
        input = inPipe.fileHandleForWriting
        key = want
        buffer = Data()
        return true
    }

    private func received(_ chunk: Data) {
        var done: [(Int, Reply)] = []
        lock.withLock {
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer[buffer.startIndex..<nl]
                buffer = Data(buffer[buffer.index(after: nl)...])
                guard let w = try? JSONDecoder().decode(Wire.self, from: line), let id = w.id else { continue }
                done.append((id, Reply(code: w.code, out: Data(w.out.utf8), err: w.err)))
            }
        }
        for (id, r) in done { finish(id, r) }
    }

    @discardableResult
    private func finish(_ id: Int, _ reply: Reply?) -> Bool {
        guard let c = lock.withLock({ waiting.removeValue(forKey: id) }) else { return false }
        c.resume(returning: reply)
        return true
    }

    private func stop() {
        let p = lock.withLock { process }
        p?.terminate()
    }
}
