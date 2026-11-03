import Charts
import SwiftUI

// The past 12 hours: at the busiest moment of each hour, how many agents were
// running and how many waited. The hour in progress is lighter: it isn't done.
struct TodayChart: View {
    @Environment(Store.self) private var store

    private static let hours = 12

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            // The heading is Now's ("Today"); the card carries the key.
            HStack(spacing: 0) {
                legend("Running", Palette.accent)
                legend("Waiting", Palette.yellow)
            }
            if let hours = recent, !hours.isEmpty {
                chart(hours)
            } else {
                Text(store.historySupported ? "Nothing recorded yet." : "This dibs doesn't keep a history the app can read.")
                    .foregroundStyle(Palette.ink3)
                    .frame(maxWidth: .infinity, minHeight: 120)
            }
        }
        .padding(Space.l + 2)
        .card()
    }

    private var recent: [History.Hour]? {
        guard let today = store.today else { return nil }
        let cutoff = Date().addingTimeInterval(-Double(Self.hours) * 3600).timeIntervalSince1970 * 1000
        return today.hourly.filter { $0.hour >= cutoff }
    }

    private func chart(_ hours: [History.Hour]) -> some View {
        let current = Calendar.current.dateInterval(of: .hour, for: .now)?.start
        return Chart {
            ForEach(hours, id: \.hour) { h in
                let date = Date(ms: h.hour)
                let live = date == current
                // Side by side, not stacked: two figures, not parts of one.
                BarMark(x: .value("Hour", date, unit: .hour), y: .value("Agents", h.held ?? 0))
                    .foregroundStyle(Palette.accent.opacity(live ? 0.4 : 1))
                    .position(by: .value("Kind", "Running"))
                    .clipShape(.rect(cornerRadius: 3))
                BarMark(x: .value("Hour", date, unit: .hour), y: .value("Agents", h.waiting))
                    .foregroundStyle(Palette.yellow.opacity(live ? 0.45 : 1))
                    .position(by: .value("Kind", "Waiting"))
                    .clipShape(.rect(cornerRadius: 3))
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .hour, count: 3)) { _ in
                AxisValueLabel(format: .dateTime.hour())
                    .font(Typeface.axis)
                    .foregroundStyle(Palette.ink3)
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing, values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine().foregroundStyle(Palette.hairline)
                AxisValueLabel().font(Typeface.axis).foregroundStyle(Palette.ink3)
            }
        }
        .frame(height: 150)
    }

    private func legend(_ label: String, _ color: Color) -> some View {
        HStack(spacing: 5) {
            RoundedRectangle(cornerRadius: 2).fill(color).frame(width: 8, height: 8)
            Text(label)
        }
        .font(Typeface.small)
        .foregroundStyle(Palette.ink2)
        .padding(.trailing, Space.m)
    }
}
