@preconcurrency import Foundation

enum AppLifecycleReply: Equatable {
    case acknowledged
    case replacementReady(activeWindows: Int)
    case updateRequired
    case failure(code: String)
}

final class AppLifecycleControlClient: @unchecked Sendable {
    typealias Completion = (AppLifecycleReply?) -> Void

    private let appInstanceID: String
    private let process: Process
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let lock = NSLock()
    private var accumulator = HelperFrameAccumulator()
    private var pending: Completion?
    private var finished = false

    init?(
        appInstanceID: String,
        executable: URL,
        baseEnvironment: [String: String],
        onExit: @escaping @Sendable () -> Void
    ) {
        self.appInstanceID = appInstanceID
        process = Process()
        process.executableURL = executable
        process.arguments = ["macos-lifecycle-control"]
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        var environment = ChildEnvironmentPolicy.minimal(from: baseEnvironment)
        environment["PLACEKEEPER_APP_INSTANCE_ID"] = appInstanceID
        process.environment = environment
        process.terminationHandler = { [weak self] _ in
            self?.finish()
            onExit()
        }
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            if bytes.isEmpty { self?.finish(); return }
            self?.consume(bytes)
        }
        do {
            try process.run()
        } catch {
            stdoutPipe.fileHandleForReading.readabilityHandler = nil
            return nil
        }
    }

    @discardableResult
    func request(type: String, fields: [String: Any] = [:], completion: @escaping Completion) -> Bool {
        var message: [String: Any] = [
            "protocolVersion": 1,
            "type": type,
            "appInstanceId": appInstanceID,
        ]
        for (key, value) in fields where message[key] == nil { message[key] = value }
        guard JSONSerialization.isValidJSONObject(message),
              let body = try? JSONSerialization.data(withJSONObject: message),
              !body.isEmpty, body.count <= macosHelperMaxFrameBytes else { return false }
        var length = UInt32(body.count).bigEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }
        frame.append(body)
        lock.lock()
        guard !finished, process.isRunning, pending == nil else { lock.unlock(); return false }
        pending = completion
        do {
            try stdinPipe.fileHandleForWriting.write(contentsOf: frame)
            lock.unlock()
            return true
        } catch {
            pending = nil
            lock.unlock()
            finish()
            return false
        }
    }

    func terminate() {
        lock.lock()
        let shouldTerminate = !finished
        lock.unlock()
        if shouldTerminate {
            try? stdinPipe.fileHandleForWriting.close()
            if process.isRunning { process.terminate() }
        }
        finish()
    }

    private func consume(_ bytes: Data) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        let messages: [[String: Any]]
        do {
            messages = try accumulator.append(bytes)
        } catch {
            lock.unlock()
            terminate()
            return
        }
        guard messages.count <= 1 else { lock.unlock(); terminate(); return }
        guard let message = messages.first else { lock.unlock(); return }
        guard let completion = pending else { lock.unlock(); terminate(); return }
        pending = nil
        let reply = parse(message)
        lock.unlock()
        completion(reply)
        if reply == nil { terminate() }
    }

    private func parse(_ value: [String: Any]) -> AppLifecycleReply? {
        guard value["protocolVersion"] as? Int == 1,
              value["appInstanceId"] as? String == appInstanceID,
              let type = value["type"] as? String else { return nil }
        let base = Set(["protocolVersion", "type", "appInstanceId"])
        if type == "ack" { return Set(value.keys) == base ? .acknowledged : nil }
        if type == "update-required" { return Set(value.keys) == base ? .updateRequired : nil }
        if type == "replacement-ready" {
            guard Set(value.keys) == base.union(["activeWindows"]),
                  let count = value["activeWindows"] as? Int, count >= 0, count <= 64 else { return nil }
            return .replacementReady(activeWindows: count)
        }
        if type == "failure" {
            guard Set(value.keys) == base.union(["code"]), let code = value["code"] as? String,
                  ["invalid", "unregistered", "busy"].contains(code) else { return nil }
            return .failure(code: code)
        }
        return nil
    }

    private func finish() {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let callback = pending
        pending = nil
        lock.unlock()
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        callback?(nil)
    }

    deinit { terminate() }
}
