import SwiftUI

// The rules in src/schedule.mjs, in words a person who isn't technical can
// follow. The numbers here are its constants: change one there, change it here.
enum Rules {
    static let all: [(title: String, body: String)] = [
        ("Every resource has its own queue",
         "The simulator, Xcode builds, deploys and the rest each keep a queue, like the counter at a deli. Agents join in the order they ask. Each resource fits only so many jobs at once, and the simulator fits one."),
        ("Urgent work moves up",
         "An agent can mark a job urgent when something is broken or a person is waiting. It moves up as if it had asked 2 hours earlier. Important work moves up as if it had asked an hour earlier. Either way the agent has to say why, and everyone sees the reason."),
        ("Work nobody is waiting on moves back",
         "Low-priority jobs move back 10 minutes. Background jobs move back an hour, and they only start once nobody else is waiting."),
        ("Quick jobs get a small head start",
         "Short jobs go first. Each job moves by how long it usually takes, compared with 2 minutes: a 30-second check moves up a minute and a half, a 20-minute suite moves back 18 minutes (an hour at most). So a job waits behind quicker work for about as long as it runs, no longer. A job dibs hasn't seen counts as 2 minutes."),
        ("Agents take turns",
         "An agent that used a lot in the last hour moves back, by up to 10 minutes, so the others get a go."),
        ("Deadlines count",
         "A job that has to be done by a set time moves up as that time gets close, by up to an hour."),
        ("Nobody waits forever",
         "Every one of these moves has a limit, so a job can be passed, but not again and again. A free spot doesn't sit empty either: a job further back can slip in if it'll be done before the one ahead could start."),
        ("This Mac comes first",
         "When the Mac is running hot, short on memory or low on disk, new work waits even if its queue is empty. It starts by itself once there's room."),
    ]
}

// "Why this order?" on each queue: the rules, short, right where the question comes up.
struct WhyThisOrder: View {
    @State private var open = false

    var body: some View {
        Button { open.toggle() } label: { Pill("Why this order?") }
            .buttonStyle(.plain)
            .popover(isPresented: $open, arrowEdge: .bottom) {
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.m) {
                        Text("Who goes next")
                            .font(Typeface.title)
                            .foregroundStyle(Palette.ink)
                        ForEach(Array(Rules.all.enumerated()), id: \.offset) { i, rule in
                            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                                Text("\(i + 1)")
                                    .font(Typeface.time)
                                    .foregroundStyle(Palette.accentInk)
                                    .frame(width: 14, alignment: .trailing)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(rule.title)
                                        .font(Typeface.name)
                                        .foregroundStyle(Palette.ink)
                                    Text(rule.body)
                                        .font(Typeface.small)
                                        .foregroundStyle(Palette.ink2)
                                        .lineSpacing(2)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    .padding(Space.l)
                }
                .frame(width: 360, height: 440)
            }
    }
}

// Shown once, the first time the app opens: what dibs is, in three cards.
struct Walkthrough: View {
    @Environment(\.dismiss) private var dismiss
    @State private var page = 0

    private static let cards: [(title: String, body: String)] = [
        ("Your agents take turns",
         "Your agents share this Mac. When two want the simulator, a build or a deploy at the same time, dibs puts them in a queue, like the counter at a deli, and works out who goes next."),
        ("You only hear about what needs you",
         "Questions from agents, their notes, and anything stuck show up on Now and in the menu bar. Everything else sorts itself out, so most days there's nothing to do."),
        ("You can always step in",
         "Answer an agent or send it a message in Messages. On Queues you can let a job go first, pause it or stop it, and see why anyone is where they are."),
    ]

    var body: some View {
        let card = Self.cards[page]
        VStack(alignment: .leading, spacing: Space.l) {
            CalmTicket()
                .padding(.bottom, Space.s)
            Text(card.title)
                .font(Typeface.display)
                .foregroundStyle(Palette.ink)
            Text(card.body)
                .font(Typeface.lede)
                .foregroundStyle(Palette.ink2)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxHeight: .infinity, alignment: .top)
            HStack {
                HStack(spacing: 6) {
                    ForEach(0..<Self.cards.count, id: \.self) { i in
                        Capsule()
                            .fill(i == page ? Palette.accent : Palette.hairline)
                            .frame(width: i == page ? 16 : 6, height: 6)
                    }
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.85), value: page)
                Spacer()
                if page < Self.cards.count - 1 {
                    Button("Skip") { finish() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Palette.ink2)
                        .padding(.trailing, Space.s)
                    Button("Next") { withAnimation(.easeOut(duration: 0.2)) { page += 1 } }
                        .buttonStyle(InkButton(prominent: true))
                        .keyboardShortcut(.defaultAction)
                } else {
                    Button("Get started") { finish() }
                        .buttonStyle(InkButton(prominent: true))
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(Space.xxl)
        .frame(width: 460, height: 360)
        .background(Palette.canvas)
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "walkthroughDone")
        dismiss()
    }
}
