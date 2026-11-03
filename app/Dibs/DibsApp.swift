import SwiftUI

@main
struct DibsApp: App {
    @State private var store: Store

    init() {
        Typeface.register()
        let store = Store()
        store.start()
        // The Dock shows the colorway picked in Settings, once the app is up.
        DispatchQueue.main.async { IconChoice.current.apply() }
        _store = State(initialValue: store)
    }

    var body: some Scene {
        Window("dibs", id: "main") {
            RootView()
                .environment(store)
                .font(Typeface.body)
        }
        .defaultSize(width: 980, height: 700)
        // The page has no title bar: the frame runs to the window's top edge,
        // with the traffic lights on the rail.
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentMinSize)
        .commands { GoCommands(store: store) }

        MenuBarExtra {
            MenuBarView()
                .environment(store)
                .font(Typeface.body)
        } label: {
            MenuBarLabel()
                .environment(store)
        }
        .menuBarExtraStyle(.window)
    }
}

struct GoCommands: Commands {
    let store: Store
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates\u{2026}") {
                show(.settings)
                Task { await store.checkForUpdate(byHand: true) }
            }
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings\u{2026}") { show(.settings) }
                .keyboardShortcut(",")
        }
        CommandMenu("Go") {
            // The sidebar's order, Cmd-1 to Cmd-9 then Cmd-0, as the web page's keys; Settings keeps Cmd-comma.
            ForEach(Store.Section.allCases.filter { $0.key != nil && $0 != .settings }, id: \.self) { section in
                Button(section.title) { show(section) }.keyboardShortcut(KeyEquivalent(section.key!))
            }
            Divider()
            Button("Find\u{2026}") { show(store.section ?? .now); store.paletteOpen = true }.keyboardShortcut("k")
            Button("Refresh") { store.poke() }.keyboardShortcut("r")
        }
    }

    private func show(_ section: Store.Section) {
        store.section = section
        openWindow(id: "main")
    }
}
