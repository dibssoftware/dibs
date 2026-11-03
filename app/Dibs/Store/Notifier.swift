import AppKit
import UserNotifications

// Posts what AlertGate lets through, and brings the window to the right
// section when one is clicked.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private var gate = AlertGate()
    private var alertGate = AlertCauseGate()
    var onOpen: (Store.Section) -> Void = { _ in }
    // A browser waiting for the account key: Settings, scrolled to its group.
    var onAccounts: () -> Void = {}
    // A question answered from its notification: its id and the words.
    var onAnswer: (String, String) -> Void = { _, _ in }
    // Questions already raised, so each one notifies once.
    private var asked: Set<String> = []

    // Whether macOS lets dibs show notifications at all: nil until asked.
    // Questions can only be answered from a notification when it does.
    private(set) var allowed: Bool?

    func start() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    // Read again on every poll: the person may turn them on in System Settings at any time.
    func checkAllowed() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        allowed = status == .authorized || status == .provisional
        // Said in the app's own settings file too, so support can see it with `defaults read cc.dibs.mac notifications`.
        UserDefaults.standard.set(allowed == true ? "allowed" : status == .notDetermined ? "not asked" : "off", forKey: "notifications")
    }

    func post(_ candidates: [Alert], enabled: Set<Alert.Kind>) {
        for (kind, alerts) in gate.pass(candidates, now: .now, enabled: enabled) {
            let content = UNMutableNotificationContent()
            if alerts.count == 1 {
                content.title = alerts[0].title
                content.body = alerts[0].body
            } else {
                content.title = switch kind {
                case .question: "\(alerts.count) agents are asking you"
                case .note: "\(alerts.count) notes from agents"
                case .stuck: "\(alerts.count) jobs have waited a long time"
                case .idle: "\(alerts.count) jobs look stuck while others wait"
                case .ship: "\(alerts.count) deploys can't start yet"
                case .disk: "The disk is too full for work to start"
                case .account: "\(alerts.count) browsers want your account's key"
                case .memory: "Memory is holding work back"
                case .ended: "\(alerts.count) jobs failed or were lost"
                case .broken: "dibs has \(alerts.count) problems"
                }
                content.body = alerts.map(\.title).joined(separator: "\n")
            }
            content.sound = kind == .question || kind == .account ? .default : nil
            if kind == .account { content.userInfo = ["open": "accounts"] }
            content.threadIdentifier = kind.rawValue
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    // dibs's own alerts (src/alerts.mjs): what's wrong and its fix, each once,
    // at most one notification per cause every 30 minutes (AlertCauseGate).
    func post(alerts: [DibsAlert], enabled: Set<Need.Kind>) {
        for (cause, list) in alertGate.pass(alerts, now: .now, enabled: enabled) {
            let content = UNMutableNotificationContent()
            content.title = list.count == 1 ? list[0].title : "\(list.count) problems: \(list[0].title)"
            content.body = list.count == 1 ? "Fix: \(list[0].fix)" : list.map(\.title).joined(separator: "\n")
            content.sound = list.contains { $0.level == "urgent" } ? .default : nil
            content.threadIdentifier = "alert-\(cause)"
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    // Each question waiting on the person raises one notification with its
    // options as buttons and a box for any other words, so it can be answered
    // without opening the app. A question's options are its own, so each gets
    // its own category. The recommended option comes first.
    func ask(_ items: [(item: ChatItem, name: String)], enabled: Bool) {
        let open = Set(items.compactMap { $0.item.question?.id })
        let center = UNUserNotificationCenter.current()
        // An answered question's notification has nothing left to ask.
        let answered = asked.subtracting(open)
        if !answered.isEmpty { center.removeDeliveredNotifications(withIdentifiers: answered.map { Self.askPrefix + $0 }) }
        asked.formIntersection(open)
        let fresh = items.filter { $0.item.question.map { !asked.contains($0.id) } ?? false }
        guard !fresh.isEmpty else { return }
        // Every category this app uses is a question's, so the open ones are the whole set.
        center.setNotificationCategories(Set(items.compactMap { $0.item.question.map(Self.category) }))
        for (item, name) in fresh {
            guard let q = item.question else { continue }
            asked.insert(q.id)
            guard enabled else { continue }
            let content = UNMutableNotificationContent()
            content.title = "\(name) is asking"
            content.body = [item.text, q.cantUndo.map { "Can't be undone: \($0)" }, q.recommend.map { "Recommends: \($0)" }]
                .compactMap { $0 }.joined(separator: "\n")
            content.sound = .default
            content.categoryIdentifier = Self.askPrefix + q.id
            content.userInfo = ["question": q.id, "options": q.options]
            content.threadIdentifier = "question"
            center.add(UNNotificationRequest(identifier: Self.askPrefix + q.id, content: content, trigger: nil))
        }
    }

    nonisolated static let askPrefix = "ask-"
    nonisolated static let replyAction = "reply"

    // Notifications show the first few actions; the recommended option leads.
    nonisolated static func category(_ q: ChatQuestion) -> UNNotificationCategory {
        let options = q.recommend.map { r in [r] + q.options.filter { $0 != r } } ?? q.options
        let buttons = options.enumerated().map { i, o in
            UNNotificationAction(identifier: "option-\(q.options.firstIndex(of: o) ?? i)", title: o.prefix(1).uppercased() + o.dropFirst(), options: [])
        }
        let reply = UNTextInputNotificationAction(identifier: replyAction, title: "Reply", options: [],
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Your answer")
        return UNNotificationCategory(identifier: askPrefix + q.id, actions: buttons + [reply], intentIdentifiers: [])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let id = info["question"] as? String
        let accounts = info["open"] as? String == "accounts"
        let options = info["options"] as? [String] ?? []
        let action = response.actionIdentifier
        var answer: String?
        if let reply = response as? UNTextInputNotificationResponse {
            answer = reply.userText
        } else if action.hasPrefix("option-"), let i = Int(action.dropFirst(7)), options.indices.contains(i) {
            answer = options[i]
        }
        await MainActor.run {
            if accounts {
                onAccounts()
            } else if let id, let answer, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                onAnswer(id, answer)
            } else {
                // Clicked, not answered: questions are in the chat, the rest on Home.
                onOpen(id == nil ? .now : .questions)
            }
        }
    }
}
