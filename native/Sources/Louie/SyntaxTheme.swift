import SwiftUI

extension Color {
    /// 0xRRGGBB
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xff) / 255.0,
                  green: Double((hex >> 8) & 0xff) / 255.0,
                  blue: Double(hex & 0xff) / 255.0,
                  opacity: 1)
    }
}

/// Dracula palette (https://draculatheme.com). Fixed colors so highlighted code
/// keeps contrast on the dark code background regardless of system appearance.
struct SyntaxTheme {
    // base
    let background: Color
    let foreground: Color
    let currentLine: Color
    let comment: Color
    // accents
    let cyan: Color
    let green: Color
    let orange: Color
    let pink: Color
    let purple: Color
    let red: Color
    let yellow: Color

    // token colors
    let key: Color
    let string: Color
    let number: Color
    let boolean: Color
    let punctuation: Color
    let plain: Color
    let tag: Color
    let attribute: Color

    static let shared = SyntaxTheme()

    private init() {
        background = Color(hex: 0x282A36)
        foreground = Color(hex: 0xF8F8F2)
        currentLine = Color(hex: 0x44475A)
        comment = Color(hex: 0x6272A4)
        cyan = Color(hex: 0x8BE9FD)
        green = Color(hex: 0x50FA7B)
        orange = Color(hex: 0xFFB86C)
        pink = Color(hex: 0xFF79C6)
        purple = Color(hex: 0xBD93F9)
        red = Color(hex: 0xFF5555)
        yellow = Color(hex: 0xF1FA8C)

        // JSON / markup roles
        key = cyan
        string = yellow
        number = purple
        boolean = purple
        punctuation = foreground      // no more muted blue on dark
        plain = foreground
        tag = pink
        attribute = green
    }
}
