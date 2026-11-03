# dibs for Mac

A window and a menu bar item over the dibs command line, written for someone who isn't technical. Chat is one conversation with every agent: a question only the person can answer (one that can't be undone) comes with the agent's recommendation and buttons, and raises a notification that can be answered in place; notes are quiet lines with nothing to do; decisions agents made themselves are one small line each, which the person can overrule by replying. With no agent picked, the box talks to dibs's desk agent. Home is the machine: a deploy held up, a full disk, and whether everything else is okay. Most days it says "Nothing needs you." Home also shows a job that looks stuck while others wait for it, and when dibs is holding all new work back; the sidebar says when the board was last updated. Lines shows each resource like the counter at a deli: who's using it, who's next, when they'll start and why anyone moved. This Week is a short note on where the waiting was. It reads and changes nothing on its own; every number comes from `dibs --json`, `dibs questions --json`, `dibs threads --json` and `dibs history --json`, and every button runs a dibs command with `DIBS_OWNER=1`, which dibs believes only from this app.

A signed, notarized download will be at https://dibs.cc/mac/. Until then, build it from source.

You need macOS 26, Xcode 26 and xcodegen (`brew install xcodegen`), which writes the Xcode project from `project.yml`. With the dibs CLI on your PATH:

```bash
cd app && xcodegen generate
xcodebuild -project Dibs.xcodeproj -scheme dibs -configuration Release -derivedDataPath build build
open build/Build/Products/Release/dibs.app
```

The app lands in `build/Build/Products/Release/dibs.app`. Drag it to /Applications to keep it. Opened from there (or with `open`), its owner buttons work; started by an agent, dibs refuses them, and the alert says to reopen it from Applications. On a machine where other agents build too, wrap the build in `dibs run xcode-build -m "dibs mac app" -- ...`, and run the tests with `DIBS_BUNDLE_SUFFIX=.dev test` in place of `build`.

Swift 6, no dependencies. A source build is signed ad hoc, to run on the Mac that built it. The app isn't sandboxed, since it runs the dibs binary.

```
Dibs/CLI/DibsCLI.swift     finds dibs (PATH, ~/bin, ~/.local/bin) and runs it off the main thread
Dibs/Models/               Codable shapes of the CLI's JSON, the board's rows, the alert rules
Dibs/Models/Plain.swift    the lines and their sentences: dibs 0.8.0's `lines` and `plain`, or the same worked out from 0.7.0's fields
Dibs/Store/                polling (2s while you look, 15s otherwise), owner actions, notifications
Dibs/Views/                Chat (every agent, one conversation), Home (what needs you on this Mac), Lines (CounterCard is one line), This Week, Settings, the menu bar
Dibs/Views/Theme.swift     the design system: palette from the icon, type scale, spacing, the ticket shape
DibsTests/                 decoding and alert rules against Fixtures/*.json
```

Builds for screenshots or testing pass `DIBS_BUNDLE_SUFFIX=.dev` to xcodebuild, which makes the bundle id `cc.dibs.mac.dev`: its own settings, notifications and saved window, so it never changes the installed app.

`DIBS_BIN=/path/to/dibs` points the app at another dibs, such as a checkout or a stand-in that prints fixtures.

A dibs older than 0.0.80 sends no sentences and has no conversations; the app writes its own sentences from the board's fields and builds each agent's conversation from its questions, so the screens read the same. "Why this order?" on Lines repeats the rules in src/schedule.mjs with its numbers (LineHelp.swift): change one there, change it there too.

A dibs older than 0.0.70 has no questions, history or owner actions. The app hides those parts with a line saying so and keeps showing the board.
