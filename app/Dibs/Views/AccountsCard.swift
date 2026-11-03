import SwiftUI

// Settings' dibs account part: the accounts this Mac is on, the browsers waiting for it to hand
// over the account key, and adding this Mac to an account. Approving asks for the code the
// browser shows; there is no one-click approve, since that code is what keeps a go-between's
// browser out (docs/relay.md, A new browser without the key).
struct AccountsCard: View {
    @Environment(Store.self) private var store
    @State private var leaving: AccountList.Account?

    var body: some View {
        if let list = store.accountList {
            VStack(alignment: .leading, spacing: Space.m) {
                if !list.waiting.isEmpty { waiting(list.waiting) }
                VStack(spacing: 0) {
                    ForEach(Array(list.accounts.enumerated()), id: \.element.id) { i, a in account(a, first: i == 0) }
                    join(first: list.accounts.isEmpty)
                }
                .card()
                if let j = store.accountJoin { JoinLink(link: j.link, at: j.at) }
            }
            .sheet(item: Bindable(store).approving) { ApproveSheet(browser: $0) }
            .confirmationDialog("Take this Mac off that dibs account?", isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }),
                                presenting: leaving) { a in
                Button("Yes, remove this Mac", role: .destructive) { Task { await store.leaveAccount(a) } }
            } message: { a in
                Text("Browsers signed in to dibs account \(a.id) no longer reach this Mac, and it can't approve new ones. Add it again any time.")
            }
        } else if !store.accountsSupported {
            Text("Accounts need dibs 0.0.177 or newer. This Mac has \(store.version.map { "dibs \($0)" } ?? "an older dibs").")
                .foregroundStyle(Palette.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func waiting(_ list: [AccountList.Waiting]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, w in
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    HStack(spacing: Space.m) {
                        Image(systemName: "key.horizontal")
                            .font(Typeface.glyph)
                            .foregroundStyle(Palette.accentInk)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(w.label) wants your account's key").font(Typeface.name).foregroundStyle(Palette.ink)
                            Text(left(w.deadline, now: context.date)).font(Typeface.small).foregroundStyle(Palette.ink3)
                        }
                        Spacer(minLength: Space.s)
                        Button("Refuse") { Task { await store.refuseBrowser(w) } }
                            .buttonStyle(InkButton())
                            .disabled(store.running.contains("refuse-\(w.id)"))
                        Button("Approve\u{2026}") { store.approving = w }
                            .buttonStyle(InkButton(prominent: true))
                    }
                    .padding(.horizontal, Space.l)
                    .padding(.vertical, Space.m)
                    .overlay(alignment: .top) { if i > 0 { Rectangle().fill(Palette.hairline).frame(height: 1) } }
                }
            }
        }
        .card(fill: Palette.accentWash)
    }

    private func left(_ deadline: Date, now: Date) -> String {
        let s = Int(deadline.timeIntervalSince(now))
        return s > 0 ? "Waiting \(s / 60):\(String(format: "%02d", s % 60)) more. If you didn't ask from it, refuse it." : "Ran out. That browser can ask again."
    }

    private func account(_ a: AccountList.Account, first: Bool) -> some View {
        HStack(spacing: Space.m) {
            Image(systemName: "person.crop.circle")
                .font(Typeface.glyph)
                .foregroundStyle(Palette.ink2)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text("dibs account \(a.id)").font(Typeface.name).foregroundStyle(Palette.ink)
                Text("Joined \(Format.clock(a.joinedAt)), \(a.joinedAt.formatted(date: .abbreviated, time: .omitted)). Every browser signed in to it opens this Mac.")
                    .font(Typeface.small).foregroundStyle(Palette.ink3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: Space.s)
            Button("Remove this Mac") { leaving = a }
                .buttonStyle(InkButton())
                .disabled(store.running.contains("leave-\(a.id)"))
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }

    private func join(first: Bool) -> some View {
        HStack {
            Text(first ? "Add this Mac to your dibs account, so any browser you sign in with opens it." : "Add this Mac to another dibs account.")
                .foregroundStyle(Palette.ink)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.s)
            Button("Add this Mac") { Task { await store.joinAccount() } }
                .buttonStyle(InkButton(prominent: first))
                .disabled(store.running.contains("join-account"))
        }
        .padding(.horizontal, Space.l)
        .padding(.vertical, Space.m)
        .overlay(alignment: .top) { if !first { Rectangle().fill(Palette.hairline).frame(height: 1) } }
    }
}

// The link dibs connect --account printed, opened already in the default browser; the QR code is
// for a phone signed in to the account. One use, ten minutes.
private struct JoinLink: View {
    let link: String
    let at: Date

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            if context.date.timeIntervalSince(at) < 10 * 60 {
                HStack(spacing: Space.l) {
                    QRCode(text: link).frame(width: 120, height: 120)
                    VStack(alignment: .leading, spacing: Space.s) {
                        Text("Opened in your browser. Sign in to your dibs account there if it asks, and this Mac joins it.")
                            .foregroundStyle(Palette.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                        Text("Or scan it with a phone that's signed in. Good once, until \(Format.clock(at.addingTimeInterval(10 * 60))).")
                            .font(Typeface.small).foregroundStyle(Palette.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(Space.l)
                .background(TicketShape(corner: 12, notch: 9).fill(Palette.surface))
                .overlay(TicketShape(corner: 12, notch: 9).stroke(Palette.hairline))
            }
        }
    }
}

// Approving one browser: the person types the 6 digits that browser shows, then types the
// code this Mac answers with into the browser.
struct ApproveSheet: View {
    @Environment(Store.self) private var store
    let browser: AccountList.Waiting
    @State private var code = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            if let done = store.approved {
                confirm(done)
            } else {
                ask
            }
        }
        .padding(Space.xxl)
        .frame(width: 480)
        .background(Palette.canvas)
    }

    private var ask: some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Approve \(browser.label)")
                    .font(Typeface.display)
                    .foregroundStyle(Palette.ink)
                Text("Type the 6-digit code that browser shows. Only a browser showing this exact code gets your account's key.")
                    .font(Typeface.lede)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            TextField("123 456", text: $code)
                .textFieldStyle(.plain)
                .font(Typeface.figure)
                .padding(Space.m)
                .card(10)
                .focused($focused)
                .onSubmit(approve)
                .accessibilityLabel("The code the browser shows")
            if let error {
                Text(error)
                    .font(Typeface.small)
                    .foregroundStyle(Palette.failed)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("If you can't see that browser, or its code isn't there, don't approve: something between it and this Mac may be pretending.")
                .font(Typeface.small)
                .foregroundStyle(Palette.ink3)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel") { store.doneApproving() }
                    .buttonStyle(InkButton())
                    .keyboardShortcut(.cancelAction)
                Button("Approve", action: approve)
                    .buttonStyle(InkButton(prominent: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(Approval.digits(code) == nil || store.running.contains("approve"))
            }
        }
        .onAppear { focused = true }
    }

    private func confirm(_ done: Approval.Approved) -> some View {
        VStack(alignment: .leading, spacing: Space.xl) {
            VStack(alignment: .leading, spacing: Space.xs) {
                Text("Now type this into \(done.label)")
                    .font(Typeface.display)
                    .foregroundStyle(Palette.ink)
                Text("The browser opens your account's key only with this code, so a key that didn't come from this Mac is never used.")
                    .font(Typeface.lede)
                    .foregroundStyle(Palette.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // On a ticket, as the pairing code is (PairSheet): the one thing to carry to the browser.
            Text(Approval.spaced(done.confirm))
                .font(.system(size: 52, weight: .bold, design: .monospaced))
                .tracking(2)
                .foregroundStyle(Palette.onYellow)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity)
                .frame(height: 104)
                .background(TicketShape(corner: 12, notch: 11).fill(Palette.yellow))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Code \(done.confirm.map(String.init).joined(separator: " "))")
            HStack {
                Spacer()
                Button("Done") { store.doneApproving() }
                    .buttonStyle(InkButton(prominent: true))
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func approve() {
        guard Approval.digits(code) != nil else { return }
        Task {
            error = await store.approveBrowser(code: code)
            if error != nil { code = "" }
        }
    }
}
