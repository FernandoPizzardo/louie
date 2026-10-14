import SwiftUI

/// Device setup: serve the public root CA and show QR codes + steps for iPhone
/// and Android. The CA listener runs only while this sheet is open.
struct DeviceSetupView: View {
    @Environment(ConfigStore.self) private var config
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Debug on a device").font(.title2).bold()
                Spacer()
                Button("Done") { dismiss() }
            }

            Toggle("Allow devices on the local network", isOn: Binding(
                get: { config.net.lanEnabled },
                set: { on in Task { await config.setLAN(on) } }))
            if !config.net.lanEnabled {
                Label("Turn this on so your phone can reach the Mac. The proxy is otherwise bound to localhost.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.orange)
            }

            if config.net.lanEnabled {
                GroupBox("Proxy (set this on the device's Wi-Fi)") {
                    Text(config.net.proxyHost).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                HStack(alignment: .top, spacing: 18) {
                    qrBlock("iPhone / iPad", config.net.mobileconfigUrl,
                            "Scan with the phone's Camera, then install the profile.")
                    qrBlock("Android", config.net.cerUrl,
                            "Scan or download, then install the CA under Security.")
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("iPhone").font(.headline)
                    Text("1. Wi-Fi → your network → Configure Proxy → Manual → enter the proxy host/port.\n2. Install the profile, then Settings → General → About → Certificate Trust Settings → enable full trust for “Louie Root CA”.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Android").font(.headline).padding(.top, 4)
                    Text("1. Wi-Fi → your network → Proxy → Manual → enter the proxy host/port.\n2. Install the CA: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.\n3. Debug builds: trust user CAs via a network security config (Debug only).")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Certificate pinning in an app will block inspection; disable it in debug builds.")
                        .font(.caption2).foregroundStyle(.secondary).padding(.top, 2)
                }
            }

            Spacer()
        }
        .padding(16)
        .frame(minWidth: 620, minHeight: 520)
        .task { await config.serveCA(true) }
        .onDisappear { Task { await config.serveCA(false) } }
    }

    private func qrBlock(_ title: String, _ url: String, _ hint: String) -> some View {
        VStack(spacing: 6) {
            Text(title).font(.headline)
            if let img = QRCode.image(url) {
                Image(nsImage: img)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 170, height: 170)
                    .padding(6)
                    .background(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                Text("QR unavailable").foregroundStyle(.secondary)
            }
            Text(url).font(.caption2).foregroundStyle(.secondary).lineLimit(1).textSelection(.enabled)
            Text(hint).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(width: 190)
        }
    }
}
