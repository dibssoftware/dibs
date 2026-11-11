import AppKit
import Observation

// Everything the window and the menu bar show, kept fresh by polling the CLI.
@MainActor
@Observable
final class Store {
    // The same screens in the same order as the web page's rail.
    enum Section: String, Hashable, CaseIterable {
        case now, questions, messages, progress, queues, schedule, machines, later, stats, history, settings

        // The key that opens it, with Cmd here and alone on the web page: 1 to 9, then 0, and comma for Settings.
        var key: Character? {
            guard self != .settings, let i = Self.allCases.firstIndex(of: self), i < 10 else { return self == .settings ? "," : nil }
            return Character(String((i + 1) % 10))
        }

        var title: String {
            switch self {
            case .now: "Now"
            case .questions: "Questions"
            case .messages: "Messages"
            case .progress: "Progress"
            case .queues: "Queues"
            case .schedule: "Schedule"
            case .machines: "Machines"
            case .later: "Later"
            case .stats: "Stats"
            case .history: "History"
            case .settings: "Settings"
            }
        }
    }

    // Two seconds while someone is looking; a slower pace still catches new
    // questions and stuck jobs for notifications when nobody is.
    static let fastPoll: Duration = .seconds(2)
    static let slowPoll: Duration = .seconds(15)
    // The owner actions arrived with this version (app-contract.md).
    static let ownerVersion = "0.0.70"
    // dibs pair, dibs web as a service and dibs progress arrived together.
    static let webVersion = "0.0.168"

    var section: Section? = UserDefaults.standard.string(forKey: "section").flatMap(Section.init(rawValue:)) ?? .now {
        didSet { UserDefaults.standard.set(section?.rawValue, forKey: "section") }
    }
    var openRequest: Section?
    // A queue another screen asked Queues to show, by resource.
    var focusRes: String?
    // A job another screen asked Queues to open in its panel, by row id.
    var focusRow: String?
    // A job open in its sheet over the screen it was picked on (the web page's job sheet), by row id.
    var sheetRow: String?
    // An agent picked in the sidebar: Now, Progress, Stats and Messages narrow to it, as on the web page.
    var chosen: String?

    private(set) var cli: DibsCLI?
    private(set) var version: String?
    private(set) var board: Board?
    private(set) var boardError: CLIError?
    private(set) var updated: Date?
    private(set) var questions: QuestionList?
    private(set) var questionsSupported = true
    // Why the last read of the questions or the threads failed, said on their screens as the web page does.
    private(set) var questionsError: CLIError?
    private(set) var threadsError: CLIError?
    // dibs threads (0.0.80). Without it, conversations are built from the questions.
    private(set) var threadList: ThreadList?
    private(set) var threadsSupported = true
    // Who the chat's box writes to, by the name `dibs tell` takes: an agent
    // the person tapped, or nil for the desk, which answers anything else.
    var replyTo: String?
    // Threads read here, by the name `dibs tell` takes, with the thread's
    // `last` when they were read. Unread stays hidden until the thread moves
    // past it, so a note that lands after the read still shows.
    private(set) var seen: [String: Double] = [:]
    // This Week's history, by range ("1d", "7d"), so switching ranges never
    // shows the other range's numbers, and each range's error is its own.
    private(set) var histories: [String: History] = [:]
    private(set) var historyErrors: [String: CLIError] = [:]
    // What each agent is working on, from its Claude Code session's title.
    private(set) var agents = AgentNames()
    private var titleCache: [String: AgentNames.Read] = [:]
    // Every machine's load as the app has seen it, for the schedule.
    private(set) var loadLog = LoadLog.saved()
    private var loadSaved = Date.now
    private var namesScanned: Date?
    // The past day, for Home's chart, kept apart from This Week's range.
    private(set) var today: History?
    private(set) var historySupported = true
    private(set) var guardStatus: GuardStatus?
    private(set) var paceInfo: PaceInfo?
    private(set) var hoursSupported = true
    // A newer app on dibs.cc, if the daily check found one.
    private(set) var update: UpdateFeed?
    private(set) var updateChecking = false
    // Said in Settings after a check by hand: up to date, or couldn't reach dibs.cc.
    private(set) var updateNote: String?
    private var updateChecked: Date?
    var checkUpdates = UserDefaults.standard.object(forKey: "checkUpdates") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(checkUpdates, forKey: "checkUpdates")
            if checkUpdates { updateChecked = nil; poke() } else { update = nil }
        }
    }

    // dibs progress --json, oldest first, as the CLI prints it.
    private(set) var progress: [ProgressPost]?
    private(set) var progressError: CLIError?
    private var progressRead: Date?
    // The Machines screen: dibs service status and dibs sims --json, read while it's open.
    private(set) var services: [ServiceRow]?
    private(set) var pool: SimPool?
    // A phone or browser paired through the relay: the link dibs pair --remote printed.
    private(set) var remotePair: (link: String, act: Bool, at: Date)?
    // The command palette (Cmd-K), the web page's too.
    var paletteOpen = false
    // dibs later list --json: runs scheduled for later, and the ones that ended.
    private(set) var later: [LaterRun]?
    private(set) var laterError: CLIError?
    // dibs stats --json, by range and agent ("7d|" for everyone), so switching
    // never shows another range's numbers.
    private(set) var stats: [String: Stats] = [:]
    private(set) var statsErrors: [String: CLIError] = [:]
    // The pairing sheet: the code dibs pair printed, what's signed in, and
    // whether the page's service runs.
    var pairing = false
    private(set) var pairCode: PairCode?
    private(set) var paired: [PairedClient]?
    private(set) var webService: ServiceState?
    // dibs connect --accounts --json: the dibs accounts this Mac is on and the browsers waiting
    // for its approval. nil until read, or on a dibs older than accounts (0.0.176).
    private(set) var accountList: AccountList?
    private(set) var accountsSupported = true
    // The browser being approved (the sheet that asks for its code), and what the approval said
    // to type back into it.
    var approving: AccountList.Waiting?
    private(set) var approved: Approval.Approved?
    // dibs connect --account: the one-time link a browser signed in to the account opens.
    private(set) var accountJoin: (link: String, at: Date)?
    // Set when a notification about a waiting browser is clicked: Settings scrolls to the group.
    var focusAccounts = false

    // Answered or dismissed here but not yet gone from the CLI's list.
    private(set) var settled: Set<String> = []
    private(set) var running: Set<String> = []
    var actionError: String?
    private(set) var lastAction: String?
    // A pause dibs refused because freezing that resource midway is risky,
    // with its reason, waiting for the person to say "pause anyway".
    var refusedPause: (row: Row, reason: String)?

    // macOS has dibs's notifications turned off, so questions can't reach the person.
    private(set) var notificationsOff = false

    var looking = false { didSet { if looking && !oldValue { poke() } } }
    var menuOpen = false { didSet { if menuOpen && !oldValue { poke() } } }

    var muted: Set<Alert.Kind> = Set((UserDefaults.standard.stringArray(forKey: "muted") ?? []).compactMap(Alert.Kind.init(rawValue:))) {
        didSet { UserDefaults.standard.set(muted.map(\.rawValue), forKey: "muted") }
    }

    private let notifier = Notifier()
    private var refreshing = false
    private var loopStarted = false
    private var wake: CheckedContinuation<Void, Never>?
    private var generation = 0
    private var versionChecked: Date?

    private func recordLoad() {
        guard let board else { return }
        if let load = board.machine.load { loadLog.record(hostName, load: load) }
        for peer in board.peers(excluding: hostName) where peer.lost != true {
            if let load = peer.load { loadLog.record(peer.name, load: load) }
        }
        // Saved once a minute: losing the last minute on a crash costs nothing.
        if Date.now.timeIntervalSince(loadSaved) > 60 {
            loadSaved = .now
            loadLog.save()
        }
    }

    // MARK: derived

    // An agent by what it's working on when its session has a title, else its name.
    func displayName(_ who: String) -> String { agents.byName[who]?.title ?? who }

    // A thread's agent the same way, with a named subagent's name after it.
    func threadName(_ t: AgentThread) -> String {
        guard let label = t.label, !label.isEmpty, label != t.agent, !Row.genericAgents.contains(label) else { return displayName(t.agent) }
        return "\(displayName(t.agent)) \u{00B7} \(label)"
    }

    // A chat line's agent: the desk is dibs, the rest by their session titles.
    func chatName(_ item: ChatItem) -> String {
        if item.desk { return "dibs" }
        guard let label = item.label, !label.isEmpty, label != item.agent, !Row.genericAgents.contains(label) else { return displayName(item.agent) }
        return "\(displayName(item.agent)) \u{00B7} \(label)"
    }

    // The row's agent, and which of its subagents when it's one of them.
    func rowName(_ row: Row) -> String {
        row.subagent.map { "\(displayName(row.who)) \u{00B7} \($0)" } ?? displayName(row.who)
    }

    // Whether the board on screen is still what dibs says (Freshness).
    func freshness(now: Date = .now) -> (text: String, stale: Bool)? {
        Freshness.line(updated: updated, failing: boardError != nil, now: now)
    }

    // This machine's name in the group, so its own section isn't shown twice.
    // dibs says it (me.name); one older than 0.0.70 doesn't, so the app falls
    // back to the name dibs gives a machine by default (shortHost in src/remote.mjs).
    var hostName: String { board?.me?.name ?? Self.shortHost }
    private static let shortHost: String = {
        var buf = [CChar](repeating: 0, count: 256)
        gethostname(&buf, buf.count)
        let name = String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return name.replacingOccurrences(of: #"\.(local|lan|home)$"#, with: "", options: [.regularExpression, .caseInsensitive])
    }()

    var rows: [Row] { board?.rows(peerName: hostName) ?? [] }
    var counters: [Counter] { board?.counters(rows: rows) ?? [] }
    // A question answered here leaves at once, not on the next poll.
    // What needs the person on this Mac (a stuck job, a full disk). Questions
    // and notes are the chat's.
    var needs: [Need] {
        Needs.items(counters: counters, questions: [], threads: [], now: .now, name: displayName)
            .map { need in
                // A subagent's job reads as "session / subagent" in its card.
                guard let row = need.row, row.subagent != nil, need.title.hasPrefix(displayName(row.who)) else { return need }
                var n = need
                n.title = rowName(row) + need.title.dropFirst(displayName(row.who).count)
                return n
            }
            .filter { !gotIt.contains($0.id) }
            // An alert about the same job says more, with its fix (dibsAlerts).
            .filter { need in need.row?.leaseID.map { !alertedJobs.contains($0) } ?? true }
    }
    // dibs's alerts (src/alerts.mjs): open ones worst first, then the ones resolved lately.
    var dibsAlerts: [DibsAlert] { board?.alerts ?? [] }
    var openAlerts: [DibsAlert] { dibsAlerts.filter(\.open) }
    private var alertedJobs: Set<Int> { Set(openAlerts.compactMap(\.job)) }
    // Waits the person said they'd seen ("Got It"); each one stays cleared until that wait ends.
    var gotIt: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "gotIt") ?? []) {
        didSet { UserDefaults.standard.set(Array(gotIt), forKey: "gotIt") }
    }

    // Every conversation, newest first: dibs's threads, or ones built from the questions.
    var threads: [AgentThread] {
        var list = threadList?.threads ?? ThreadList(questions: questions?.questions ?? []).threads
        for i in list.indices {
            list[i] = list[i].hidingRead(at: seen[list[i].to])
            // An answer given here shows before the next poll brings it back.
            for j in list[i].messages.indices where list[i].messages[j].kind == "question" {
                if let q = list[i].messages[j].questionId, settled.contains(q) { list[i].messages[j].state = "answered" }
            }
        }
        return list
    }
    // Everything agents say to the person, as one conversation (Chat).
    // A question answered here leaves the waiting ones at once.
    var chat: [ChatItem] {
        let qs = (questions?.questions ?? []).map { q in
            var q = q
            if settled.contains(q.id) { q.state = .answered }
            return q
        }
        return Chat.items(threads: threads, questions: qs, desk: threadList?.desk)
    }
    // The one-way questions waiting on the person: the badge, the menu bar.
    var asks: [ChatItem] { Chat.waiting(chat) }
    // A failed job is on the list, but not something that "needs you" right now.
    var status: Status { Status.of(counters: counters, needs: needs.count + asks.count + openAlerts.filter { $0.level != "note" }.count) }
    var waitingCount: Int { board?.waiting.count ?? 0 }
    var openQuestions: [Question] { (questions?.open ?? []).filter { !settled.contains($0.id) } }

    // The sidebar's agents, as the web page lists them: everyone with a job,
    // a later run or a post in the last day, the one that posted last first.
    struct AgentRow: Identifiable, Hashable {
        var who: String
        var state: StateDot.Kind
        var jobs: Int
        var lastPost: Date?
        // Waiting on dibs listen: a message to it wakes it now.
        var listening = false
        var id: String { who }
    }

    // A post this recent means the agent is at it (FRESH on the web page).
    static let fresh: TimeInterval = 15 * 60

    var agentRows: [AgentRow] {
        let now = Date.now
        let posts = (progress ?? []).filter { now.timeIntervalSince(Date(ms: $0.at)) < 24 * 3600 }
        let tasks = ProgressBoard.agents(posts)
        var names = Set(rows.map(\.who))
        names.formUnion((later ?? []).filter(\.active).map(\.who))
        names.formUnion(tasks.map(\.who))
        let ears = Set(board?.listening ?? [])
        names.formUnion(ears)
        return names.map { who in
            let jobs = rows.filter { $0.who == who }
            let agent = tasks.first { $0.who == who }
            let last = agent.map(\.last)
            let state: StateDot.Kind =
                agent?.tasks.contains { $0.state == .blocked && $0.last == last } == true ? .blocked
                : jobs.contains(where: \.held) ? .running
                : !jobs.isEmpty ? .waiting
                : last.map { now.timeIntervalSince($0) < Self.fresh } == true ? .busy
                : .idle
            return AgentRow(who: who, state: state, jobs: jobs.count, lastPost: last, listening: ears.contains(who))
        }
        .sorted { ($0.lastPost ?? .distantPast, $0.jobs) > ($1.lastPost ?? .distantPast, $1.jobs) }
    }

    var webSupported: Bool {
        guard let version else { return false }
        return DibsVersion.atLeast(version, Self.webVersion)
    }

    var ownerActions: Bool {
        guard let version else { return false }
        return DibsVersion.atLeast(version, Self.ownerVersion)
    }


    // MARK: polling

    func start() {
        guard !loopStarted else { return }
        loopStarted = true
        notifier.onOpen = { [weak self] section in self?.openRequest = section }
        notifier.onAccounts = { [weak self] in
            self?.openRequest = .settings
            self?.focusAccounts = true
        }
        // An answer typed or tapped in the notification, without opening the app.
        notifier.onAnswer = { [weak self] id, text in
            guard let self, let item = self.asks.first(where: { $0.question?.id == id }) else { return }
            Task { await self.answer(questionId: id, text, agent: item.agent) }
        }
        notifier.start()
        Task { await loop() }
    }

    private func loop() async {
        while true {
            await refresh()
            let pause = looking || menuOpen ? Self.fastPoll : Self.slowPoll
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                wake = cont
                generation += 1
                let g = generation
                Task { [weak self] in
                    try? await Task.sleep(for: pause)
                    self?.poke(g)
                }
            }
        }
    }

    // Cuts the current pause short, so a window that just opened isn't 15s
    // stale. A timer only ends the pause it was started for.
    func poke(_ g: Int? = nil) {
        if let g, g != generation { return }
        wake?.resume()
        wake = nil
    }

    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }

        // Titles change rarely and their scan reads transcripts: every 30s, in
        // the background, never holding up the board.
        if namesScanned.map({ Date.now.timeIntervalSince($0) > 30 }) ?? true {
            namesScanned = .now
            let previous = titleCache
            Task {
                let (names, seen) = await Task.detached(priority: .utility) { AgentNames.scan(previous: previous) }.value
                agents = names
                titleCache = seen
            }
        }

        if checkUpdates, updateChecked.map({ Date.now.timeIntervalSince($0) > Self.updateEvery }) ?? true {
            updateChecked = .now
            Task { await checkForUpdate() }
        }

        guard let cli = await located() else { return }
        if versionChecked.map({ Date.now.timeIntervalSince($0) > 60 }) ?? true {
            versionChecked = .now
            await checkVersion(cli)
        }
        do {
            board = try await cli.json(["--json"], as: Board.self)
            boardError = nil
            updated = .now
            recordLoad()
            // A cleared wait is forgotten once it ends, so the list stays small.
            let live = Set(Needs.items(counters: counters, questions: [], now: .now).map(\.id))
            if !gotIt.isSubset(of: live) { gotIt.formIntersection(live) }
        } catch let e as CLIError {
            boardError = e
            if e.kind == .notInstalled { self.cli = nil }
        } catch {}

        if questionsSupported {
            do {
                questions = try await cli.json(["questions", "--json"], as: QuestionList.self)
                settled.formIntersection(questions?.open.map(\.id) ?? [])
                questionsError = nil
            } catch let e as CLIError where e.kind == .unsupported {
                questionsSupported = false
                questions = nil
            } catch let e as CLIError {
                questionsError = e
            } catch {}
        }
        if threadsSupported {
            do {
                threadList = try await cli.json(["threads", "--json"], as: ThreadList.self)
                // Forget a read once the CLI agrees or the thread has moved on.
                let raw = Dictionary((threadList?.threads ?? []).map { ($0.to, $0) }, uniquingKeysWith: { a, _ in a })
                seen = seen.filter { to, at in raw[to].map { $0.unread > 0 && $0.last <= at } ?? false }
                threadsError = nil
            } catch let e as CLIError where e.kind == .unsupported {
                threadsSupported = false
                threadList = nil
            } catch let e as CLIError {
                threadsError = e
            } catch {}
        }
        // The sidebar's agents need the posts on every screen; Progress and Now read them every poll.
        let onPosts = looking && (section == .progress || section == .now)
        if onPosts || progressRead.map({ Date.now.timeIntervalSince($0) > 15 }) ?? true { await loadProgress() }
        if section == .later && looking || later == nil { await loadLater() }
        // So a browser or Claude that just used the code shows up signed in.
        if pairing || (section == .settings && looking) { await loadPairing() }
        // Every poll while this Mac is on an account (and once to find out), so a waiting browser
        // notifies wherever the person is; otherwise only on Settings, where joining happens.
        let onAccount = accountList.map { !$0.accounts.isEmpty } ?? accountsSupported
        if onAccount || approving != nil || (section == .settings && looking) { await loadAccounts() }
        await notifier.checkAllowed()
        notificationsOff = notifier.allowed == false
        let enabled = Set(Alert.Kind.allCases).subtracting(muted)
        // A dibs that sends alerts says waits, stuck jobs and a full disk itself, with their fixes.
        let covered: Set<Need.Kind> = board?.alerts == nil ? [] : [.stuck, .idle, .disk]
        notifier.post(Alerts.candidates(needs.filter { !covered.contains($0.kind) }) + (accountList?.alerts ?? []), enabled: enabled)
        notifier.post(alerts: dibsAlerts, enabled: enabled)
        let asks = asks
        notifier.ask(asks.map { (item: $0, name: chatName($0)) }, enabled: enabled.contains(.question))
        NSApp?.dockTile.badgeLabel = asks.isEmpty ? nil : "\(asks.count)"
    }

    static let updateEvery: TimeInterval = 24 * 60 * 60

    // Quiet when it runs on its own; by hand it says what it found.
    func checkForUpdate(byHand: Bool = false) async {
        guard !updateChecking else { return }
        updateChecking = true
        defer { updateChecking = false }
        if byHand { updateNote = nil }
        do {
            let feed = try await UpdateFeed.fetch()
            update = UpdateFeed.isNewer(feed.version, than: UpdateFeed.running) ? feed : nil
            if byHand && update == nil { updateNote = "You have the newest version." }
        } catch {
            if byHand { updateNote = "Couldn't reach dibs.cc. Check your connection and try again." }
        }
    }

    // A new dibs may have the commands an old one lacked; look again.
    private func checkVersion(_ cli: DibsCLI) async {
        let v = try? await cli.text(["--version"])
        if v != version {
            version = v
            questionsSupported = true
            threadsSupported = true
            historySupported = true
            hoursSupported = true
        }
    }

    // Screens that load on their own may open before the first poll found dibs.
    private func located() async -> DibsCLI? {
        if cli?.executable == nil {
            cli = await DibsCLI.locate()
        }
        return cli
    }

    func loadHistory(since: String) async {
        guard historySupported, let cli = await located() else { return }
        do {
            histories[since] = try await cli.json(["history", "--json", "--since", since], as: History.self)
            historyErrors[since] = nil
        } catch let e as CLIError {
            if e.kind == .unsupported { historySupported = false } else { historyErrors[since] = e }
        } catch {}
    }

    func loadToday() async {
        guard historySupported, let cli = await located() else { return }
        today = try? await cli.json(["history", "--json", "--since", "1d"], as: History.self)
    }

    func loadSettings() async {
        guard let cli = await located() else { return }
        guardStatus = try? await cli.json(["guard", "status", "--json"], as: GuardStatus.self)
        paceInfo = try? await cli.json(["pace", "--json"], as: PaceInfo.self)
    }

    // Enough posts to cover a long day of several agents; older ones are
    // still in `dibs progress -n`.
    static let progressPosts = 500

    func loadProgress() async {
        guard webSupported, let cli = await located() else { return }
        do {
            progress = try await cli.json(["progress", "--json", "-n", String(Self.progressPosts)], as: [ProgressPost].self)
            progressError = nil
            progressRead = .now
        } catch let e as CLIError {
            progressError = e
        } catch {}
    }

    func loadLater() async {
        guard let cli = await located() else { return }
        do {
            later = try await cli.json(["later", "list", "--json"], as: LaterList.self).jobs
            laterError = nil
        } catch let e as CLIError {
            laterError = e
        } catch {}
    }

    func loadMachines() async {
        guard let cli = await located() else { return }
        if let out = try? await cli.text(["service", "status"]) { services = ServiceRow.list(out) }
        pool = try? await cli.json(["sims", "--json"], as: SimPool.self, timeout: 30)
    }

    // dibs pair --remote: a one-time link for a phone or any browser, through the encrypted relay.
    func pairRemote(act: Bool) async {
        guard let cli else { return }
        running.insert("pair-remote")
        defer { running.remove("pair-remote") }
        do {
            let out = try await cli.text(["pair", "--remote"] + (act ? ["--allow-actions"] : []), owner: true)
            guard let link = out.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { $0.hasPrefix("https://") }) else {
                actionError = "dibs pair --remote printed no link. In Terminal, run: dibs pair --remote"
                return
            }
            remotePair = (link, act, .now)
            await loadPairing()
        } catch let e as CLIError {
            actionError = e.kind == .unsupported ? "This dibs (\(version ?? "unknown version")) can't pair a phone yet. Update dibs to 0.0.170 or newer." : e.message
        } catch {}
    }

    static func statsKey(_ since: String, _ agent: String?) -> String { "\(since)|\(agent ?? "")" }

    func loadStats(since: String, agent: String?) async {
        guard let cli = await located() else { return }
        let key = Self.statsKey(since, agent)
        do {
            stats[key] = try await cli.json(["stats", "--json", "--since", since] + (agent.map { ["--agent", $0] } ?? []), as: Stats.self, timeout: 30)
            statsErrors[key] = nil
        } catch let e as CLIError {
            statsErrors[key] = e
        } catch {}
    }

    // dibs later cancel: a started run is stopped too.
    func cancelLater(_ run: LaterRun) async {
        let result = await act(["later", "cancel", run.id], key: "later-\(run.id)", done: "Canceled \(run.what).")
        report(result, who: run.who)
        await loadLater()
    }

    // What's signed in to the page and the MCP server, and whether it runs.
    func loadPairing() async {
        guard webSupported, let cli = await located() else { return }
        if let out = try? await cli.text(["pair", "--list"]) { paired = PairedClient.list(out) }
        if let out = try? await cli.text(["service", "status", "web"]) { webService = ServiceState(output: out) }
    }

    func loadAccounts() async {
        guard let cli = await located() else { return }
        do {
            accountList = try await cli.json(["connect", "--accounts", "--json"], as: AccountList.self)
        } catch let e as CLIError where e.kind == .unsupported || e.kind == .failed(2) {
            accountsSupported = false
        } catch {}
    }

    // MARK: actions

    // dibs connect --approve <code>: the code that browser shows, typed by the person. On a
    // match the browser gets the account key, and the person types `approved.confirm` into it.
    // Returns why not, said in the sheet, or nil once approved.
    func approveBrowser(code: String) async -> String? {
        guard let cli, let digits = Approval.digits(code) else { return "The code is the 6 digits the browser shows." }
        running.insert("approve")
        defer { running.remove("approve") }
        do {
            let out = try await cli.text(["connect", "--approve", digits, "--json"], owner: true)
            approved = try JSONDecoder().decode(Approval.self, from: Data(out.utf8)).approved
            lastAction = "Approved \(approved?.label ?? "the browser")."
            await loadAccounts()
            return nil
        } catch let e as CLIError {
            await loadAccounts()
            return plain(e, who: nil)
        } catch {
            return "dibs connect --approve printed something this app can't read. In Terminal, run: dibs connect --approve \(digits)"
        }
    }

    // dibs connect --account: a link to open in a browser signed in to the account, which adds
    // this Mac to it. Opened at once in the default browser; shown as a QR code for a phone.
    func joinAccount() async {
        guard let cli else { return }
        running.insert("join-account")
        defer { running.remove("join-account") }
        do {
            let out = try await cli.text(["connect", "--account"], owner: true)
            guard let link = out.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { $0.contains("/account#join=") }),
                  let url = URL(string: link) else {
                actionError = "dibs connect --account printed no link. In Terminal, run: dibs connect --account"
                return
            }
            accountJoin = (link, .now)
            NSWorkspace.shared.open(url)
            // The browser comes forward on its own, so the click can look like it did nothing here.
            lastAction = "Opened dibs connect in your browser."
        } catch let e as CLIError {
            actionError = e.kind == .unsupported ? "This dibs (\(version ?? "unknown version")) has no accounts yet. Update dibs to 0.0.175 or newer." : plain(e, who: nil)
        } catch {}
    }

    func doneApproving() {
        approving = nil
        approved = nil
    }

    func refuseBrowser(_ w: AccountList.Waiting) async {
        report(await act(["connect", "--refuse", w.id], key: "refuse-\(w.id)", done: "Refused \(w.label)."))
        await loadAccounts()
    }

    // Takes this Mac off the account: its browsers no longer reach it, and it approves no more.
    func leaveAccount(_ a: AccountList.Account) async {
        report(await act(["connect", "--remove", a.id], key: "leave-\(a.id)", done: "This Mac is off that dibs account."))
        await loadAccounts()
    }

    func newPairCode() async {
        guard let cli else { return }
        running.insert("pair")
        defer { running.remove("pair") }
        do {
            let out = try await cli.text(["pair"], owner: true)
            guard let code = PairCode(output: out) else {
                actionError = "dibs pair printed something this app can't read. In Terminal, run: dibs pair"
                return
            }
            pairCode = code
        } catch let e as CLIError {
            actionError = e.kind == .unsupported ? "Pairing needs dibs \(Self.webVersion) or newer. This one is \(version ?? "older")."
                : plain(e, who: nil)
        } catch {}
    }

    func signOut(_ client: PairedClient?) async {
        let done = client.map { "Signed out \($0.name)." } ?? "Signed out everything paired."
        report(await act(["pair", "--revoke", client?.id ?? "all"], key: "revoke-\(client?.id ?? "all")", done: done))
        // Signing out all also voids a code not yet used.
        if client == nil { pairCode = nil }
        await loadPairing()
    }

    // Start keeps the page up across logins (a launchd service); Stop removes it.
    func setWebService(on: Bool) async {
        let result = await act(["service", on ? "install" : "remove", "web"], key: "web-service",
                               done: on ? "The dibs page is running." : "The dibs page is stopped.")
        report(result)
        await loadPairing()
    }

    func answer(_ q: Question, _ text: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        await settle(q, ["answer", q.id, text], done: "Answered \(displayName(q.agent ?? q.who)): \(text)")
    }

    // A free message to an agent, delivered on its next tool call.
    func tell(_ thread: AgentThread, _ text: String) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        let result = await act(["tell", thread.to, text], key: "tell-\(thread.to)", done: "Sent to \(threadName(thread)).")
        if case .failed(let e) = result {
            actionError = e.kind == .unsupported ? "This dibs (\(version ?? "unknown version")) can't send messages to agents yet. Update dibs to 0.0.80 or newer."
                : plain(e, who: threadName(thread))
            return false
        }
        return true
    }

    // The chat's box: to the agent the person picked, or to the desk. The subtitle
    // says how it reaches the agent, idle and not listening included.
    func say(_ text: String, reach: Reach? = nil) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        let to = replyTo ?? Chat.desk
        let name = replyTo.map { t in threads.first { $0.to == t }.map(threadName) ?? displayName(t) } ?? "dibs"
        let result = await act(["tell", to, text], key: "tell-\(to)", done: "Sent to \(name).\(reach.map { " \($0.waiting)" } ?? "")")
        if case .failed(let e) = result {
            actionError = e.kind == .unsupported ? "This dibs (\(version ?? "unknown version")) can't send messages to agents yet. Update dibs to 0.0.80 or newer."
                : plain(e, who: name)
            return false
        }
        return true
    }

    // One message to several agents, each its own dibs tell. Says which got
    // it and how each gets it; any that failed stay picked.
    func tell(_ names: [String], _ text: String) async -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !names.isEmpty else { return false }
        var sent: [String] = [], failed: [String] = []
        for n in names {
            let reach = threads.first { $0.to == n }?.reach ?? .working
            if case .failed(let e) = await act(["tell", n, text], key: "tell-new", done: "") { failed.append(plain(e, who: displayName(n))) }
            else { sent.append("\(displayName(n)): \(reach.waiting)") }
        }
        lastAction = sent.isEmpty ? nil : "Sent. " + sent.joined(separator: " ")
        if !failed.isEmpty { actionError = "Not sent: " + failed.joined(separator: " ") }
        return failed.isEmpty
    }

    // Reading the chat reads every thread in it.
    func markAllRead() async {
        for t in threadList?.threads ?? [] where t.unread > 0 { await markRead(t) }
    }

    // Opening a conversation reads it. What counts is the CLI's own unread:
    // the app's copy is zero once read here, and a note that lands after
    // that has to be read too.
    func markRead(_ thread: AgentThread) async {
        guard threadsSupported, let cli, let raw = threadList?.threads.first(where: { $0.to == thread.to }),
              raw.unread > 0, seen[raw.to].map({ raw.last > $0 }) ?? true else { return }
        seen[raw.to] = raw.last
        do {
            _ = try await cli.text(["threads", "read", raw.to], owner: true)
        } catch {
            // Not read after all: show it as unread again.
            seen[raw.to] = nil
        }
    }

    // Answers a question from a thread, which only has its id.
    func answer(questionId: String, _ text: String, agent: String) async {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch await act(["answer", questionId, text], key: "q-\(questionId)", done: "Answered \(displayName(agent)): \(text)") {
        case .ok: settled.insert(questionId)
        case .failed(let e): actionError = plain(e, who: displayName(agent))
        }
    }

    // Not now, from a thread, which only has the question's id.
    func dismiss(questionId: String, agent: String) async {
        switch await act(["questions", "dismiss", questionId], key: "q-\(questionId)", done: "Told \(displayName(agent)): not now.") {
        case .ok: settled.insert(questionId)
        case .failed(let e): actionError = plain(e, who: displayName(agent))
        }
    }

    func dismiss(_ q: Question) async {
        await settle(q, ["questions", "dismiss", q.id], done: "Dismissed \(displayName(q.agent ?? q.who))'s question.")
    }

    // Exit 1 means the question is already closed (answered elsewhere, or
    // expired): it leaves the list either way.
    private func settle(_ q: Question, _ args: [String], done: String) async {
        switch await act(args, key: "q-\(q.id)", done: done) {
        case .ok: settled.insert(q.id)
        case .failed(let e) where e.kind == .failed(1):
            settled.insert(q.id)
            actionError = plain(e, who: displayName(q.agent ?? q.who))
        case .failed(let e): actionError = plain(e, who: displayName(q.agent ?? q.who))
        }
    }

    func boost(_ row: Row, to prio: Prio) async {
        guard let id = row.leaseID else { return }
        let who = rowName(row)
        let done = switch prio {
        case .urgent: "\(who) goes first."
        case .low, .idle: "\(who) lets others go first."
        default: "\(who) is back in its normal place."
        }
        await report(act(["boost", String(id), prio.rawValue], key: row.id, done: done), who: who)
    }

    func setPaused(_ row: Row, _ pause: Bool, force: Bool = false) async {
        guard let id = row.leaseID else { return }
        let args = [pause ? "pause" : "resume", String(id)] + (force ? ["--force"] : [])
        let result = await act(args, key: row.id, done: "\(pause ? "Paused" : "Resumed") \(rowName(row)).")
        // Refused for being risky to freeze, not for being impossible: offer
        // the person the same --force the message names.
        if pause, !force, case .failed(let e) = result, e.kind == .failed(2), e.message.contains("--force") {
            refusedPause = (row, e.message)
            return
        }
        report(result, who: rowName(row))
    }

    // A waiter keeps its id when it starts, and dibs stop ends whatever has
    // that id. So "Remove from Queue" looks again first: a job that started
    // while the person read the dialog is left running.
    func stop(_ row: Row) async {
        guard let id = row.leaseID, let cli else { return }
        let who = rowName(row)
        if !row.held {
            if let fresh = try? await cli.json(["--json"], as: Board.self) {
                board = fresh
                updated = .now
            }
            guard board?.waiting.contains(where: { $0.id == id }) == true else {
                actionError = board?.held.contains(where: { $0.id == id }) == true
                    ? "\(who) started before you confirmed, so it wasn't removed. It's running now; you can stop it from the queue if you need to."
                    : "\(who) already left the queue."
                return
            }
        }
        await report(act(["stop", String(id)], key: row.id, done: row.held ? "Stopped \(who)." : "Took \(who) out of the queue."), who: who)
    }

    // Closes an alert for a day; if its cause is still there after that, it opens again.
    func dismiss(_ alert: DibsAlert) async {
        await report(act(["alerts", "dismiss", alert.id], key: "alert-\(alert.id)", done: "Dismissed for a day: \(alert.title)."))
    }

    func cap(_ agent: String, at prio: Prio?) async {
        let who = displayName(agent)
        await report(act(["cap", agent, prio?.rawValue ?? "off"], key: "cap-\(agent)",
                         done: prio.map { "\(who) \(SlowedDown.line($0.rawValue))." } ?? "\(who) runs normally again."), who: who)
    }

    // Adds or updates the Claude Code hook, which the person would otherwise
    // have to do in Terminal.
    func installGuard() async {
        if case .ok = await act(["guard", "install"], key: "guard", done: "The Claude Code hook is set up.") {
            await loadSettings()
        } else {
            actionError = "dibs couldn't set up the Claude Code hook. In Terminal, run: dibs guard install"
        }
    }

    func setPace(_ pace: String) async {
        if case .ok = await act(["pace", pace], key: "pace", done: "Speed is \(Speed(pace).title).") {
            paceInfo = try? await cli?.json(["pace", "--json"], as: PaceInfo.self)
        }
    }

    // nil clears them: questions go to the person at any hour.
    func setHours(start: String?, end: String?) async {
        let arg = start.flatMap { s in end.map { "\(s)-\($0)" } } ?? "off"
        let result = await act(["hours", arg], key: "hours", done: arg == "off" ? "Working hours cleared." : "Working hours are \(arg).")
        if case .failed(let e) = result, e.kind == .unsupported { hoursSupported = false }
        report(result)
    }

    enum ActResult { case ok, failed(CLIError) }

    private func report(_ result: ActResult, who: String? = nil) {
        guard case .failed(let e) = result else { return }
        actionError = e.kind == .unsupported
            ? "This dibs (\(version ?? "unknown version")) doesn't have that command yet. Update dibs to \(Self.ownerVersion) or newer."
            : plain(e, who: who)
    }

    // dibs's error, said for the person (ActionText).
    private func plain(_ e: CLIError, who: String?) -> String {
        switch e.kind {
        case .timedOut: "dibs didn't answer in time, so this may not have happened. Try again in a moment."
        case .notInstalled: "dibs isn't installed, so the app can't change anything."
        default: ActionText.plain(e.message, who: who)
        }
    }

    // Runs an owner command. What it did becomes the window's subtitle.
    private func act(_ args: [String], key: String, done: String) async -> ActResult {
        guard let cli else { return .failed(CLIError(kind: .notInstalled, message: "dibs isn't installed.")) }
        running.insert(key)
        defer { running.remove(key) }
        do {
            // The CLI's own report uses its own words; the app says it plainly.
            _ = try await cli.text(args, owner: true)
            lastAction = done
            await refresh()
            return .ok
        } catch let e as CLIError {
            return .failed(e)
        } catch {
            return .failed(CLIError(kind: .failed(1), message: error.localizedDescription))
        }
    }
}
