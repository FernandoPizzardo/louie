import XCTest
import SwiftUI
import AppKit
@testable import Louie

/// Smoke tests that force SwiftUI to evaluate a view body. This catches crashes
/// from missing `@Environment` injections (which assert at render time).
final class ViewSmokeTests: XCTestCase {

    @MainActor
    private func host<V: View>(_ view: V, size: NSSize = NSSize(width: 700, height: 500)) {
        let host = NSHostingView(rootView: view)
        host.frame = NSRect(origin: .zero, size: size)
        host.layoutSubtreeIfNeeded()
    }

    @MainActor
    func testSettingsViewRenders() {
        let engine = EngineController()
        let store = SessionStore()
        let config = ConfigStore()
        host(SettingsView()
            .environment(engine)
            .environment(store)
            .environment(config))
    }

    @MainActor
    func testToolsViewRenders() {
        let engine = EngineController()
        let store = SessionStore()
        let config = ConfigStore()
        host(ToolsView()
            .environment(engine)
            .environment(store)
            .environment(config))
    }

    @MainActor
    func testDeviceSetupViewRenders() {
        let config = ConfigStore()
        host(DeviceSetupView().environment(config))
    }

    /// A synthetic breakpoint hit. Decoding real engine JSON is covered by
    /// ModelsTests; here we only need a value to render the editor with.
    private func sampleHit(phase: String = "request") -> BreakpointHit {
        let json = """
        {"id": 7, "transactionId": 42, "phase": "\(phase)", "deadline": 4102444800000,
         "summary": {"id": 42, "scheme": "https", "method": "POST",
                     "host": "api.example.com", "port": 443, "path": "/v1/login",
                     "status": 0, "durationMs": 0, "paused": true, "notes": []},
         "request": {"method": "POST", "url": "https://api.example.com/v1/login",
                     "headers": {"content-type": "application/json"},
                     "body": {"type": "text", "text": "{\\"a\\":1}", "editable": true}},
         "response": {"status": 200, "headers": {"content-type": "application/json"},
                      "body": {"type": "empty", "text": ""}}}
        """
        return try! JSONDecoder().decode(BreakpointHit.self, from: Data(json.utf8))
    }

    @MainActor
    func testBreakpointViewRendersForBothPhases() {
        for phase in ["request", "response"] {
            let store = SessionStore()
            host(BreakpointView(hit: sampleHit(phase: phase)).environment(store))
        }
    }

    @MainActor
    func testShareViewRenders() {
        let store = SessionStore()
        let config = ConfigStore()
        host(ShareView().environment(config).environment(store))
    }

    @MainActor
    func testInspectorAndContentViewRender() {
        let engine = EngineController()
        let store = SessionStore()
        let config = ConfigStore()
        host(ContentView()
            .environment(engine)
            .environment(store)
            .environment(config))
        host(InspectorView().environment(store))
    }
}
