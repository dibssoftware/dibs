import SwiftUI

// Every file lock in one group: each agent once, with the files it holds,
// then anyone waiting for a file someone else has.
struct FileLocks: View {
    let counters: [Counter]
    let canAct: Bool
    @Binding var selected: String?
    let onConfirm: (PendingAction) -> Void
    @State private var collapsed = false

    // Past this many names a row says "and 14 more"; the panel lists them all.
    private static let shown = 6

    var body: some View {
        let held = Self.unique(counters.flatMap(\.serving))
        let waiting = Self.unique(counters.flatMap(\.waiting))
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: Space.s) {
                Button {
                    withAnimation(.easeOut(duration: 0.2)) { collapsed.toggle() }
                } label: {
                    HStack(spacing: Space.s) {
                        Image(systemName: "chevron.down")
                            .font(Typeface.sized(9, .bold))
                            .foregroundStyle(Palette.ink3)
                            .rotationEffect(.degrees(collapsed ? -90 : 0))
                            .frame(width: 12)
                        ResDot(res: "files")
                        Text("File locks")
                            .font(Typeface.title)
                            .foregroundStyle(Palette.ink)
                    }
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                Spacer(minLength: Space.l)
                ColumnLabel(counters.count == 1 ? "1 file held" : "\(counters.count) files held")
            }
            .padding(.bottom, Space.s)
            if !collapsed {
                ForEach(held) { row in lockRow(row, place: "Now") }
                ForEach(waiting) { row in lockRow(row, place: "Waits") }
            }
        }
    }

    private func lockRow(_ row: Row, place: String) -> some View {
        let files = row.res.compactMap(Counter.fileName)
        return LineRow(row: row, place: place, canAct: canAct && row.leaseID != nil, serving: row.held, selected: $selected) {
            EmptyView()
        } trailing: {
            Text(files.count == 1 ? files[0] : "\(files.count) files")
                .font(Typeface.time)
                .foregroundStyle(Palette.ink2)
                .lineLimit(1)
                .frame(minWidth: 84, alignment: .trailing)
        } actions: {
            RowActions(row: row, onConfirm: onConfirm)
        }
        .help(files.prefix(Self.shown).joined(separator: ", ") + (files.count > Self.shown ? " and \(files.count - Self.shown) more" : ""))
        .id(row.id)
    }

    // One lease holds many files, so it's in many of these lines; once each.
    nonisolated static func unique(_ rows: [Row]) -> [Row] {
        var seen: Set<String> = []
        return rows.filter { seen.insert($0.id).inserted }
    }
}
