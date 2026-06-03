import AppKit
import SwiftUI

private func makeMenuBarIcon() -> NSImage {
    if let packagedResourceUrl = Bundle.main.resourceURL?.appendingPathComponent(
        "Assets.xcassets/SketchMenuBarIcon.imageset/sketch-menubar@2x.png"
    ), let image = NSImage(contentsOf: packagedResourceUrl) {
        image.isTemplate = true
        image.size = NSSize(width: 22, height: 22)
        return image
    }

    let image =
        NSImage(systemSymbolName: "terminal", accessibilityDescription: "Sketch Local") ??
        NSImage()
    image.isTemplate = true
    image.size = NSSize(width: 22, height: 22)
    return image
}

private let localDeviceWebSocketPath = "/api/local-devices/ws"

private func normalizedSketchBaseUrl(_ rawValue: String) -> String {
    var value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasSuffix(localDeviceWebSocketPath) {
        value = String(value.dropLast(localDeviceWebSocketPath.count))
    }

    for prefix in ["wss://", "ws://", "https://", "http://"] {
        if value.lowercased().hasPrefix(prefix) {
            value = String(value.dropFirst(prefix.count))
            break
        }
    }

    while value.hasSuffix("/") {
        value.removeLast()
    }

    return value
}

private func websocketUrl(from sketchBaseUrl: String) -> String {
    let rawValue = sketchBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = normalizedSketchBaseUrl(rawValue)
    let lowercased = rawValue.lowercased()
    let scheme =
        lowercased.hasPrefix("ws://") || lowercased.hasPrefix("http://") ||
        normalized.hasPrefix("localhost") || normalized.hasPrefix("127.0.0.1")
            ? "ws"
            : "wss"
    return "\(scheme)://\(normalized)\(localDeviceWebSocketPath)"
}

@MainActor
final class SketchLocalModel: ObservableObject {
    @Published var sketchBaseUrl: String
    @Published var token: String
    @Published var status: ConnectionStatus = .disconnected
    @Published var lastError: String?

    private let keychain = KeychainStore()
    private let runner = CommandRunner()
    private var relay: RelayClient?
    private var activeRelayId: UUID?

    init() {
        let environment = ProcessInfo.processInfo.environment
        sketchBaseUrl = normalizedSketchBaseUrl(
            environment["SKETCH_LOCAL_BASE_URL"] ??
                environment["SKETCH_LOCAL_WEBSOCKET_URL"] ??
                UserDefaults.standard.string(forKey: "sketchBaseUrl") ??
            UserDefaults.standard.string(forKey: "websocketUrl") ??
                ""
        )
        token = environment["SKETCH_LOCAL_TOKEN"] ?? keychain.read("deviceToken") ?? ""

        if canConnect {
            Task { @MainActor in
                connect()
            }
        }
    }

    var canConnect: Bool {
        !sketchBaseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    func connect() {
        relay?.disconnect()
        relay = nil

        let sketchBaseUrl = normalizedSketchBaseUrl(sketchBaseUrl)
        self.sketchBaseUrl = sketchBaseUrl
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sketchBaseUrl.isEmpty && !token.isEmpty else { return }

        let websocketUrl = websocketUrl(from: sketchBaseUrl)
        let relayId = UUID()
        activeRelayId = relayId
        lastError = nil
        UserDefaults.standard.set(sketchBaseUrl, forKey: "sketchBaseUrl")
        UserDefaults.standard.removeObject(forKey: "websocketUrl")
        keychain.write(token, account: "deviceToken")

        let client = RelayClient()
        client.onStatus = { [weak self] status in
            Task { @MainActor in
                guard self?.activeRelayId == relayId else { return }
                self?.status = status
                if status == .connected {
                    self?.lastError = nil
                }
            }
        }
        client.onError = { [weak self] message in
            Task { @MainActor in
                guard self?.activeRelayId == relayId else { return }
                self?.lastError = message
            }
        }
        client.onCommand = { [runner] request in
            await runner.run(
                command: request.command,
                cwd: request.cwd,
                timeoutMs: request.timeoutMs,
                maxOutputBytes: request.maxOutputBytes
            )
        }
        relay = client
        client.connect(websocketUrl: websocketUrl, token: token)
    }

    func disconnect() {
        relay?.disconnect()
        relay = nil
        activeRelayId = nil
        status = .disconnected
        lastError = nil
    }
}

@main
struct SketchLocalApp: App {
    @StateObject private var model = SketchLocalModel()

    var body: some Scene {
        MenuBarExtra {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Sketch Local")
                        .font(.headline)
                    Spacer()
                    Text(model.status.rawValue)
                        .font(.caption)
                        .foregroundStyle(model.status == .connected ? .green : .secondary)
                }

                TextField("Sketch Domain", text: $model.sketchBaseUrl)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 360)

                SecureField("Device token", text: $model.token)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 360)

                if let lastError = model.lastError {
                    Text(lastError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(3)
                }

                HStack {
                    Button(model.status == .connected ? "Reconnect" : "Connect") {
                        model.disconnect()
                        model.connect()
                    }
                    .disabled(!model.canConnect)

                    Button("Disconnect") {
                        model.disconnect()
                    }
                    .disabled(model.status == .disconnected)

                    Spacer()

                    Button("Quit") {
                        NSApplication.shared.terminate(nil)
                    }
                }
            }
            .padding()
        } label: {
            Image(nsImage: makeMenuBarIcon())
                .resizable()
                .renderingMode(.template)
                .frame(width: 22, height: 22)
                .accessibilityLabel("Sketch Local")
        }
        .menuBarExtraStyle(.window)
    }
}
