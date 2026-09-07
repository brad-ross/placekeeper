import Foundation
import XCTest
@testable import PlacekeeperMac

final class MacPoliciesTests: XCTestCase {
    func testRecoveryChoiceRequiresBundledMainFrameAndSettlesOnlyOnce() {
        let source = URL(fileURLWithPath: "/app/MacWeb/recovery.html")
        for decision in ["resume", "discard", "fork"] {
            var gate = RecoveryDecisionGate()
            XCTAssertNil(gate.accept(["decision": decision], isMainFrame: false, source: source, expectedSource: source))
            XCTAssertNil(gate.accept(["decision": decision], isMainFrame: true, source: URL(string: "https://example.com"), expectedSource: source))
            XCTAssertNil(gate.accept(["decision": decision, "extra": true], isMainFrame: true, source: source, expectedSource: source))
            XCTAssertNil(gate.accept(["decision": "other"], isMainFrame: true, source: source, expectedSource: source))
            XCTAssertEqual(gate.accept(["decision": decision], isMainFrame: true, source: source, expectedSource: source), decision)
            XCTAssertNil(gate.accept(["decision": decision], isMainFrame: true, source: source, expectedSource: source))
        }
        var failed = RecoveryDecisionGate()
        failed.fail()
        XCTAssertNil(failed.accept(["decision": "resume"], isMainFrame: true, source: source, expectedSource: source))
    }

    func testVisibleShellRequiresRoutingVisibilityAndSubsequentPaint() {
        var fence = ShellReadinessFence()
        XCTAssertFalse(fence.shellReady(revision: 4))
        XCTAssertFalse(fence.confirmPaint(revision: 4))
        XCTAssertTrue(fence.commitRouting())
        XCTAssertFalse(fence.commitRouting())
        XCTAssertFalse(fence.confirmPaint(revision: 4))
        fence.didOrderVisible()
        XCTAssertFalse(fence.confirmPaint(revision: 3))
        XCTAssertTrue(fence.confirmPaint(revision: 7))
        XCTAssertEqual(fence.visibleShellRevision, 7)
    }

    func testInitialRoutingCommitPreservesRestoredWindowPlacement() {
        XCTAssertTrue(InitialWindowPlacementPolicy.shouldCenter(hasRestoredFrame: false))
        XCTAssertFalse(InitialWindowPlacementPolicy.shouldCenter(hasRestoredFrame: true))
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

    func testDragRegionRevisionRestartsAfterGeometryIdentityRollover() {
        let regions = [DragRect(x: 0, y: 0, width: 80, height: 58)]
        var fence = DragRegionFence(geometryIdentity: "geometry_original")
        XCTAssertTrue(fence.apply(.init(revision: 7, geometryIdentity: "geometry_original", regions: regions)))

        fence.transitionInProgress = true
        fence.rolloverGeometryIdentity(to: "geometry_replacement")

        XCTAssertEqual(fence.currentRevision, -1)
        XCTAssertTrue(fence.regions.isEmpty)
        XCTAssertFalse(fence.transitionInProgress)
        XCTAssertTrue(fence.apply(.init(revision: 7, geometryIdentity: "geometry_replacement", regions: regions)))
    }

    func testPageBridgeRejectsDiagnosticInjectionCanaries() {
        let canaries = [
            "shell-ready\n[PlacekeeperMac] runtime-activated",
            "runtime-error\u{7f}/Users/reviewer/private.pdf",
            "review text that must never reach stderr",
        ]
        for canary in canaries {
            XCTAssertNil(MacPageBridgeMessageType.parse([
                "protocolVersion": macShellProtocolVersion,
                "type": canary,
            ]))
            XCTAssertNil(MacRuntimeErrorStage(rawValue: canary))
            XCTAssertFalse(MacPageBridgeDiagnosticEvent.allFixedNames.contains(canary))
        }
    }

    func testPackagedReviewAssetsRequireExpectedExecutableSignatures() throws {
        var pdfium = Data([0x00, 0x61, 0x73, 0x6d])
        pdfium.append(Data(repeating: 0, count: 8))
        let worker = Data("class PdfiumEngineRunner {}\nif (type === \"wasmInit\") {}".utf8)
        let assets = try XCTUnwrap(PackagedReviewAssets.validate(pdfium: pdfium, worker: worker))
        XCTAssertEqual(assets.pdfium, pdfium)
        XCTAssertEqual(assets.worker, worker)
        XCTAssertNil(PackagedReviewAssets.validate(pdfium: Data("not wasm".utf8), worker: worker))
        XCTAssertNil(PackagedReviewAssets.validate(pdfium: pdfium, worker: Data("postMessage(1)".utf8)))
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

    func testPackagedHelperEnvironmentParsesIdentityAndOverridesAmbientReleaseValues() throws {
        let identity = try XCTUnwrap(PackagedHelperEnvironmentPolicy.parseBuildIdentity(Data("""
        {"managementProtocolVersion":1,"daemonIdentity":"\(String(repeating: "a", count: 64))","installArtifactIdentity":"\(String(repeating: "b", count: 64))"}
        """.utf8)))
        let resources = URL(fileURLWithPath: "/Applications/Placekeeper.app/Contents/Resources")
        let environment = PackagedHelperEnvironmentPolicy.merging(
            source: [
                "HOME": "/Users/reviewer",
                "PLACEKEEPER_DAEMON_IDENTITY": String(repeating: "c", count: 64),
                "PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY": String(repeating: "d", count: 64),
                "PLACEKEEPER_PDFIUM_WASM": "/tmp/ambient.wasm",
            ],
            resources: resources,
            identity: identity,
            allowDevelopmentOverrides: false
        )
        XCTAssertEqual(environment["PLACEKEEPER_RUNTIME_ROOT"], resources.path)
        XCTAssertEqual(environment["PLACEKEEPER_DAEMON_IDENTITY"], String(repeating: "a", count: 64))
        XCTAssertEqual(environment["PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY"], String(repeating: "b", count: 64))
        XCTAssertEqual(environment["PLACEKEEPER_PDFIUM_WASM"], resources.appendingPathComponent("pdfium/pdfium.wasm").path)
    }

    func testPackagedHelperEnvironmentRejectsOpenOrMalformedIdentityAndKeepsDebugOverrides() throws {
        let digest = String(repeating: "a", count: 64)
        XCTAssertNil(PackagedHelperEnvironmentPolicy.parseBuildIdentity(Data("""
        {"managementProtocolVersion":1,"daemonIdentity":"\(digest)","installArtifactIdentity":"\(digest)","extra":true}
        """.utf8)))
        let identity = try XCTUnwrap(PackagedHelperEnvironmentPolicy.parseBuildIdentity(Data("""
        {"managementProtocolVersion":1,"daemonIdentity":"\(digest)","installArtifactIdentity":"\(digest)"}
        """.utf8)))
        let environment = PackagedHelperEnvironmentPolicy.merging(
            source: [
                "PLACEKEEPER_DAEMON_IDENTITY": "development",
                "PLACEKEEPER_PDFIUM_WASM": "/tmp/debug.wasm",
            ],
            resources: URL(fileURLWithPath: "/Applications/Placekeeper.app/Contents/Resources"),
            identity: identity,
            allowDevelopmentOverrides: true
        )
        XCTAssertEqual(environment["PLACEKEEPER_DAEMON_IDENTITY"], "development")
        XCTAssertEqual(environment["PLACEKEEPER_PDFIUM_WASM"], "/tmp/debug.wasm")
        XCTAssertEqual(environment["PLACEKEEPER_INSTALL_ARTIFACT_IDENTITY"], digest)
    }

    func testReleaseSelectionRejectsAmbientDevelopmentPaths() {
        let source = [
            "PLACEKEEPER_MAC_REVIEW_HELPER": "/tmp/helper",
            "PLACEKEEPER_MAC_NODE": "/tmp/node",
            "PLACEKEEPER_MAC_SERVICE_ENTRY": "/tmp/service.js",
            "PLACEKEEPER_MAC_WEB_ROOT": "/tmp/web",
        ]
        for key in source.keys {
            XCTAssertNil(PackagedHelperEnvironmentPolicy.developmentOverride(
                named: key,
                in: source,
                allowed: false
            ))
            XCTAssertEqual(PackagedHelperEnvironmentPolicy.developmentOverride(
                named: key,
                in: source,
                allowed: true
            ), source[key])
        }
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

    func testRecoveryOfferParserKeepsTheServiceOfferExact() {
        let response: [String: Any] = [
            "protocolVersion": 1,
            "windowId": "window_12345678",
            "attemptId": "attempt_12345678",
            "requestId": "request_12345678",
            "type": "recovery-offered",
            "choices": ["resume", "discard", "fork"],
            "offer": [
                "id": "recovery_operation_12345678",
                "expiresAt": "2026-09-05T12:00:00.000Z",
            ],
        ]
        guard case let .recoveryOffered(id, expiresAt)? = MacReviewHelperReplyParser.parse(
            response,
            windowID: "window_12345678",
            attemptID: "attempt_12345678",
            requestID: "request_12345678"
        ) else { return XCTFail("expected a recovery offer") }
        XCTAssertEqual(id, "recovery_operation_12345678")
        XCTAssertEqual(expiresAt, "2026-09-05T12:00:00.000Z")
        for expiry in ["2026-09-05T12:00:00.123Z", "2026-09-05T12:00:00Z", "invalid"] {
            var variant = response
            variant["offer"] = ["id": id, "expiresAt": expiry]
            let parsed = MacReviewHelperReplyParser.parse(
                variant, windowID: "window_12345678", attemptID: "attempt_12345678",
                requestID: "request_12345678"
            )
            if expiry == "invalid" { XCTAssertNil(parsed) }
            else if case let .recoveryOffered(_, value)? = parsed { XCTAssertEqual(value, expiry) }
            else { XCTFail("expected a recovery offer for \(expiry)") }
        }
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

    func testHelperDetachLedgerIssuesEachHelperIdentityOnce() {
        var ledger = HelperDetachLedger()
        XCTAssertTrue(ledger.register(windowID: "window_12345678", helperID: "helper_12345678"))
        XCTAssertFalse(ledger.register(windowID: "window_12345678", helperID: "helper_other_1234"))
        XCTAssertEqual(ledger.takeHelperID(windowID: "window_12345678"), "helper_12345678")
        XCTAssertNil(ledger.takeHelperID(windowID: "window_12345678"))
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

    func testLaunchCoordinatorQueuesBatchesAndSerializesTheSameSource() throws {
        let first = try XCTUnwrap(NativeOpenIntent.parse(URL(fileURLWithPath: "/tmp/First.pdf")))
        let second = try XCTUnwrap(NativeOpenIntent.parse(URL(fileURLWithPath: "/tmp/Second.pdf")))
        var coordinator = LaunchCoordinator()
        XCTAssertTrue(coordinator.enqueue([first, second, first]).isEmpty)
        XCTAssertEqual(coordinator.pending, [first, second])
        XCTAssertEqual(coordinator.markReady(), [first, second])
        XCTAssertEqual(coordinator.inFlightCount, 2)

        let laterLink = try XCTUnwrap(NativeOpenIntent.parse(URL(
            string: "placekeeper:///tmp/First.pdf#v=1&page=7"
        )))
        XCTAssertTrue(coordinator.enqueue([laterLink]).isEmpty)
        XCTAssertEqual(coordinator.finish(first), [laterLink])
        XCTAssertEqual(coordinator.inFlightCount, 2)
    }

    func testNativeLinkHintIsBoundedWhileServiceRetainsFinalAuthority() throws {
        let link = try XCTUnwrap(NativeOpenIntent.parse(URL(
            string: "placekeeper:///tmp/Paper%20One.pdf#v=1&page=3"
        )))
        XCTAssertEqual(link.sourceURL.path, "/tmp/Paper One.pdf")
        guard case let .placekeeperLink(raw) = link.kind else { return XCTFail("expected a link intent") }
        XCTAssertEqual(raw, "placekeeper:///tmp/Paper%20One.pdf#v=1&page=3")
        XCTAssertNil(NativeOpenIntent.parse(URL(
            string: "placekeeper://example.com/tmp/Paper.pdf#v=1&page=3"
        )!))
        XCTAssertNil(NativeOpenIntent.parse(URL(
            string: "placekeeper:///tmp/Paper.pdf?session=secret#v=1&page=3"
        )!))
    }

    func testDocumentRegistryUsesServiceApprovedReviewIdentityAndMostRecentWindow() {
        var registry = DocumentWindowRegistry()
        let reviewID = "779e1d9d-58c1-4b12-8dc2-3449dad132c1"
        XCTAssertTrue(registry.register(
            windowID: "window_first",
            canonicalReviewID: reviewID,
            documentDigest: String(repeating: "a", count: 64)
        ))
        XCTAssertTrue(registry.register(
            windowID: "window_second",
            canonicalReviewID: reviewID,
            documentDigest: String(repeating: "a", count: 64)
        ))
        XCTAssertEqual(registry.matchingWindow(canonicalReviewID: reviewID), "window_second")
        registry.noteKey(windowID: "window_first")
        XCTAssertEqual(registry.matchingWindow(canonicalReviewID: reviewID), "window_first")
        registry.remove(windowID: "window_first")
        XCTAssertEqual(registry.matchingWindow(canonicalReviewID: reviewID), "window_second")
    }

    func testRestorationKeepsOnlyOrdinaryDocumentPresentationState() throws {
        let frame = NSStringFromRect(NSRect(x: 20, y: 30, width: 1200, height: 820))
        let record = try XCTUnwrap(RestorableDocumentWindow.parse([
            "sourcePath": "/Users/reviewer/Paper.pdf",
            "frame": frame,
            "page": 3,
            "zoom": 1.25,
        ]))
        XCTAssertEqual(record.sourceURL.path, "/Users/reviewer/Paper.pdf")
        XCTAssertNil(RestorableDocumentWindow.parse([
            "sourcePath": "/Users/reviewer/Paper.pdf",
            "frame": frame,
            "sessionId": "779e1d9d-58c1-4b12-8dc2-3449dad132c1",
        ]))
        XCTAssertNil(RestorableDocumentWindow.parse([
            "sourcePath": "/Users/reviewer/Paper.pdf",
            "frame": frame,
            "presentationLease": "secret",
        ]))

        let suiteName = "PlacekeeperMacTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = WindowRestorationStore(defaults: defaults)
        store.save([record])
        XCTAssertEqual(store.load(), [record])
    }

    func testCommandSnapshotIsClosedCompleteAndNonAuthorizing() throws {
        let commands = MacReviewCommand.allCases.map { command in
            [
                "id": command.rawValue,
                "label": command == .undo ? "Undo Review Change" : command.rawValue,
                "enabled": command != .redo,
            ] as [String: Any]
        }
        let value: [String: Any] = [
            "protocolVersion": 1,
            "type": "command-snapshot",
            "runtimeId": "runtime_12345678",
            "attemptId": "attempt_12345678",
            "revision": 4,
            "focusContext": "review",
            "commands": commands,
        ]
        let snapshot = try XCTUnwrap(MacCommandSnapshot.parse(value))
        XCTAssertEqual(snapshot.revision, 4)
        XCTAssertTrue(snapshot.commands[.undo]?.enabled == true)
        XCTAssertTrue(snapshot.commands[.redo]?.enabled == false)
        XCTAssertNil(MacCommandSnapshot.parse(
            value.merging(["presentationLease": "secret"]) { _, new in new }
        ))
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

private final class BridgeTestHelper: ReviewHelperRequesting {
    var requests: [(type: String, fields: [String: Any], completion: (MacReviewHelperReply?) -> Void)] = []
    func request(type: String, fields: [String: Any], completion: @escaping (MacReviewHelperReply?) -> Void) -> String? {
        requests.append((type, fields, completion))
        return "request_test1234"
    }
}

extension MacPoliciesTests {
    @MainActor
    func testBridgeAllowsCommittedRevisionWhileRefreshIsPending() async {
        func projection(_ revision: Int) -> MacRuntimeProjection {
            .init(sessionID: "11111111-1111-4111-8111-111111111111", generation: 1,
                  revision: revision, state: [:], scope: [:], saveStatus: [:], protected: false,
                  location: nil, documentDigest: String(repeating: "a", count: 64), documentByteLength: 100)
        }
        let helper = BridgeTestHelper()
        let admission = MacReviewAdmission(provisionalID: "provisional_test", resourceID: "resource_test1234",
            generation: 1, byteLength: 100, digest: String(repeating: "a", count: 64),
            displayName: "Paper.pdf", projection: projection(0))
        let bridge = ReviewBridge(runtimeID: "runtime_test1234", attemptID: "attempt_test1234", helper: helper, admission: admission)
        bridge.activate(generation: 1) { _ in }
        helper.requests.removeFirst().completion(.active(projection(0)))
        await Task.yield()
        func request(_ method: String, revision: Int) -> [String: Any] {
            ["protocol": "placekeeper.review-runtime", "version": 1, "kind": "request",
             "runtimeId": "runtime_test1234", "requestId": "request_" + method,
             "sessionId": projection(0).sessionID, "generation": 1, "revision": revision,
             "method": method, "payload": [String: Any]()]
        }
        var responses: [[String: Any]] = []
        bridge.handle(request("command", revision: 0)) { message in
            responses.append(message)
            if message["kind"] as? String == "response", message["ok"] as? Bool == true {
                // The web runtime immediately asks for status at the returned revision.
                bridge.handle(request("saveStatus", revision: 1)) { responses.append($0) }
            }
        }
        XCTAssertEqual(helper.requests.first?.type, "invoke")
        helper.requests.removeFirst().completion(.result(method: "command", payload: ["revision": 1]))
        await Task.yield()
        // Even while the cached native projection is old, the follow-up uses
        // the committed revision and must reach the authoritative helper.
        XCTAssertEqual(bridge.projection.revision, 0)
        XCTAssertEqual(helper.requests.first?.fields["method"] as? String, "saveStatus")
        XCTAssertEqual(helper.requests.first?.fields["revision"] as? Int, 1)
        guard helper.requests.first?.type == "invoke" else { XCTFail("Missing immediate status request"); return }
        helper.requests.removeFirst().completion(.result(method: "saveStatus", payload: [:]))
        await Task.yield()
        XCTAssertTrue(responses.contains { $0["method"] as? String == "saveStatus" && $0["ok"] as? Bool == true })
        XCTAssertEqual(helper.requests.first?.type, "refresh")
        helper.requests.removeFirst().completion(.failure(code: "unavailable"))
        await Task.yield()

        // A transient refresh failure must not turn a committed save into a
        // rejection or prevent the next mutation (including delete/undo).
        var nextResponse: [String: Any] = [:]
        bridge.handle(request("command", revision: 1)) { nextResponse = $0 }
        XCTAssertEqual(helper.requests.first?.fields["revision"] as? Int, 1)
        guard helper.requests.first?.type == "invoke" else { XCTFail("Missing next mutation"); return }
        helper.requests.removeFirst().completion(.result(method: "command", payload: ["revision": 2]))
        await Task.yield()
        XCTAssertEqual(nextResponse["ok"] as? Bool, true)
        helper.requests.removeFirst().completion(.refreshed(projection(2)))
        await Task.yield()
        XCTAssertEqual(bridge.projection.revision, 2)
        var stale: [String: Any] = [:]
        bridge.handle(request("command", revision: 0)) { stale = $0 }
        XCTAssertEqual(stale["ok"] as? Bool, false)
        XCTAssertEqual(stale["revision"] as? Int, 0, "A rejection must match the pending request so it can settle")
    }
}
