import XCTest
@testable import PlacekeeperMac

private final class RefreshTestHelper: ReviewHelperRequesting {
    var requests: [(String, [String: Any], (MacReviewHelperReply?) -> Void)] = []

    func request(
        type: String,
        fields: [String: Any],
        completion: @escaping (MacReviewHelperReply?) -> Void
    ) -> String? {
        requests.append((type, fields, completion))
        return "request_refresh_test"
    }
}

final class ReviewRefreshTests: XCTestCase {
    @MainActor
    func testKeepaliveInstallsSuccessorBeforePublishingInvalidationAndAllowsOnlyOneRequest() async {
        func projection(_ generation: Int) -> MacRuntimeProjection {
            .init(
                sessionID: "11111111-1111-4111-8111-111111111111", generation: generation,
                revision: generation - 1, state: [:], scope: [:], saveStatus: [:], protected: false,
                location: nil, documentDigest: String(repeating: String(generation), count: 64),
                documentByteLength: 100 + generation
            )
        }
        let helper = RefreshTestHelper()
        let first = projection(1)
        let admission = MacReviewAdmission(
            provisionalID: "provisional_test", resourceID: "resource_test1234", generation: 1,
            byteLength: first.documentByteLength, digest: first.documentDigest,
            displayName: "Paper.pdf", projection: first
        )
        let bridge = ReviewBridge(
            runtimeID: "runtime_test1234", attemptID: "attempt_test1234",
            helper: helper, admission: admission
        )
        bridge.activate(generation: 1) { _ in }
        helper.requests.removeFirst().2(.active(first))
        await Task.yield()

        var installed = false
        var events: [[String: Any]] = []
        bridge.successorInstaller = { successor, completion in
            XCTAssertEqual(successor.generation, 2)
            installed = true
            completion(true)
        }
        bridge.keepalive(send: { events.append($0) })
        bridge.keepalive(send: { events.append($0) })
        XCTAssertEqual(helper.requests.count, 1, "Only one keepalive may be in flight")
        helper.requests.removeFirst().2(.invalidation(generation: 2, revision: 1, reason: "generation"))
        await Task.yield()
        XCTAssertEqual(helper.requests.first?.0, "refresh")
        helper.requests.removeFirst().2(.refreshed(projection(2)))
        await Task.yield()

        XCTAssertTrue(installed)
        XCTAssertEqual(bridge.projection.generation, 2)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual((events[0]["payload"] as? [String: Any])?["generation"] as? Int, 2)
        XCTAssertEqual(bridge.documentResourceURL,
            "placekeeper-resource://document/resource_test1234?generation=2&role=document")
    }

    @MainActor
    func testRejectedSuccessorInstallationKeepsPredecessorCurrent() async {
        let digest = String(repeating: "a", count: 64)
        let first = MacRuntimeProjection(
            sessionID: "11111111-1111-4111-8111-111111111111", generation: 1, revision: 0,
            state: [:], scope: [:], saveStatus: [:], protected: false, location: nil,
            documentDigest: digest, documentByteLength: 100
        )
        let next = MacRuntimeProjection(
            sessionID: first.sessionID, generation: 2, revision: 0,
            state: [:], scope: [:], saveStatus: [:], protected: false, location: nil,
            documentDigest: String(repeating: "b", count: 64), documentByteLength: 101
        )
        let helper = RefreshTestHelper()
        let bridge = ReviewBridge(
            runtimeID: "runtime_test1234", attemptID: "attempt_test1234", helper: helper,
            admission: .init(provisionalID: "provisional_test", resourceID: "resource_test1234",
                generation: 1, byteLength: 100, digest: digest, displayName: "Paper.pdf", projection: first)
        )
        bridge.activate(generation: 1) { _ in }
        helper.requests.removeFirst().2(.active(first))
        await Task.yield()
        bridge.successorInstaller = { _, completion in completion(false) }
        var events: [[String: Any]] = []
        bridge.keepalive(send: { events.append($0) })
        helper.requests.removeFirst().2(.invalidation(generation: 2, revision: 0, reason: "generation"))
        await Task.yield()
        helper.requests.removeFirst().2(.refreshed(next))
        await Task.yield()
        XCTAssertEqual(bridge.projection.generation, 1)
        XCTAssertTrue(events.isEmpty)
    }

    @MainActor
    func testOversizedRefreshKeepsProjectionAndReportsRecoverableBudgetFailure() async {
        let first = MacRuntimeProjection(
            sessionID: "11111111-1111-4111-8111-111111111111", generation: 1, revision: 0,
            state: [:], scope: [:], saveStatus: [:], protected: false, location: nil,
            documentDigest: String(repeating: "a", count: 64), documentByteLength: 100
        )
        let helper = RefreshTestHelper()
        let bridge = ReviewBridge(
            runtimeID: "runtime_test1234", attemptID: "attempt_test1234", helper: helper,
            admission: .init(provisionalID: "provisional_test", resourceID: "resource_test1234",
                generation: 1, byteLength: 100, digest: first.documentDigest,
                displayName: "Paper.pdf", projection: first)
        )
        bridge.activate(generation: 1) { _ in }
        helper.requests.removeFirst().2(.active(first))
        await Task.yield()
        var budgetFailures = 0
        bridge.onRefreshBudgetExceeded = { budgetFailures += 1 }
        var succeeded = true

        bridge.keepalive(send: { _ in }, completion: { succeeded = $0 })
        helper.requests.removeFirst().2(.failure(code: "budget"))
        await Task.yield()

        XCTAssertFalse(succeeded)
        XCTAssertEqual(budgetFailures, 1)
        XCTAssertEqual(bridge.projection.generation, 1)
        XCTAssertEqual(bridge.projection.revision, 0)

        bridge.keepalive(send: { _ in })
        helper.requests.removeFirst().2(.failure(code: "budget"))
        await Task.yield()
        XCTAssertEqual(budgetFailures, 1, "Timer ticks must not reopen a dismissed budget alert")

        bridge.retryRefreshAfterBudgetFailure(send: { _ in })
        helper.requests.removeFirst().2(.failure(code: "budget"))
        await Task.yield()
        XCTAssertEqual(budgetFailures, 2, "An explicit retry may report the persistent failure again")

        bridge.retryRefreshAfterBudgetFailure(send: { _ in })
        helper.requests.removeFirst().2(.refreshed(first))
        await Task.yield()
        bridge.keepalive(send: { _ in })
        helper.requests.removeFirst().2(.failure(code: "budget"))
        await Task.yield()
        XCTAssertEqual(budgetFailures, 3, "A successful refresh clears the latch for a later failure")
    }

    @MainActor
    func testConsecutiveRefreshesSerializeInstallationAndRejectRollback() async {
        func projection(_ generation: Int) -> MacRuntimeProjection {
            .init(sessionID: "11111111-1111-4111-8111-111111111111", generation: generation,
                revision: generation, state: [:], scope: [:], saveStatus: [:], protected: false,
                location: nil, documentDigest: String(repeating: generation == 1 ? "a" : generation == 2 ? "b" : "c", count: 64),
                documentByteLength: 100 + generation)
        }
        let helper = RefreshTestHelper()
        let first = projection(1)
        let bridge = ReviewBridge(runtimeID: "runtime_test1234", attemptID: "attempt_test1234", helper: helper,
            admission: .init(provisionalID: "provisional_test", resourceID: "resource_test1234",
                generation: 1, byteLength: first.documentByteLength, digest: first.documentDigest,
                displayName: "Paper.pdf", projection: first))
        bridge.activate(generation: 1) { _ in }
        helper.requests.removeFirst().2(.active(first))
        await Task.yield()
        var installations: [(Int, (Bool) -> Void)] = []
        bridge.successorInstaller = { next, completion in installations.append((next.generation, completion)) }
        var generations: [Int] = []
        let send: ([String: Any]) -> Void = { message in
            generations.append((message["payload"] as? [String: Any])?["generation"] as? Int ?? -1)
        }
        bridge.keepalive(send: send)
        bridge.keepalive(send: send)
        XCTAssertEqual(helper.requests.count, 1)
        helper.requests.removeFirst().2(.invalidation(generation: 2, revision: 2, reason: "generation"))
        await Task.yield()
        helper.requests.removeFirst().2(.refreshed(projection(2)))
        await Task.yield()
        XCTAssertEqual(installations.map(\.0), [2])
        XCTAssertTrue(helper.requests.isEmpty, "Coalesced refresh waits for resource installation")
        installations.removeFirst().1(true)
        await Task.yield()
        XCTAssertEqual(generations, [2])
        XCTAssertEqual(helper.requests.first?.0, "refresh")
        helper.requests.removeFirst().2(.refreshed(projection(3)))
        await Task.yield()
        XCTAssertEqual(installations.map(\.0), [3])
        installations.removeFirst().1(true)
        await Task.yield()
        XCTAssertEqual(generations, [2, 3])
        XCTAssertEqual(bridge.projection.generation, 3)

        bridge.keepalive(send: send)
        helper.requests.removeFirst().2(.refreshed(projection(2)))
        await Task.yield()
        XCTAssertEqual(bridge.projection.generation, 3)
        XCTAssertEqual(generations, [2, 3])
    }
}
