import Foundation

// `dibs connect --accounts --json` (src/connect.mjs): the dibs accounts this Mac is on, and the
// browsers of those accounts waiting for it to hand over the account key. Never their codes:
// the person reads those off the browser, which is what keeps a go-between out.
struct AccountList: Decodable, Sendable, Equatable {
    struct Account: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var label: String?
        var joined: Double

        var joinedAt: Date { Date(timeIntervalSince1970: joined / 1000) }
    }

    struct Waiting: Decodable, Sendable, Equatable, Identifiable {
        var id: String
        var account: String
        var label: String
        var expires: Double

        var deadline: Date { Date(timeIntervalSince1970: expires / 1000) }
    }

    var accounts: [Account]
    var waiting: [Waiting]
}

extension AccountList {
    // One notification per browser that starts waiting: approvals last ten minutes, so the
    // person has to hear about them wherever they are in the app.
    var alerts: [Alert] {
        waiting.map { Alert(kind: .account, key: "account-\($0.id)", title: "\($0.label) wants your account's key", body: "Approve it in Settings with the code it shows, or refuse it.") }
    }
}

// `dibs connect --approve <code> --json`: who was let in, and the second code, which the person
// types into that browser so it knows the key came from this Mac.
struct Approval: Decodable, Sendable, Equatable {
    struct Approved: Decodable, Sendable, Equatable {
        var id: String
        var label: String
        var confirm: String
    }

    var approved: Approved

    // "123456" as "123 456", the way the browser shows its own code.
    static func spaced(_ code: String) -> String {
        code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
    }

    // What the person typed, as the six digits dibs wants, or nil.
    static func digits(_ typed: String) -> String? {
        let d = typed.filter(\.isNumber)
        return d.count == 6 ? d : nil
    }
}
