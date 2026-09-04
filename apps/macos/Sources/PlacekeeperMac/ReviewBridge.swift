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
              value["version"] as? Int == 1,
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
        "bootstrap", "presence", "detach", "command", "saveStatus", "saveProposal", "chooseCopy",
        "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "scope", "exportReviewedCopy",
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
    private let helper: SupervisedReviewHelper
    private let admission: MacReviewAdmission
    private(set) var projection: MacRuntimeProjection
    private var activated = false
    private var activating = false
    private var activationWaiters: [(Bool) -> Void] = []

    init(runtimeID: String, attemptID: String, helper: SupervisedReviewHelper, admission: MacReviewAdmission) {
        self.runtimeID = runtimeID
        self.attemptID = attemptID
        self.helper = helper
        self.admission = admission
        projection = admission.projection
    }

    var documentResourceURL: String {
        "placekeeper-resource://document/\(admission.resourceID)?generation=\(admission.generation)&role=document"
    }

    func handle(_ raw: Any, send: @escaping ([String: Any]) -> Void) {
        guard let request = MacPageRuntimeRequest.parse(raw, runtimeID: runtimeID) else { return }
        if request.method == "bootstrap" {
            send(response(
                request,
                identity: projection,
                payload: projection.pageBootstrapPayload(documentURL: documentResourceURL)
            ))
            return
        }
        guard request.sessionID == projection.sessionID,
              request.generation == projection.generation,
              request.revision == projection.revision else {
            send(rejection(request, identity: projection))
            return
        }
        if request.method == "presence" || request.method == "detach" {
            send(response(request, identity: projection, payload: [String: Any]()))
            return
        }
        guard activated else {
            send(rejection(request, identity: projection))
            return
        }
        var fields: [String: Any] = [
            "generation": projection.generation,
            "revision": projection.revision,
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

    private func refreshAfterMutation(method: String, send: @escaping ([String: Any]) -> Void) {
        guard Self.nonIdempotent.contains(method) else { return }
        _ = helper.request(type: "refresh") { [weak self] reply in
            Task { @MainActor in
                guard let self, case let .refreshed(next)? = reply else { return }
                let previous = self.projection
                self.projection = next
                guard next.generation != previous.generation || next.revision != previous.revision else { return }
                send([
                    "protocol": "placekeeper.review-runtime",
                    "version": 1,
                    "kind": "event",
                    "runtimeId": self.runtimeID,
                    "event": "session-invalidated",
                    "payload": [
                        "sessionId": next.sessionID,
                        "generation": next.generation,
                        "revision": next.revision,
                        "reason": next.generation == previous.generation ? "revision" : "generation",
                    ],
                ])
            }
        }
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
            "version": 1,
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

    private func rejection(_ request: MacPageRuntimeRequest, identity: MacRuntimeProjection) -> [String: Any] {
        rejectionEnvelope(
            requestID: request.requestID,
            method: request.method,
            sessionID: identity.sessionID,
            generation: identity.generation,
            revision: identity.revision
        )
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
            "version": 1,
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
        "command", "chooseCopy", "chooseFolder", "chooseOriginal", "retrySave", "locateSave", "exportReviewedCopy",
    ])
}
