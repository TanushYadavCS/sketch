import Foundation

enum ConnectionStatus: String {
    case disconnected = "Disconnected"
    case connecting = "Connecting"
    case connected = "Connected"
}

struct CommandRequest: Decodable {
    let type: String
    let requestId: String
    let command: String
    let cwd: String?
    let timeoutMs: Int?
    let maxOutputBytes: Int?
}

struct CommandResultPayload: Encodable {
    let type = "command.result"
    let requestId: String
    let exitCode: Int?
    let stdout: String
    let stderr: String
    let timedOut: Bool
    let durationMs: Int
    let stdoutBytes: Int
    let stderrBytes: Int
    let stdoutTruncated: Bool
    let stderrTruncated: Bool
    let errorMessage: String?
}

struct CommandResult {
    let exitCode: Int?
    let stdout: String
    let stderr: String
    let timedOut: Bool
    let durationMs: Int
    let stdoutBytes: Int
    let stderrBytes: Int
    let stdoutTruncated: Bool
    let stderrTruncated: Bool
    let errorMessage: String?
}
