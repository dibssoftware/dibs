import Foundation

// Is what the app shows still what dibs says? One line for every screen:
// "Updated just now", or, once a poll has failed or the last good one is old,
// when dibs last answered.
enum Freshness {
    // Polls run every 2s while someone looks and every 15s otherwise; a board
    // twice the slow pace old means the polls aren't landing.
    static let staleAfter: TimeInterval = 30

    static func line(updated: Date?, failing: Bool, now: Date) -> (text: String, stale: Bool)? {
        guard let updated else { return nil }
        let age = now.timeIntervalSince(updated)
        if failing || age > staleAfter {
            return ("Can't reach dibs since \(Format.clock(updated)). Showing what it said then.", true)
        }
        return (age < 10 ? "Updated just now" : age < 60 ? "Updated \(Int(age / 10) * 10) s ago" : "Updated \(Span.of(age)) ago", false)
    }
}

// What dibs said when an owner action didn't go through, in words for the
// person. dibs writes its errors for a terminal: lease numbers, the commands
// to run next. `who` is the agent the button was about.
enum ActionText {
    static func plain(_ m: String, who: String?) -> String {
        let job = who.map { "\($0)'s job" } ?? "That job"
        if m.contains("is for the person who runs these agents") {
            return "dibs only takes this from you, and it thinks an agent is asking. That happens when this app was opened "
                + "from an agent's session. Quit dibs and open it again from Applications or the Dock."
        }
        if m.contains("isn't paused by you") {
            return "\(who ?? "This job") was paused by dibs, not by you. It resumes by itself when there's room."
        }
        if m.contains("is waiting, not running") || m.contains("it's waiting, not running") {
            return "\(who ?? "This job") hasn't started yet, so there's nothing to pause."
        }
        if m.contains("no lease or waiter") || m.contains("no lease #") || m.contains("nothing matched") {
            return "\(job) already ended, so there was nothing left to change."
        }
        return tidy(m)
    }

    // Anything else: without lease numbers or the commands a terminal would run next.
    static func tidy(_ message: String) -> String {
        var m = message.replacingOccurrences(of: #"#\d+ ?"#, with: "", options: .regularExpression)
        let sentences = m.components(separatedBy: ". ").filter { !$0.contains("dibs ") && !$0.hasPrefix("Use:") }
        if !sentences.isEmpty { m = sentences.joined(separator: ". ") }
        m = m.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = m.first else { return "dibs couldn't do that." }
        return first.uppercased() + m.dropFirst() + (m.hasSuffix(".") ? "" : ".")
    }

    // The owner's mark on a row (ownerLabel in src/override.mjs), naming
    // whoever made it: "You let it go first", "web-app let it go first: ci is red".
    static func owner(_ label: String, name: (String) -> String = { $0 }) -> String {
        let (by, why) = Plain.ownerBy(label)
        let who = by.map(name) ?? "You"
        if label.hasPrefix("capped") {
            let prio = Prio(label.split(separator: " ").dropFirst().first.map(String.init))
            return prio == .idle ? "\(who) set it to run only when nothing else is waiting" : "\(who) set it to let others go first"
        }
        let did: String
        if label.hasPrefix("boosted") { did = "\(who) let it go first" }
        else if label.hasPrefix("lowered") { did = "\(who) moved it back" }
        else { return label }
        return why.map { "\(did): \($0)" } ?? did
    }

    // The agent's change to its own job (AgentBoost.label), as a sentence.
    static func agent(_ label: String) -> String {
        let reason = Plain.agentMove(label).reason
        return reason.prefix(1).uppercased() + reason.dropFirst()
    }

    // The knobs config.json pins (`dibs pace --json` pinned), as a person names them.
    static func knob(_ name: String) -> String {
        switch name {
        case "cores": "how many cores jobs use"
        case "budget": "how much memory jobs use"
        case "maxLoad": "the workload limit"
        case "coolLoad", "roomyLoad", "roomyMemFree": "when limits lift on an idle Mac"
        default: name
        }
    }
}
