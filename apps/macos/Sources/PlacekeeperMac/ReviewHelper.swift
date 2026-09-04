import Foundation

final class SupervisedReviewHelper: ReviewHelperProcess {
    let windowID: String
    private let process: Process
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()

    var isRunning: Bool { process.isRunning }

    init?(
        windowID: String,
        attemptID: String,
        executable: URL,
        baseEnvironment: [String: String],
        onExit: @escaping @Sendable (String) -> Void
    ) {
        self.windowID = windowID
        process = Process()
        process.executableURL = executable
        process.arguments = ["macos-review-helper"]
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        var environment = ChildEnvironmentPolicy.minimal(from: baseEnvironment)
        environment["PLACEKEEPER_WINDOW_ID"] = windowID
        environment["PLACEKEEPER_ATTEMPT_ID"] = attemptID
        process.environment = environment
        process.terminationHandler = { _ in onExit(windowID) }
        do {
            try process.run()
        } catch {
            return nil
        }
    }

    func terminate() {
        stdinPipe.fileHandleForWriting.closeFile()
        if process.isRunning { process.terminate() }
    }

    deinit { terminate() }
}
