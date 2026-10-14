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
