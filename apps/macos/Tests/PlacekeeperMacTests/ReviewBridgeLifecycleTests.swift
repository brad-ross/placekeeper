import XCTest
@testable import PlacekeeperMac

private final class LifecycleTestHelper: ReviewHelperRequesting {
    var requests: [(String, [String: Any], (MacReviewHelperReply?) -> Void)] = []

    func request(
        type: String,
        fields: [String: Any],
        completion: @escaping (MacReviewHelperReply?) -> Void
    ) -> String? {
        requests.append((type, fields, completion))
        return "request_lifecycle_test"
    }
}

final class ReviewBridgeLifecycleTests: XCTestCase {
    @MainActor
    func testEqualRevisionLifecycleChangePublishesFreshnessWithoutInstallingDocument() async {
        let initial = projection(freshness: "current", savePhase: "not-saved")
        let refreshed = projection(freshness: "possibly-stale", savePhase: "saving")
        let (bridge, helper) = await activatedBridge(initial: initial)
        var installedGenerations: [Int] = []
        bridge.successorInstaller = { next, completion in
            installedGenerations.append(next.generation)
            completion(true)
        }
        var events: [[String: Any]] = []

        bridge.keepalive(send: { events.append($0) })
        helper.requests.removeFirst().2(.refreshed(refreshed))
        await Task.yield()

        XCTAssertEqual(bridge.projection.state["workflow"] as? [String: String], ["freshness": "possibly-stale"])
        XCTAssertEqual((bridge.projection.saveStatus["sync"] as? [String: String])?["phase"], "saving")
        XCTAssertTrue(installedGenerations.isEmpty, "Equal-generation lifecycle refreshes reuse the installed document")
        XCTAssertEqual(events.count, 1)
        let payload = events.first?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["generation"] as? Int, 2)
        XCTAssertEqual(payload?["revision"] as? Int, 7)
        XCTAssertEqual(payload?["reason"] as? String, "freshness")
    }

    @MainActor
    func testIdenticalEqualRevisionProjectionDoesNotPublishOrInstall() async {
        let initial = projection(freshness: "current", savePhase: "not-saved")
        let (bridge, helper) = await activatedBridge(initial: initial)
        var installationCount = 0
        bridge.successorInstaller = { _, completion in
            installationCount += 1
            completion(true)
        }
        var events: [[String: Any]] = []
        var succeeded = false

        bridge.keepalive(send: { events.append($0) }, completion: { succeeded = $0 })
        helper.requests.removeFirst().2(.refreshed(initial))
        await Task.yield()

        XCTAssertTrue(succeeded)
        XCTAssertEqual(installationCount, 0)
        XCTAssertTrue(events.isEmpty)
    }

    @MainActor
    func testLifecycleDifferenceCannotBypassRevisionOrGenerationRegressionFence() async {
        let initial = projection(freshness: "current", savePhase: "not-saved")
        let (bridge, helper) = await activatedBridge(initial: initial)
        var events: [[String: Any]] = []

        bridge.keepalive(send: { events.append($0) })
        helper.requests.removeFirst().2(.refreshed(projection(
            generation: 2, revision: 6, freshness: "possibly-stale", savePhase: "saving"
        )))
        await Task.yield()

        bridge.keepalive(send: { events.append($0) })
        helper.requests.removeFirst().2(.refreshed(projection(
            generation: 1, revision: 99, freshness: "possibly-stale", savePhase: "saving"
        )))
        await Task.yield()

        XCTAssertEqual(bridge.projection.generation, 2)
        XCTAssertEqual(bridge.projection.revision, 7)
        XCTAssertEqual((bridge.projection.state["workflow"] as? [String: String])?["freshness"], "current")
        XCTAssertTrue(events.isEmpty)
    }

    @MainActor
    private func activatedBridge(initial: MacRuntimeProjection) async -> (ReviewBridge, LifecycleTestHelper) {
        let helper = LifecycleTestHelper()
        let bridge = ReviewBridge(
            runtimeID: "runtime_test1234",
            attemptID: "attempt_test1234",
            helper: helper,
            admission: .init(
                provisionalID: "provisional_test",
                resourceID: "resource_test1234",
                generation: initial.generation,
                byteLength: initial.documentByteLength,
                digest: initial.documentDigest,
                displayName: "Paper.pdf",
                projection: initial
            )
        )
        bridge.activate(generation: initial.generation) { _ in }
        helper.requests.removeFirst().2(.active(initial))
        await Task.yield()
        return (bridge, helper)
    }

    private func projection(
        generation: Int = 2,
        revision: Int = 7,
        freshness: String,
        savePhase: String
    ) -> MacRuntimeProjection {
        .init(
            sessionID: "11111111-1111-4111-8111-111111111111",
            generation: generation,
            revision: revision,
            state: ["workflow": ["freshness": freshness]],
            scope: ["kind": "local"],
            saveStatus: ["sync": ["phase": savePhase]],
            protected: false,
            location: ["pageIndex": 3],
            documentDigest: String(repeating: generation == 2 ? "b" : "a", count: 64),
            documentByteLength: 200 + generation
        )
    }
}
