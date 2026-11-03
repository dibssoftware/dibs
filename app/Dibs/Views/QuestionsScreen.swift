import SwiftUI

// The one-way questions waiting on the person, each a ticket, then the ones
// answered lately. The web page's Questions, word for word.
struct QuestionsScreen: View {
    @Environment(Store.self) private var store

    // As many answered ones as the web page shows.
    private static let answeredShown = 12

    var body: some View {
        let open = store.asks
        let done = (store.questions?.closed ?? []).prefix(Self.answeredShown)
        VStack(alignment: .leading, spacing: Space.xxl) {
            PageHead(title: "Questions") { summary(open.count) }
            if let e = store.questionsError { ReadError(what: "the questions", error: e) }
            if store.notificationsOff && !open.isEmpty { NotificationsOff() }
            if !open.isEmpty {
                VStack(alignment: .leading, spacing: Space.m) {
                    ForEach(open) { AskCard(item: $0) }
                }
            }
            if !done.isEmpty {
                PageSection("Answered lately") {
                    VStack(spacing: 0) {
                        ForEach(Array(done.enumerated()), id: \.element.id) { i, q in
                            if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) }
                            HStack(alignment: .firstTextBaseline, spacing: Space.l) {
                                Text("\(Text(store.displayName(q.agent ?? q.who)).fontWeight(.semibold).foregroundStyle(Palette.ink)) \(q.text)")
                                    .foregroundStyle(Palette.ink2)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: Space.m)
                                // An agent that answered in the person's place is named, as on the web page.
                                Text(q.state == .answered ? "\(q.answeredBy.flatMap { $0 == "the person" ? nil : "\(store.displayName($0)): " } ?? "")\(q.answer ?? "answered")" : q.state.rawValue)
                                    .font(Typeface.small.weight(.medium))
                                    .foregroundStyle(Palette.ink2)
                                    .multilineTextAlignment(.trailing)
                                    .frame(maxWidth: 260, alignment: .trailing)
                            }
                            .padding(.horizontal, Space.l + 2)
                            .padding(.vertical, Space.m)
                        }
                    }
                    .card()
                }
            }
            if open.isEmpty && done.isEmpty {
                Text("No questions yet.").foregroundStyle(Palette.ink3)
            }
        }
        .page()
        .navigationTitle("Questions")
        .navigationSubtitle(store.lastAction ?? "")
    }

    private func summary(_ n: Int) -> Text {
        var s = n > 0
            ? "\(n == 1 ? "1 question" : "\(n) questions") waiting. Agents ask these only at one-way doors; the agent that asked gets your answer with its next tool call."
            : "Nothing waiting for you. Agents ask here only before something they can't undo."
        if let h = store.questions?.hours { s += " Your hours are \(h.start) to \(h.end); outside them, questions below urgent wait for morning." }
        return Text(s)
    }
}

// A read that failed, said where its data shows: what dibs said, and that the
// screen is showing the last good read. The web page says the same.
struct ReadError: View {
    let what: String
    let error: CLIError

    var body: some View {
        Text("Couldn't read \(what): \(error.message) This shows the last read that worked; the next try is in a few seconds.")
            .foregroundStyle(Palette.accentInk)
            .fixedSize(horizontal: false, vertical: true)
            .copyable(error.message)
    }
}
