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
            "SECRET": "no",
        ])
        XCTAssertEqual(environment, [
            "HOME": "/Users/reviewer",
            "PATH": "/usr/bin:/bin",
            "PLACEKEEPER_RUNTIME_ROOT": "/Applications/Placekeeper.app/Contents/Resources",
        ])
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
