import Foundation

struct MacPageRuntimeRequest {
    let requestID: String
    let method: String
    let payload: Any
    let sessionID: String?
    let generation: Int?
    let revision: Int?

    static func parse(_ value: Any, runtimeID: String) -> MacPageRuntimeRequest? {
        guard let value = value as? [String: Any],
              value["protocol"] as? String == "placekeeper.review-runtime",
              value["version"] as? Int == 3,
              value["kind"] as? String == "request",
              value["runtimeId"] as? String == runtimeID,
              let requestID = safeID(value["requestId"]),
              let method = value["method"] as? String,
              allowedMethods.contains(method), let payload = value["payload"] else { return nil }
        if method == "bootstrap" {
            guard Set(value.keys) == Set([
                "protocol", "version", "kind", "runtimeId", "requestId", "method", "payload",
            ]), (payload as? [String: Any])?.isEmpty == true else { return nil }
            return .init(
                requestID: requestID, method: method, payload: payload,
                sessionID: nil, generation: nil, revision: nil
            )
        }
        guard Set(value.keys) == Set([
            "protocol", "version", "kind", "runtimeId", "requestId", "sessionId", "generation",
            "revision", "method", "payload",
        ]), let sessionID = value["sessionId"] as? String,
              sessionID.range(of: sessionPattern, options: .regularExpression) != nil,
              let generation = value["generation"] as? Int, generation > 0,
              let revision = value["revision"] as? Int, revision >= 0 else { return nil }
        return .init(
            requestID: requestID, method: method, payload: payload,
            sessionID: sessionID, generation: generation, revision: revision
        )
    }

    private static let allowedMethods = Set([
        "bootstrap", "presence", "detach", "command", "beginInteraction", "finalizeInteraction",
        "releaseInteraction", "acknowledgeInteraction", "saveStatus", "saveProposal", "chooseCopy",
        "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "scope", "resolveReadingLocation",
        "exportReviewedCopy",
    ])
    private static let sessionPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

    private static func safeID(_ value: Any?) -> String? {
        guard let value = value as? String,
              value.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil else { return nil }
        return value
    }
}

@MainActor
final class ReviewBridge {
    let runtimeID: String
    let attemptID: String
    private let helper: any ReviewHelperRequesting
    private let resourceID: String
    private(set) var projection: MacRuntimeProjection
    private var activated = false
    private var activating = false
    private var activationWaiters: [(Bool) -> Void] = []
    private var refreshInFlight = false
    private var refreshPending = false
    private var pendingRefreshSend: (([String: Any]) -> Void)?
    private var installationToken = 0
    private var refreshBudgetFailureReported = false
    var successorInstaller: ((MacRuntimeProjection, @escaping (Bool) -> Void) -> Void)?
    var onRefreshBudgetExceeded: (() -> Void)?
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"

    init(runtimeID: String, attemptID: String, helper: any ReviewHelperRequesting, admission: MacReviewAdmission) {
        self.runtimeID = runtimeID
        self.attemptID = attemptID
        self.helper = helper
        resourceID = admission.resourceID
        projection = admission.projection
    }

    var documentResourceURL: String {
        "placekeeper-resource://document/\(resourceID)?generation=\(projection.generation)&role=document"
    }

    func handle(_ raw: Any, send: @escaping ([String: Any]) -> Void) {
        guard let request = MacPageRuntimeRequest.parse(raw, runtimeID: runtimeID) else {
            diagnostic("runtime-request-invalid")
            return
        }
        diagnostic("runtime-request: \(request.method)")
        if request.method == "bootstrap" {
            send(response(
                request,
                identity: projection,
                payload: projection.pageBootstrapPayload(documentURL: documentResourceURL)
            ))
            diagnostic("runtime-response: bootstrap")
            return
        }
        guard request.sessionID == projection.sessionID,
              request.generation == projection.generation,
              request.revision! >= projection.revision else {
            send(rejection(request, identity: request))
            return
        }
        if request.method == "presence" || request.method == "detach" {
            send(response(request, identity: projection, payload: [String: Any]()))
            return
        }
        guard activated else {
            send(rejection(request, identity: request))
            return
        }
        var fields: [String: Any] = [
            "generation": projection.generation,
            // A committed command can advance the page before the asynchronous
            // native projection refresh arrives. The helper owns authoritative
            // revision validation; forward the page's revision to it.
            "revision": request.revision!,
            "method": request.method,
            "payload": request.payload,
        ]
        if Self.nonIdempotent.contains(request.method) {
            fields["idempotencyKey"] = "operation_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        guard helper.request(type: "invoke", fields: fields, completion: { [weak self] reply in
            Task { @MainActor in
                guard let self else { return }
                switch reply {
                case let .result(method, payload) where method == request.method:
                    send(self.response(request, identity: request, payload: payload))
                    self.refreshAfterMutation(method: method, send: send)
                case .failure, nil:
                    send(self.rejection(request, identity: request))
                default:
                    send(self.rejection(request, identity: request))
                }
            }
        }) != nil else {
            send(rejection(request, identity: request))
            return
        }
    }

    func activate(generation: Int, completion: @escaping (Bool) -> Void) {
        guard generation == projection.generation else { completion(false); return }
        if activated { completion(true); return }
        activationWaiters.append(completion)
        guard !activating else { return }
        activating = true
        diagnostic("runtime-activation-requested")
        guard helper.request(type: "activate", fields: ["documentValidated": true], completion: { [weak self] reply in
            Task { @MainActor in
                guard let self else { return }
                self.activating = false
                if case let .active(projection)? = reply,
                   projection.generation == generation,
                   projection.sessionID == self.projection.sessionID {
                    self.projection = projection
                    self.activated = true
                }
                self.diagnostic(self.activated ? "runtime-activated" : "runtime-activation-failed")
                let waiters = self.activationWaiters
                self.activationWaiters.removeAll()
                for waiter in waiters { waiter(self.activated) }
            }
        }) != nil else {
            activating = false
            let waiters = activationWaiters
            activationWaiters.removeAll()
            for waiter in waiters { waiter(false) }
            return
        }
    }

    func keepalive(send: @escaping ([String: Any]) -> Void, completion: @escaping (Bool) -> Void = { _ in }) {
        guard activated else { completion(false); return }
        guard !refreshInFlight else {
            refreshPending = true
            pendingRefreshSend = send
            completion(false)
            return
        }
        refreshInFlight = true
        guard helper.request(type: "keepalive", fields: [:], completion: { [weak self] reply in
            Task { @MainActor in
                guard let self else { return }
                switch reply {
                case .invalidation:
                    self.fetchCurrent(send: send, completion: completion)
                case let .refreshed(next):
                    self.installAndPublish(next, send: send) { installed in
                        self.finishRefresh(success: installed, send: send, completion: completion)
                    }
                default:
                    self.noteRefreshFailure(reply)
                    self.finishRefresh(success: false, send: send, completion: completion)
                }
            }
        }) != nil else {
            finishRefresh(success: false, send: send, completion: completion)
            return
        }
    }

    func retryRefreshAfterBudgetFailure(send: @escaping ([String: Any]) -> Void) {
        refreshBudgetFailureReported = false
        keepalive(send: send)
    }

    private func fetchCurrent(send: @escaping ([String: Any]) -> Void, completion: @escaping (Bool) -> Void) {
        guard helper.request(type: "refresh", fields: [:], completion: { [weak self] reply in
            Task { @MainActor in
                guard let self else { return }
                guard case let .refreshed(next)? = reply else {
                    self.noteRefreshFailure(reply)
                    self.finishRefresh(success: false, send: send, completion: completion)
                    return
                }
                self.installAndPublish(next, send: send) { installed in
                    self.finishRefresh(success: installed, send: send, completion: completion)
                }
            }
        }) != nil else {
            finishRefresh(success: false, send: send, completion: completion)
            return
        }
    }

    private func requestRefresh(send: @escaping ([String: Any]) -> Void) {
        guard activated else { return }
        guard !refreshInFlight else {
            refreshPending = true
            pendingRefreshSend = send
            return
        }
        refreshInFlight = true
        guard helper.request(type: "refresh", fields: [:], completion: { [weak self] reply in
            Task { @MainActor in
                guard let self else { return }
                guard case let .refreshed(next)? = reply else {
                    self.noteRefreshFailure(reply)
                    self.finishRefresh(success: false, send: send)
                    return
                }
                self.installAndPublish(next, send: send) { installed in
                    self.finishRefresh(success: installed, send: send)
                }
            }
        }) != nil else { finishRefresh(success: false, send: send); return }
    }

    private func finishRefresh(
        success: Bool,
        send: @escaping ([String: Any]) -> Void,
        completion: @escaping (Bool) -> Void = { _ in }
    ) {
        refreshInFlight = false
        if success { refreshBudgetFailureReported = false }
        completion(success)
        guard refreshPending else { return }
        refreshPending = false
        let nextSend = pendingRefreshSend ?? send
        pendingRefreshSend = nil
        requestRefresh(send: nextSend)
    }

    private func noteRefreshFailure(_ reply: MacReviewHelperReply?) {
        guard case .failure(code: "budget")? = reply, !refreshBudgetFailureReported else { return }
        refreshBudgetFailureReported = true
        onRefreshBudgetExceeded?()
    }

    private func installAndPublish(
        _ next: MacRuntimeProjection,
        send: @escaping ([String: Any]) -> Void,
        completion: @escaping (Bool) -> Void = { _ in }
    ) {
        guard next.sessionID == projection.sessionID else { completion(false); return }
        guard Self.shouldPublish(next, over: projection) else {
            completion(true)
            return
        }
        installationToken += 1
        let token = installationToken
        let publish = { [weak self] in
            guard let self, token == self.installationToken,
                  Self.shouldPublish(next, over: self.projection) else { return false }
            let previous = self.projection
            self.projection = next
            send(self.invalidation(previous: previous, next: next))
            return true
        }
        if next.generation != projection.generation, let successorInstaller {
            successorInstaller(next) { installed in
                completion(installed && publish())
            }
        } else {
            completion(publish())
        }
    }

    private func invalidation(previous: MacRuntimeProjection, next: MacRuntimeProjection) -> [String: Any] {
        let reason = if next.generation != previous.generation {
            "generation"
        } else if next.revision != previous.revision {
            "revision"
        } else {
            "freshness"
        }
        var payload: [String: Any] = [
            "sessionId": next.sessionID, "generation": next.generation, "revision": next.revision,
            "reason": reason,
        ]
        if next.generation != previous.generation { payload["previousGeneration"] = previous.generation }
        return [
            "protocol": "placekeeper.review-runtime", "version": 3, "kind": "event",
            "runtimeId": runtimeID, "event": "session-invalidated",
            "payload": payload,
        ]
    }

    private func refreshAfterMutation(method: String, send: @escaping ([String: Any]) -> Void) {
        guard Self.nonIdempotent.contains(method) else { return }
        requestRefresh(send: send)
    }

    private static func isNewer(_ candidate: MacRuntimeProjection, than current: MacRuntimeProjection) -> Bool {
        candidate.generation > current.generation
            || (candidate.generation == current.generation && candidate.revision > current.revision)
    }

    private static func shouldPublish(_ candidate: MacRuntimeProjection, over current: MacRuntimeProjection) -> Bool {
        if isNewer(candidate, than: current) { return true }
        guard candidate.generation == current.generation,
              candidate.revision == current.revision else { return false }
        let candidateLifecycle: NSDictionary = [
            "activeAuthoringDraftIds": candidate.activeAuthoringDraftIds,
            "state": candidate.state,
            "scope": candidate.scope,
            "saveStatus": candidate.saveStatus,
            "protected": candidate.protected,
            "location": candidate.location ?? NSNull(),
        ]
        let currentLifecycle: NSDictionary = [
            "activeAuthoringDraftIds": current.activeAuthoringDraftIds,
            "state": current.state,
            "scope": current.scope,
            "saveStatus": current.saveStatus,
            "protected": current.protected,
            "location": current.location ?? NSNull(),
        ]
        return !candidateLifecycle.isEqual(currentLifecycle)
    }

    private func response(_ request: MacPageRuntimeRequest, identity: MacRuntimeProjection, payload: Any) -> [String: Any] {
        responseEnvelope(
            requestID: request.requestID,
            method: request.method,
            sessionID: identity.sessionID,
            generation: identity.generation,
            revision: identity.revision,
            payload: payload
        )
    }

    private func response(_ request: MacPageRuntimeRequest, identity: MacPageRuntimeRequest, payload: Any) -> [String: Any] {
        responseEnvelope(
            requestID: request.requestID,
            method: request.method,
            sessionID: identity.sessionID!,
            generation: identity.generation!,
            revision: identity.revision!,
            payload: payload
        )
    }

    private func responseEnvelope(
        requestID: String,
        method: String,
        sessionID: String,
        generation: Int,
        revision: Int,
        payload: Any
    ) -> [String: Any] {
        [
            "protocol": "placekeeper.review-runtime",
            "version": 3,
            "kind": "response",
            "runtimeId": runtimeID,
            "sessionId": sessionID,
            "generation": generation,
            "revision": revision,
            "requestId": requestID,
            "method": method,
            "ok": true,
            "payload": payload,
        ]
    }

    private func rejection(_ request: MacPageRuntimeRequest, identity: MacPageRuntimeRequest) -> [String: Any] {
        rejectionEnvelope(
            requestID: request.requestID,
            method: request.method,
            sessionID: identity.sessionID!,
            generation: identity.generation!,
            revision: identity.revision!
        )
    }

    private func rejectionEnvelope(
        requestID: String,
        method: String,
        sessionID: String,
        generation: Int,
        revision: Int
    ) -> [String: Any] {
        [
            "protocol": "placekeeper.review-runtime",
            "version": 3,
            "kind": "response",
            "runtimeId": runtimeID,
            "sessionId": sessionID,
            "generation": generation,
            "revision": revision,
            "requestId": requestID,
            "method": method,
            "ok": false,
            "error": ["kind": "rejected"],
        ]
    }

    private static let nonIdempotent = Set([
        "command", "beginInteraction", "finalizeInteraction", "releaseInteraction", "acknowledgeInteraction",
        "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy",
    ])

    private func diagnostic(_ message: String) {
        guard diagnosticsEnabled,
              let bytes = "[PlacekeeperMac] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(bytes)
    }
}
