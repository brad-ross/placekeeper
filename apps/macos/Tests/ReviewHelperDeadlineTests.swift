@preconcurrency import Foundation

protocol ReviewHelperProcess: AnyObject {
    var windowID: String { get }
    var isRunning: Bool { get }
    func terminate()
}

enum ChildEnvironmentPolicy {
    static func minimal(from source: [String: String]) -> [String: String] { source }
}

@main
private enum ReviewHelperDeadlineTests {
    private static let timeout: TimeInterval = 0.05

    static func main() throws {
        try stalledRequest(type: "refresh", fields: [:])
        try stalledRequest(type: "read-resource", fields: [
            "resourceId": "resource_test1234",
            "generation": 1,
            "role": "document",
            "offset": 0,
            "length": 1024,
        ])
        try idleHelperDoesNotExpire()
        print("ReviewHelperDeadlineTests passed")
    }

    private static func stalledRequest(type: String, fields: [String: Any]) throws {
        let reply = DispatchSemaphore(value: 0)
        let exited = DispatchSemaphore(value: 0)
        var receivedReply = true
        guard let helper = makeHelper(timeout: timeout, onExit: { exited.signal() }) else {
            throw Failure("could not start helper for \(type)")
        }
        guard helper.request(type: type, fields: fields, completion: { value in
            receivedReply = value != nil
            reply.signal()
        }) != nil else {
            throw Failure("could not send \(type) request")
        }
        guard reply.wait(timeout: .now() + 2) == .success else {
            helper.terminate()
            throw Failure("stalled \(type) request did not reach its deadline")
        }
        guard !receivedReply else {
            helper.terminate()
            throw Failure("stalled \(type) request returned a reply")
        }
        guard exited.wait(timeout: .now() + 2) == .success else {
            helper.terminate()
            throw Failure("stalled \(type) request did not terminate the helper")
        }
    }

    private static func idleHelperDoesNotExpire() throws {
        let exited = DispatchSemaphore(value: 0)
        guard let helper = makeHelper(timeout: timeout, onExit: { exited.signal() }) else {
            throw Failure("could not start idle helper")
        }
        guard exited.wait(timeout: .now() + timeout * 3) == .timedOut, helper.isRunning else {
            helper.terminate()
            throw Failure("helper inactivity was treated as a request timeout")
        }
        helper.terminate()
        guard exited.wait(timeout: .now() + 2) == .success else {
            throw Failure("idle helper did not terminate cleanly")
        }
    }

    private static func makeHelper(
        timeout: TimeInterval,
        onExit: @escaping @Sendable () -> Void
    ) -> SupervisedReviewHelper? {
        SupervisedReviewHelper(
            appInstanceID: "app_test1234",
            helperID: "helper_test1234",
            windowID: "window_test1234",
            attemptID: "attempt_test1234",
            executable: URL(fileURLWithPath: "/bin/sh"),
            argumentPrefix: ["-c", "exec sleep 30"],
            baseEnvironment: ProcessInfo.processInfo.environment,
            requestTimeout: timeout,
            onExit: { _, _ in onExit() }
        )
    }

    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
}
