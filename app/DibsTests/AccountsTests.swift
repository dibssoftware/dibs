import Foundation
import Testing

private final class Token {}

@Suite("Accounts")
struct AccountsTests {
    @Test("dibs connect --accounts --json decodes: the account, and the browser waiting with its deadline")
    func accounts() throws {
        let url = try #require(Bundle(for: Token.self).url(forResource: "accounts-177", withExtension: "json"))
        let list = try JSONDecoder().decode(AccountList.self, from: Data(contentsOf: url))
        #expect(list.accounts.map(\.id) == ["0NzVtqyK"])
        let w = try #require(list.waiting.first)
        #expect(w.label == "Safari on iPhone")
        #expect(w.deadline == Date(timeIntervalSince1970: 1_793_700_600))
        #expect(w.deadline.timeIntervalSince(list.accounts[0].joinedAt) == 600)
    }

    @Test("each waiting browser is one notification of its own kind, keyed by the request")
    func alerts() throws {
        let url = try #require(Bundle(for: Token.self).url(forResource: "accounts-177", withExtension: "json"))
        let list = try JSONDecoder().decode(AccountList.self, from: Data(contentsOf: url))
        let alerts = list.alerts
        #expect(alerts.count == 1)
        #expect(alerts[0].kind == .account)
        #expect(alerts[0].key == "account-Qk3lWm9ZpA2x")
        #expect(alerts[0].title == "Safari on iPhone wants your account's key")
        // Sent once: the same browser on the next poll is not news.
        var gate = AlertGate()
        #expect(gate.pass(alerts, now: .now)[.account]?.count == 1)
        #expect(gate.pass(alerts, now: .now.addingTimeInterval(120))[.account] == nil)
        #expect(AccountList(accounts: list.accounts, waiting: []).alerts.isEmpty)
    }

    @Test("dibs connect --approve --json decodes to the browser and the code to type back")
    func approved() throws {
        let a = try JSONDecoder().decode(Approval.self, from: Data(#"{"approved":{"id":"Qk3lWm9ZpA2x","label":"Safari on iPhone","confirm":"042917"}}"#.utf8))
        #expect(a.approved.label == "Safari on iPhone")
        #expect(Approval.spaced(a.approved.confirm) == "042 917")
    }

    @Test("a typed code counts only as six digits, spaces and dashes aside")
    func digits() {
        #expect(Approval.digits("123 456") == "123456")
        #expect(Approval.digits("123-456") == "123456")
        #expect(Approval.digits("12345") == nil)
        #expect(Approval.digits("1234567") == nil)
        #expect(Approval.digits("") == nil)
    }
}
