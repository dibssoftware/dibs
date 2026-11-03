import Foundation
import Testing

@Suite("Update check")
struct UpdateTests {
    @Test("versions compare by number, not as text")
    func ordering() {
        #expect(UpdateFeed.isNewer("0.0.83", than: "0.0.82"))
        #expect(UpdateFeed.isNewer("0.0.100", than: "0.0.99"))
        #expect(UpdateFeed.isNewer("0.1", than: "0.0.99"))
        #expect(UpdateFeed.isNewer("v0.0.83", than: "0.0.82"))
        #expect(!UpdateFeed.isNewer("0.0.82", than: "0.0.82"))
        #expect(!UpdateFeed.isNewer("0.0.82", than: "0.0.82.0"))
        #expect(!UpdateFeed.isNewer("0.0.81", than: "0.0.82"))
        #expect(!UpdateFeed.isNewer("0.0.82-beta", than: "0.0.82"))
    }

    @Test("the feed release.sh writes decodes, notes optional")
    func feed() throws {
        let full = #"{"version":"0.0.83","url":"https://dibs.cc/mac/dibs-0.0.83.dmg","sha256":"ab12","notes":"Faster."}"#
        let f = try JSONDecoder().decode(UpdateFeed.self, from: Data(full.utf8))
        #expect(f.version == "0.0.83")
        #expect(f.url.lastPathComponent == "dibs-0.0.83.dmg")
        #expect(f.notes == "Faster.")
        let bare = #"{"version":"0.0.83","url":"https://dibs.cc/mac/dibs-0.0.83.dmg"}"#
        #expect(try JSONDecoder().decode(UpdateFeed.self, from: Data(bare.utf8)).notes == nil)
    }
}
