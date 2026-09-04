import Foundation
import XCTest
@testable import PlacekeeperMac

final class MacPoliciesTests: XCTestCase {
    func testVisibleShellRequiresRoutingVisibilityAndSubsequentPaint() {
        var fence = ShellReadinessFence()
        XCTAssertFalse(fence.shellReady(revision: 4))
        XCTAssertFalse(fence.confirmPaint(revision: 4))
        XCTAssertTrue(fence.commitRouting())
        XCTAssertFalse(fence.confirmPaint(revision: 4))
        fence.didOrderVisible()
        XCTAssertFalse(fence.confirmPaint(revision: 3))
        XCTAssertTrue(fence.confirmPaint(revision: 4))
    }

    func testDragRegionsFailClosedAcrossRevisionGeometryAndTransitions() {
        var fence = DragRegionFence(geometryIdentity: "geometry_12345678")
        let valid = DragRegionSet(
            revision: 1,
            geometryIdentity: "geometry_12345678",
            regions: [DragRect(x: 0, y: 0, width: 80, height: 58)]
        )
        XCTAssertTrue(fence.apply(valid))
        XCTAssertFalse(fence.apply(valid))
        XCTAssertTrue(fence.regions.isEmpty)
        XCTAssertFalse(fence.apply(DragRegionSet(revision: 2, geometryIdentity: "geometry_stale", regions: valid.regions)))
        fence.transitionInProgress = true
        XCTAssertFalse(fence.apply(DragRegionSet(revision: 3, geometryIdentity: "geometry_12345678", regions: valid.regions)))
        XCTAssertTrue(fence.regions.isEmpty)
    }

    func testSchemesAndEgressAreClosed() throws {
        XCTAssertEqual(MacSchemePolicy.bundleKey(for: try XCTUnwrap(URL(string: "placekeeper-app://bundle/macos.html"))), "macos.html")
        let resource = MacSchemePolicy.resourceIdentity(for: try XCTUnwrap(URL(string: "placekeeper-resource://document/resource_12345678?generation=2&role=document")))
        XCTAssertEqual(resource?.id, "resource_12345678")
        XCTAssertEqual(resource?.generation, 2)
        for denied in [
            "https://127.0.0.1:43127/review",
            "http://example.com/",
            "placekeeper-app://bundle/../secret",
            "placekeeper-resource://document/resource_12345678?generation=2&role=thumbnail",
        ] {
            XCTAssertFalse(MacSchemePolicy.permitsInWebView(try XCTUnwrap(URL(string: denied))), denied)
        }
    }

    func testChildEnvironmentStripsNodeAndDynamicLoaderInjection() {
        let environment = ChildEnvironmentPolicy.minimal(from: [
            "HOME": "/Users/reviewer",
            "PATH": "/usr/bin:/bin",
            "NODE_OPTIONS": "--require=/tmp/inject.js",
            "NODE_PATH": "/tmp/modules",
            "DYLD_INSERT_LIBRARIES": "/tmp/inject.dylib",
            "LD_PRELOAD": "/tmp/inject.so",
            "PLACEKEEPER_RUNTIME_ROOT": "/Applications/Placekeeper.app/Contents/Resources",
            "PLACEKEEPER_APP_INSTANCE_ID": "app_12345678",
            "PLACEKEEPER_HELPER_ID": "helper_12345678",
            "SECRET": "no",
        ])
        XCTAssertEqual(environment, [
            "HOME": "/Users/reviewer",
            "PATH": "/usr/bin:/bin",
            "PLACEKEEPER_RUNTIME_ROOT": "/Applications/Placekeeper.app/Contents/Resources",
            "PLACEKEEPER_APP_INSTANCE_ID": "app_12345678",
            "PLACEKEEPER_HELPER_ID": "helper_12345678",
        ])
    }

    func testHelperFramesAreIncrementalAndRejectOversizedLengths() throws {
        let body = try JSONSerialization.data(withJSONObject: ["type": "released"])
        var length = UInt32(body.count).bigEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }
        frame.append(body)
        var accumulator = HelperFrameAccumulator()
        XCTAssertTrue(try accumulator.append(frame.prefix(3)).isEmpty)
        let messages = try accumulator.append(frame.dropFirst(3))
        XCTAssertEqual(messages.first?["type"] as? String, "released")

        var oversized = UInt32(macosHelperMaxFrameBytes + 1).bigEndian
        let oversizedFrame = withUnsafeBytes(of: &oversized) { Data($0) }
        XCTAssertThrowsError(try accumulator.append(oversizedFrame)) { error in
            XCTAssertEqual(error as? HelperFrameError, .oversized)
        }
    }

    func testHelperReplyParserBindsEnvelopeAndAdmissionDescriptor() {
        let projection: [String: Any] = [
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "generation": 1,
            "revision": 0,
            "state": ["schemaVersion": 2],
            "scope": ["documentTitle": "Paper.pdf", "launchSurface": "macos"],
            "saveStatus": ["destination": ["phase": "none", "generation": 0]],
            "protected": false,
            "document": ["sha256": String(repeating: "a", count: 64), "byteLength": 995, "generation": 1],
        ]
        let admitted: [String: Any] = [
            "protocolVersion": 1,
            "windowId": "window_12345678",
            "attemptId": "attempt_12345678",
            "requestId": "request_12345678",
            "type": "admitted",
            "provisionalId": "claim_12345678",
            "resourceId": "resource_12345678",
            "generation": 1,
            "byteLength": 995,
            "digest": String(repeating: "a", count: 64),
            "displayName": "Paper.pdf",
            "projection": projection,
        ]
        guard case let .admitted(value)? = MacReviewHelperReplyParser.parse(
            admitted,
            windowID: "window_12345678",
            attemptID: "attempt_12345678",
            requestID: "request_12345678"
        ) else { return XCTFail("expected an admitted reply") }
        XCTAssertEqual(value.resourceID, "resource_12345678")
        XCTAssertEqual(value.projection.sessionID, "11111111-1111-4111-8111-111111111111")
        XCTAssertNil(MacReviewHelperReplyParser.parse(
            admitted.merging(["attemptId": "attempt_other123"]) { _, new in new },
            windowID: "window_12345678",
            attemptID: "attempt_12345678",
            requestID: "request_12345678"
        ))
    }

    func testPageRuntimeRequestRequiresClosedCurrentIdentity() {
        let bootstrap: [String: Any] = [
            "protocol": "placekeeper.review-runtime",
            "version": 1,
            "kind": "request",
            "runtimeId": "runtime_12345678",
            "requestId": "request_12345678",
            "method": "bootstrap",
            "payload": [String: Any](),
        ]
        XCTAssertEqual(
            MacPageRuntimeRequest.parse(bootstrap, runtimeID: "runtime_12345678")?.method,
            "bootstrap"
        )
        XCTAssertNil(MacPageRuntimeRequest.parse(
            bootstrap.merging(["sourcePath": "/private/paper.pdf"]) { _, new in new },
            runtimeID: "runtime_12345678"
        ))

        let scoped: [String: Any] = [
            "protocol": "placekeeper.review-runtime",
            "version": 1,
            "kind": "request",
            "runtimeId": "runtime_12345678",
            "requestId": "request_abcdefgh",
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "generation": 2,
            "revision": 4,
            "method": "scope",
            "payload": [String: Any](),
        ]
        let parsed = MacPageRuntimeRequest.parse(scoped, runtimeID: "runtime_12345678")
        XCTAssertEqual(parsed?.generation, 2)
        XCTAssertEqual(parsed?.revision, 4)
        XCTAssertNil(MacPageRuntimeRequest.parse(
            scoped.merging(["runtimeId": "runtime_wrong123"]) { _, new in new },
            runtimeID: "runtime_12345678"
        ))
    }

    func testHelperLossIsWindowScopedAndLastCloseLeavesNone() {
        let first = FakeHelper(windowID: "window_first")
        let second = FakeHelper(windowID: "window_second")
        let supervisor = ReviewHelperSupervisor()
        XCTAssertTrue(supervisor.attach(first))
        XCTAssertTrue(supervisor.attach(second))
        supervisor.helperDied(windowID: first.windowID)
        XCTAssertEqual(supervisor.activeWindowIDs, [second.windowID])
        supervisor.close(windowID: second.windowID)
        XCTAssertTrue(supervisor.activeWindowIDs.isEmpty)
        XCTAssertTrue(second.terminated)
    }

    func testLifecycleEOFAndParentDeathDetachRegistration() {
        for reason in [LifecycleDetachReason.eof, .parentDeath, .controlledExit] {
            var lane = AppLifecycleLane()
            XCTAssertTrue(lane.register(processID: 42, startIdentity: "start_12345678", buildIdentity: "build_12345678"))
            XCTAssertTrue(lane.noteWindow("window_12345678", active: true))
            lane.detach(reason)
            XCTAssertFalse(lane.registered)
            XCTAssertTrue(lane.activeWindows.isEmpty)
            XCTAssertEqual(lane.detachReason, reason)
        }
    }

    func testGenerationBoundResourceAndCatastrophicSurface() {
        var vault = ResourceVault()
        XCTAssertTrue(vault.install(.init(id: "resource_12345678", generation: 1, bytes: Data("%PDF-1.7".utf8))))
        XCTAssertNotNil(vault.read(id: "resource_12345678", generation: 1))
        XCTAssertNil(vault.read(id: "resource_12345678", generation: 2))
        vault.invalidate()
        XCTAssertNil(vault.read(id: "resource_12345678", generation: 1))
        XCTAssertEqual(CatastrophicAction.allCases.map(\.rawValue), ["Retry", "Diagnostics", "Close"])
    }
}

private final class FakeHelper: ReviewHelperProcess {
    let windowID: String
    var isRunning = true
    var terminated = false

    init(windowID: String) { self.windowID = windowID }

    func terminate() {
        isRunning = false
        terminated = true
    }
}
