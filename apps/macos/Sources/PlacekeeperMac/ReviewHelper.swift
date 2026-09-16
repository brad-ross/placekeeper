@preconcurrency import Foundation

let macosHelperMaxFrameBytes = 256 * 1024
let macosHelperResourceChunkBytes = 64 * 1024

enum HelperFrameError: Error, Equatable {
    case empty
    case oversized
    case malformedJSON
}

struct HelperFrameAccumulator {
    private var buffered = Data()

    mutating func append(_ bytes: Data) throws -> [[String: Any]] {
        buffered.append(bytes)
        var messages: [[String: Any]] = []
        while buffered.count >= 4 {
            let length = Int(buffered.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) })
            guard length > 0 else { throw HelperFrameError.empty }
            guard length <= macosHelperMaxFrameBytes else { throw HelperFrameError.oversized }
            guard buffered.count >= length + 4 else { break }
            let body = buffered.subdata(in: 4..<(length + 4))
            guard let value = try? JSONSerialization.jsonObject(with: body),
                  let message = value as? [String: Any] else {
                throw HelperFrameError.malformedJSON
            }
            messages.append(message)
            buffered.removeSubrange(0..<(length + 4))
        }
        return messages
    }
}

struct MacRuntimeProjection {
    let sessionID: String
    let generation: Int
    let revision: Int
    let state: [String: Any]
    let scope: [String: Any]
    let saveStatus: [String: Any]
    let protected: Bool
    let location: Any?
    let documentDigest: String
    let documentByteLength: Int

    func pageBootstrapPayload(documentURL: String) -> [String: Any] {
        var payload: [String: Any] = [
            "sessionId": sessionID,
            "generation": generation,
            "revision": revision,
            "state": state,
            "scope": scope,
            "saveStatus": saveStatus,
            "protected": protected,
            "resources": [
                "document": documentURL,
                "pdfiumWasm": "placekeeper-app://bundle/assets/pdfium.wasm",
                "worker": "placekeeper-app://bundle/assets/pdfium-worker.js",
            ],
        ]
        if let location { payload["location"] = location }
        return payload
    }
}

struct MacReviewAdmission {
    let provisionalID: String
    let resourceID: String
    let generation: Int
    let byteLength: Int
    let digest: String
    let displayName: String
    let projection: MacRuntimeProjection
}

enum MacReviewHelperReply {
    case admitted(MacReviewAdmission)
    case recoveryOffered(id: String, expiresAt: String)
    case active(MacRuntimeProjection)
    case refreshed(MacRuntimeProjection)
    case invalidation(generation: Int, revision: Int, reason: String)
    case result(method: String, payload: Any)
    case resource(sequence: Int, bytes: Data, done: Bool)
    case resourceAdopted(generation: Int)
    case released
    case failure(code: String)
}

enum MacReviewHelperReplyParser {
    private static let identifier = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{8,128}$")
    private static let session = try! NSRegularExpression(
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )
    private static let digest = try! NSRegularExpression(pattern: "^[a-f0-9]{64}$")
    private static let methods = Set([
        "command", "saveStatus", "saveProposal", "chooseCopy", "chooseFolder", "chooseOriginal",
        "retrySave", "locateSave", "scope", "exportReviewedCopy",
    ])

    static func parse(
        _ value: [String: Any],
        windowID: String,
        attemptID: String,
        requestID: String
    ) -> MacReviewHelperReply? {
        guard value["protocolVersion"] as? Int == 1,
              value["windowId"] as? String == windowID,
              value["attemptId"] as? String == attemptID,
              value["requestId"] as? String == requestID,
              let type = value["type"] as? String else { return nil }
        let base = Set(["protocolVersion", "windowId", "attemptId", "requestId", "type"])
        switch type {
        case "admitted":
            guard exact(value, base.union([
                "provisionalId", "resourceId", "generation", "byteLength", "digest", "displayName", "projection",
            ])), let provisionalID = safeID(value["provisionalId"]), let resourceID = safeID(value["resourceId"]),
                  let generation = positiveInteger(value["generation"]),
                  let byteLength = boundedInteger(value["byteLength"], minimum: 5, maximum: 512 * 1024 * 1024),
                  let digest = safeDigest(value["digest"]), let displayName = safeDisplayName(value["displayName"]),
                  let rawProjection = value["projection"] as? [String: Any],
                  let projection = projection(rawProjection), projection.generation == generation,
                  projection.documentByteLength == byteLength, projection.documentDigest == digest else { return nil }
            return .admitted(.init(
                provisionalID: provisionalID,
                resourceID: resourceID,
                generation: generation,
                byteLength: byteLength,
                digest: digest,
                displayName: displayName,
                projection: projection
            ))
        case "active", "refreshed":
            guard exact(value, base.union(["projection"])),
                  let rawProjection = value["projection"] as? [String: Any],
                  let projection = projection(rawProjection) else { return nil }
            return type == "active" ? .active(projection) : .refreshed(projection)
        case "recovery-offered":
            let expiryFormatter = ISO8601DateFormatter()
            expiryFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            guard exact(value, base.union(["choices", "offer"])),
                  let choices = value["choices"] as? [String],
                  choices == ["resume", "discard", "fork"],
                  let offer = value["offer"] as? [String: Any],
                  exact(offer, Set(["id", "expiresAt"])),
                  let id = offer["id"] as? String,
                  id.range(of: "^[A-Za-z0-9_-]{16,128}$", options: .regularExpression) != nil,
                  let expiresAt = offer["expiresAt"] as? String,
                  (expiryFormatter.date(from: expiresAt)
                    ?? ISO8601DateFormatter().date(from: expiresAt)) != nil else { return nil }
            return .recoveryOffered(id: id, expiresAt: expiresAt)
        case "invalidation":
            guard exact(value, base.union(["generation", "revision", "reason"])),
                  let generation = positiveInteger(value["generation"]),
                  let revision = nonnegativeInteger(value["revision"]),
                  let reason = value["reason"] as? String,
                  ["revision", "generation", "save", "recovery"].contains(reason) else { return nil }
            return .invalidation(generation: generation, revision: revision, reason: reason)
        case "result":
            guard exact(value, base.union(["method", "payload"])),
                  let method = value["method"] as? String, methods.contains(method),
                  let payload = value["payload"] else { return nil }
            return .result(method: method, payload: payload)
        case "resource-bytes":
            guard exact(value, base.union(["sequence", "data", "done"])),
                  let sequence = nonnegativeInteger(value["sequence"]),
                  let encoded = value["data"] as? String,
                  encoded.utf8.count <= macosHelperResourceChunkBytes * 2,
                  let bytes = Data(base64Encoded: encoded), bytes.count <= macosHelperResourceChunkBytes,
                  let done = value["done"] as? Bool else { return nil }
            return .resource(sequence: sequence, bytes: bytes, done: done)
        case "resource-adopted":
            guard exact(value, base.union(["generation"])),
                  let generation = positiveInteger(value["generation"]) else { return nil }
            return .resourceAdopted(generation: generation)
        case "released":
            return exact(value, base) ? .released : nil
        case "failure":
            guard exact(value, base.union(["code"])), let code = value["code"] as? String,
                  ["invalid", "stale", "unavailable", "budget", "recovery"].contains(code) else { return nil }
            return .failure(code: code)
        default:
            return nil
        }
    }

    private static func projection(_ value: [String: Any]) -> MacRuntimeProjection? {
        let allowed = Set([
            "sessionId", "generation", "revision", "state", "scope", "saveStatus", "protected", "location", "document",
        ])
        guard Set(value.keys).isSubset(of: allowed),
              value.keys.contains("sessionId"), value.keys.contains("generation"), value.keys.contains("revision"),
              value.keys.contains("state"), value.keys.contains("scope"), value.keys.contains("saveStatus"),
              value.keys.contains("protected"), value.keys.contains("document"),
              let sessionID = value["sessionId"] as? String, fullMatch(session, sessionID),
              let generation = positiveInteger(value["generation"]),
              let revision = nonnegativeInteger(value["revision"]),
              let state = value["state"] as? [String: Any],
              let scope = value["scope"] as? [String: Any],
              let saveStatus = value["saveStatus"] as? [String: Any],
              let protected = value["protected"] as? Bool,
              let document = value["document"] as? [String: Any],
              exact(document, Set(["sha256", "byteLength", "generation"])),
              let documentDigest = safeDigest(document["sha256"]),
              let documentByteLength = boundedInteger(
                document["byteLength"], minimum: 5, maximum: 512 * 1024 * 1024
              ), let documentGeneration = positiveInteger(document["generation"]),
              documentGeneration == generation else { return nil }
        return .init(
            sessionID: sessionID,
            generation: generation,
            revision: revision,
            state: state,
            scope: scope,
            saveStatus: saveStatus,
            protected: protected,
            location: value["location"],
            documentDigest: documentDigest,
            documentByteLength: documentByteLength
        )
    }

    private static func exact(_ value: [String: Any], _ keys: Set<String>) -> Bool { Set(value.keys) == keys }

    private static func safeID(_ value: Any?) -> String? {
        guard let value = value as? String, fullMatch(identifier, value) else { return nil }
        return value
    }

    private static func safeDigest(_ value: Any?) -> String? {
        guard let value = value as? String, fullMatch(digest, value) else { return nil }
        return value
    }

    private static func safeDisplayName(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= 255,
              value.rangeOfCharacter(from: CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\"))) == nil
        else { return nil }
        return value
    }

    private static func positiveInteger(_ value: Any?) -> Int? {
        guard let value = value as? Int, value > 0 else { return nil }
        return value
    }

    private static func nonnegativeInteger(_ value: Any?) -> Int? {
        guard let value = value as? Int, value >= 0 else { return nil }
        return value
    }

    private static func boundedInteger(_ value: Any?, minimum: Int, maximum: Int) -> Int? {
        guard let value = value as? Int, value >= minimum, value <= maximum else { return nil }
        return value
    }

    private static func fullMatch(_ expression: NSRegularExpression, _ value: String) -> Bool {
        expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value))?.range.length == value.utf16.count
    }
}

protocol ReviewHelperRequesting {
    func request(type: String, fields: [String: Any], completion: @escaping (MacReviewHelperReply?) -> Void) -> String?
}

final class SupervisedReviewHelper: ReviewHelperProcess, ReviewHelperRequesting, @unchecked Sendable {
    typealias Completion = (MacReviewHelperReply?) -> Void

    let windowID: String
    let attemptID: String
    private let process: Process
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let lock = NSLock()
    private var accumulator = HelperFrameAccumulator()
    private var pending: [String: Completion] = [:]
    private var finished = false

    var isRunning: Bool { process.isRunning }

    init?(
        appInstanceID: String,
        helperID: String,
        windowID: String,
        attemptID: String,
        executable: URL,
        argumentPrefix: [String] = [],
        baseEnvironment: [String: String],
        onExit: @escaping @Sendable (String) -> Void
    ) {
        self.windowID = windowID
        self.attemptID = attemptID
        process = Process()
        process.executableURL = executable
        process.arguments = argumentPrefix + ["macos-review-helper"]
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = baseEnvironment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"
            ? FileHandle.standardError
            : FileHandle.nullDevice
        var environment = ChildEnvironmentPolicy.minimal(from: baseEnvironment)
        environment["PLACEKEEPER_APP_INSTANCE_ID"] = appInstanceID
        environment["PLACEKEEPER_HELPER_ID"] = helperID
        environment["PLACEKEEPER_WINDOW_ID"] = windowID
        environment["PLACEKEEPER_ATTEMPT_ID"] = attemptID
        process.environment = environment
        process.terminationHandler = { [weak self] _ in
            self?.finish()
            onExit(windowID)
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
    func request(type: String, fields: [String: Any] = [:], completion: @escaping Completion) -> String? {
        let requestID = "request_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        var message: [String: Any] = [
            "protocolVersion": 1,
            "windowId": windowID,
            "attemptId": attemptID,
            "requestId": requestID,
            "type": type,
        ]
        for (key, value) in fields where message[key] == nil { message[key] = value }
        guard JSONSerialization.isValidJSONObject(message),
              let body = try? JSONSerialization.data(withJSONObject: message),
              !body.isEmpty, body.count <= macosHelperMaxFrameBytes else { return nil }
        var length = UInt32(body.count).bigEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }
        frame.append(body)
        lock.lock()
        guard !finished, process.isRunning else { lock.unlock(); return nil }
        pending[requestID] = completion
        do {
            try stdinPipe.fileHandleForWriting.write(contentsOf: frame)
            lock.unlock()
            return requestID
        } catch {
            pending.removeValue(forKey: requestID)
            lock.unlock()
            finish()
            return nil
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
        var deliveries: [(Completion, MacReviewHelperReply?)] = []
        for message in messages {
            guard let requestID = message["requestId"] as? String,
                  let completion = pending.removeValue(forKey: requestID) else {
                lock.unlock()
                terminate()
                return
            }
            deliveries.append((completion, MacReviewHelperReplyParser.parse(
                message, windowID: windowID, attemptID: attemptID, requestID: requestID
            )))
        }
        lock.unlock()
        for (completion, reply) in deliveries { completion(reply) }
    }

    private func finish() {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let callbacks = Array(pending.values)
        pending.removeAll()
        lock.unlock()
        stdoutPipe.fileHandleForReading.readabilityHandler = nil
        for callback in callbacks { callback(nil) }
    }

    deinit { terminate() }
}
