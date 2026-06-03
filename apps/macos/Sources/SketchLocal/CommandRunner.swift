import Foundation
import Darwin

final class OutputBuffer {
    private let maxBytes: Int
    private var data = Data()
    private var truncated = false
    private let lock = NSLock()

    init(maxBytes: Int) {
        self.maxBytes = maxBytes
    }

    func append(_ next: Data) {
        guard !next.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }

        let remaining = maxBytes - data.count
        if remaining <= 0 {
            truncated = true
            return
        }
        if next.count > remaining {
            data.append(next.prefix(remaining))
            truncated = true
        } else {
            data.append(next)
        }
    }

    func snapshot() -> (Data, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (data, truncated)
    }
}

final class CommandRunner {
    private static let timeoutKillGraceMs = 2_000

    func run(command: String, cwd: String?, timeoutMs: Int?, maxOutputBytes: Int?) async -> CommandResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: Self.runSync(
                    command: command,
                    cwd: cwd,
                    timeoutMs: timeoutMs ?? 120_000,
                    maxOutputBytes: maxOutputBytes ?? 200_000
                ))
            }
        }
    }

    private static func runSync(command: String, cwd: String?, timeoutMs: Int, maxOutputBytes: Int) -> CommandResult {
        let started = Date()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        let stdoutBuffer = OutputBuffer(maxBytes: maxOutputBytes)
        let stderrBuffer = OutputBuffer(maxBytes: maxOutputBytes)
        let timeoutLock = NSLock()
        var timedOut = false

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            stdoutBuffer.append(handle.availableData)
        }
        stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            stderrBuffer.append(handle.availableData)
        }

        let pid: pid_t
        do {
            pid = try spawnShell(
                command: command,
                cwd: cwd,
                stdoutFileDescriptor: stdoutPipe.fileHandleForWriting.fileDescriptor,
                stderrFileDescriptor: stderrPipe.fileHandleForWriting.fileDescriptor
            )
        } catch {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            stderrPipe.fileHandleForReading.readabilityHandler = nil
            return CommandResult(
                exitCode: nil,
                stdout: "",
                stderr: "",
                timedOut: false,
                durationMs: elapsedMs(since: started),
                stdoutBytes: 0,
                stderrBytes: 0,
                stdoutTruncated: false,
                stderrTruncated: false,
                errorMessage: error.localizedDescription
            )
        }
        stdoutPipe.fileHandleForWriting.closeFile()
        stderrPipe.fileHandleForWriting.closeFile()

        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
            if isProcessRunning(pid) {
                timeoutLock.lock()
                timedOut = true
                timeoutLock.unlock()
                killProcessGroup(pid, signal: SIGTERM)

                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutKillGraceMs)) {
                    if isProcessRunning(pid) {
                        killProcessGroup(pid, signal: SIGKILL)
                    }
                }
            }
        }

        let status = waitForProcess(pid)
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        stderrPipe.fileHandleForReading.readabilityHandler = nil
        stdoutBuffer.append(stdoutPipe.fileHandleForReading.readDataToEndOfFile())
        stderrBuffer.append(stderrPipe.fileHandleForReading.readDataToEndOfFile())

        let (stdoutData, stdoutTruncated) = stdoutBuffer.snapshot()
        let (stderrData, stderrTruncated) = stderrBuffer.snapshot()
        timeoutLock.lock()
        let didTimeOut = timedOut
        timeoutLock.unlock()

        return CommandResult(
            exitCode: didTimeOut ? nil : exitCode(from: status),
            stdout: String(decoding: stdoutData, as: UTF8.self),
            stderr: String(decoding: stderrData, as: UTF8.self),
            timedOut: didTimeOut,
            durationMs: elapsedMs(since: started),
            stdoutBytes: stdoutData.count,
            stderrBytes: stderrData.count,
            stdoutTruncated: stdoutTruncated,
            stderrTruncated: stderrTruncated,
            errorMessage: didTimeOut ? "Command timed out" : nil
        )
    }

    private static func spawnShell(
        command: String,
        cwd: String?,
        stdoutFileDescriptor: Int32,
        stderrFileDescriptor: Int32
    ) throws -> pid_t {
        var actions: posix_spawn_file_actions_t?
        var attributes: posix_spawnattr_t?
        try requireSpawnSuccess(posix_spawn_file_actions_init(&actions))
        try requireSpawnSuccess(posix_spawnattr_init(&attributes))
        defer {
            posix_spawn_file_actions_destroy(&actions)
            posix_spawnattr_destroy(&attributes)
        }

        try requireSpawnSuccess(posix_spawn_file_actions_adddup2(&actions, stdoutFileDescriptor, STDOUT_FILENO))
        try requireSpawnSuccess(posix_spawn_file_actions_adddup2(&actions, stderrFileDescriptor, STDERR_FILENO))
        if let cwd, !cwd.isEmpty {
            try requireSpawnSuccess(posix_spawn_file_actions_addchdir_np(&actions, cwd))
        }
        try requireSpawnSuccess(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP)))
        try requireSpawnSuccess(posix_spawnattr_setpgroup(&attributes, 0))

        let arguments = ["/bin/zsh", "-lc", command]
        let environment = ProcessInfo.processInfo.environment.map { "\($0.key)=\($0.value)" }
        var pid: pid_t = 0
        let result = withCStringArray(arguments) { argv in
            withCStringArray(environment) { envp in
                "/bin/zsh".withCString { executable in
                    posix_spawn(&pid, executable, &actions, &attributes, argv, envp)
                }
            }
        }
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
        return pid
    }

    private static func requireSpawnSuccess(_ result: Int32) throws {
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(result))
        }
    }
}

private func elapsedMs(since started: Date) -> Int {
    Int(Date().timeIntervalSince(started) * 1000)
}

private func withCStringArray<Result>(_ strings: [String], _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Result) -> Result {
    var cStrings = strings.map { strdup($0) }
    cStrings.append(nil)
    defer {
        for cString in cStrings {
            free(cString)
        }
    }
    return cStrings.withUnsafeMutableBufferPointer { buffer in
        body(buffer.baseAddress!)
    }
}

private func isProcessRunning(_ pid: pid_t) -> Bool {
    kill(pid, 0) == 0 || errno == EPERM
}

private func killProcessGroup(_ pid: pid_t, signal: Int32) {
    kill(-pid, signal)
}

private func waitForProcess(_ pid: pid_t) -> Int32 {
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 {
        if errno != EINTR {
            return status
        }
    }
    return status
}

private func exitCode(from status: Int32) -> Int? {
    if status & 0x7f == 0 {
        return Int((status >> 8) & 0xff)
    }
    return nil
}
