import Foundation

final class RelayClient {
    var onStatus: ((ConnectionStatus) -> Void)?
    var onError: ((String) -> Void)?
    var onCommand: ((CommandRequest) async -> CommandResult)?

    private var task: URLSessionWebSocketTask?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var intentionallyClosed = false

    func connect(websocketUrl: String, token: String) {
        intentionallyClosed = false

        guard let url = URL(string: websocketUrl) else {
            onError?("Invalid WebSocket URL")
            onStatus?(.disconnected)
            return
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        onStatus?(.connecting)

        let task = URLSession.shared.webSocketTask(with: request)
        self.task = task
        task.resume()
        receive()
    }

    func disconnect() {
        intentionallyClosed = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        onStatus?(.disconnected)
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.onStatus?(.connected)
                self.handle(message)
                self.receive()
            case .failure(let error):
                if self.intentionallyClosed { return }
                self.onError?(error.localizedDescription)
                self.onStatus?(.disconnected)
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let data: Data?
        switch message {
        case .string(let value):
            data = Data(value.utf8)
        case .data(let value):
            data = value
        @unknown default:
            data = nil
        }

        guard let data else { return }
        guard let request = try? decoder.decode(CommandRequest.self, from: data) else { return }
        guard request.type == "command.request" else { return }

        Task {
            let result = await onCommand?(request) ?? CommandResult(
                exitCode: nil,
                stdout: "",
                stderr: "",
                timedOut: false,
                durationMs: 0,
                stdoutBytes: 0,
                stderrBytes: 0,
                stdoutTruncated: false,
                stderrTruncated: false,
                errorMessage: "Command runner unavailable"
            )
            sendResult(result, requestId: request.requestId)
        }
    }

    private func sendResult(_ result: CommandResult, requestId: String) {
        let payload = CommandResultPayload(
            requestId: requestId,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            stdoutTruncated: result.stdoutTruncated,
            stderrTruncated: result.stderrTruncated,
            errorMessage: result.errorMessage
        )

        guard let data = try? encoder.encode(payload) else { return }
        task?.send(.data(data)) { [weak self] error in
            if let error {
                self?.onError?(error.localizedDescription)
            }
        }
    }
}
