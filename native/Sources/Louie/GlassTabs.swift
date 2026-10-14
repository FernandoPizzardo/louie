import SwiftUI

/// A Liquid Glass segmented tab bar (macOS 26). The selected tab is tinted with
/// the system accent and the selection morphs between tabs.
struct GlassTabs: View {
    let titles: [String]
    @Binding var selection: Int
    @Namespace private var namespace

    var body: some View {
        GlassEffectContainer(spacing: 4) {
            HStack(spacing: 4) {
                ForEach(titles.indices, id: \.self) { i in
                    let selected = selection == i
                    Button {
                        withAnimation(.smooth(duration: 0.25)) { selection = i }
                    } label: {
                        Text(titles[i])
                            .font(.callout.weight(selected ? .semibold : .regular))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(selected ? Color.white : Color.primary)
                    .glassEffect(selected
                                 ? Glass.regular.tint(.accentColor).interactive()
                                 : Glass.regular.interactive(),
                                 in: .capsule)
                    .glassEffectID(i, in: namespace)
                    .accessibilityAddTraits(selected ? [.isSelected] : [])
                }
            }
            .padding(3)
        }
    }
}
