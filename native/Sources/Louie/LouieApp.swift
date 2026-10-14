import SwiftUI

@main
struct LouieApp: App {
    @State private var engine = EngineController()
    @State private var store = SessionStore()
    @State private var config = ConfigStore()

    var body: some Scene {
        WindowGroup("Louie") {
            ContentView()
                .environment(engine)
                .environment(store)
                .environment(config)
                .frame(minWidth: 960, minHeight: 600)
        }
        // NOTE: the Settings scene needs its own environment injection — it is a
        // separate scene from the WindowGroup, and @Environment(...) asserts
        // (crashes) if the object was never provided.
        Settings {
            SettingsView()
                .environment(engine)
                .environment(store)
                .environment(config)
        }
        .commands {
            CommandGroup(after: .appInfo) {
                Button("Start Engine") { engine.start() }
                    .keyboardShortcut("r", modifiers: [.command])
                Button("Stop Engine") { engine.stop() }
                    .keyboardShortcut(".", modifiers: [.command])
                Button("Clear Session") { Task { await store.clear() } }
                    .keyboardShortcut("k", modifiers: [.command])
            }
        }
    }
}
