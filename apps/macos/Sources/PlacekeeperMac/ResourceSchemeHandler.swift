import CryptoKit
import Foundation
@preconcurrency import WebKit

final class MacDocumentResourceLoader: @unchecked Sendable {
    private let helper: SupervisedReviewHelper
    private let resourceID: String
    private let generation: Int
    private let byteLength: Int
    private let digest: String
    private let lock = NSLock()
    private var cached: Data?
    private var loading = false
    private var completions: [(Result<Data, Error>) -> Void] = []
    private var invalidated = false
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"

    init(helper: SupervisedReviewHelper, admission: MacReviewAdmission) {
        self.helper = helper
        resourceID = admission.resourceID
        generation = admission.generation
        byteLength = admission.byteLength
        digest = admission.digest
    }

    func load(completion: @escaping (Result<Data, Error>) -> Void) {
        lock.lock()
        if invalidated { lock.unlock(); completion(.failure(URLError(.cancelled))); return }
        if let cached { lock.unlock(); completion(.success(cached)); return }
        completions.append(completion)
        guard !loading else { lock.unlock(); return }
        loading = true
        lock.unlock()
        diagnostic("resource-load-start: \(byteLength) bytes")
        read(offset: 0, accumulated: Data())
    }

    func invalidate() {
        lock.lock()
        invalidated = true
        cached?.removeAll()
        cached = nil
        let callbacks = completions
        completions.removeAll()
        lock.unlock()
        for callback in callbacks { callback(.failure(URLError(.cancelled))) }
    }

    private func read(offset: Int, accumulated: Data) {
        let length = min(macosHelperResourceChunkBytes, byteLength - offset)
        guard length > 0 else { finish(accumulated); return }
        let expectedSequence = offset / macosHelperResourceChunkBytes
        guard helper.request(type: "read-resource", fields: [
            "resourceId": resourceID,
            "generation": generation,
            "role": "document",
            "offset": offset,
            "length": length,
        ], completion: { [weak self] reply in
            guard let self else { return }
            guard case let .resource(sequence, bytes, done)? = reply,
                  sequence == expectedSequence, !bytes.isEmpty, bytes.count <= length,
                  done == (offset + bytes.count >= self.byteLength) else {
                self.diagnostic("resource-chunk-invalid: sequence \(expectedSequence)")
                self.fail(URLError(.cannotDecodeContentData)); return
            }
            self.diagnostic("resource-chunk: sequence \(sequence), \(bytes.count) bytes, done \(done)")
            var next = accumulated
            next.append(bytes)
            guard next.count <= self.byteLength else {
                self.fail(URLError(.dataLengthExceedsMaximum)); return
            }
            if done { self.finish(next) }
            else { self.read(offset: next.count, accumulated: next) }
        }) != nil else {
            fail(URLError(.cannotConnectToHost))
            return
        }
    }

    private func finish(_ bytes: Data) {
        let computed = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard bytes.count == byteLength, computed == digest, bytes.starts(with: Data("%PDF".utf8)) else {
            diagnostic("resource-validation-failed")
            fail(URLError(.cannotDecodeContentData)); return
        }
        lock.lock()
        guard !invalidated else { lock.unlock(); return }
        cached = bytes
        loading = false
        let callbacks = completions
        completions.removeAll()
        lock.unlock()
        diagnostic("resource-load-finished: \(bytes.count) bytes")
        for callback in callbacks { callback(.success(bytes)) }
    }

    private func fail(_ error: Error) {
        lock.lock()
        loading = false
        let callbacks = completions
        completions.removeAll()
        lock.unlock()
        diagnostic("resource-load-failed: \((error as? URLError)?.code.rawValue ?? -1)")
        for callback in callbacks { callback(.failure(error)) }
    }

    private func diagnostic(_ message: String) {
        guard diagnosticsEnabled,
              let bytes = "[PlacekeeperMac] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(bytes)
    }
}

final class MacSchemeHandler: NSObject, WKURLSchemeHandler, @unchecked Sendable {
    private let packagedRoot: URL
    private let manifestKeys: Set<String>
    private let documentLoader: MacDocumentResourceLoader
    private let resourceID: String
    private let generation: Int
    private let byteLength: Int
    private let lock = NSLock()
    private var liveTasks = Set<ObjectIdentifier>()
    private var invalidated = false
    private let diagnosticsEnabled = ProcessInfo.processInfo.environment["PLACEKEEPER_MAC_DIAGNOSTICS"] == "1"

    init(packagedRoot: URL, manifestKeys: Set<String>, helper: SupervisedReviewHelper, admission: MacReviewAdmission) {
        self.packagedRoot = packagedRoot.resolvingSymlinksInPath().standardizedFileURL
        self.manifestKeys = manifestKeys
        documentLoader = MacDocumentResourceLoader(helper: helper, admission: admission)
        resourceID = admission.resourceID
        generation = admission.generation
        byteLength = admission.byteLength
    }

    func loadDocument(completion: @escaping (Result<Data, Error>) -> Void) {
        documentLoader.load(completion: completion)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskID = ObjectIdentifier(urlSchemeTask as AnyObject)
        lock.lock()
        guard !invalidated else { lock.unlock(); urlSchemeTask.didFailWithError(URLError(.cancelled)); return }
        liveTasks.insert(taskID)
        lock.unlock()
        guard urlSchemeTask.request.httpMethod == "GET", let url = urlSchemeTask.request.url else {
            fail(urlSchemeTask, id: taskID, error: URLError(.unsupportedURL)); return
        }
        if let key = MacSchemePolicy.bundleKey(for: url), manifestKeys.contains(key) {
            diagnostic("bundle-resource-request: \(key)")
            let file = packagedRoot.appendingPathComponent(key).resolvingSymlinksInPath().standardizedFileURL
            guard file.path.hasPrefix(packagedRoot.path + "/"), let bytes = try? Data(contentsOf: file) else {
                fail(urlSchemeTask, id: taskID, error: URLError(.fileDoesNotExist)); return
            }
            respond(urlSchemeTask, id: taskID, url: url, bytes: bytes, mime: mimeType(for: key)); return
        }
        guard let identity = MacSchemePolicy.resourceIdentity(for: url), identity.id == resourceID,
              identity.generation == generation else {
            diagnostic("resource-request-rejected")
            fail(urlSchemeTask, id: taskID, error: URLError(.noPermissionsToReadFile)); return
        }
        diagnostic("document-resource-request")
        guard beginResponse(
            urlSchemeTask,
            id: taskID,
            url: url,
            expectedLength: byteLength,
            mime: "application/pdf"
        ) else { return }
        documentLoader.load { [weak self, weak task = urlSchemeTask as AnyObject] result in
            DispatchQueue.main.async {
                guard let self, let task = task as? WKURLSchemeTask else { return }
                switch result {
                case let .success(bytes): self.completeResponse(task, id: taskID, bytes: bytes)
                case let .failure(error): self.fail(task, id: taskID, error: error)
                }
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        lock.lock()
        liveTasks.remove(ObjectIdentifier(urlSchemeTask as AnyObject))
        lock.unlock()
    }

    func invalidate() {
        lock.lock()
        invalidated = true
        liveTasks.removeAll()
        lock.unlock()
        documentLoader.invalidate()
    }

    private func respond(_ task: WKURLSchemeTask, id: ObjectIdentifier, url: URL, bytes: Data, mime: String) {
        guard consume(id) else { return }
        task.didReceive(successResponse(url: url, mime: mime, expectedLength: bytes.count))
        task.didReceive(bytes)
        task.didFinish()
    }

    private func beginResponse(
        _ task: WKURLSchemeTask,
        id: ObjectIdentifier,
        url: URL,
        expectedLength: Int,
        mime: String
    ) -> Bool {
        guard isLive(id) else { return false }
        task.didReceive(successResponse(url: url, mime: mime, expectedLength: expectedLength))
        return true
    }

    private func completeResponse(_ task: WKURLSchemeTask, id: ObjectIdentifier, bytes: Data) {
        guard consume(id) else { return }
        task.didReceive(bytes)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask, id: ObjectIdentifier, error: Error) {
        guard consume(id) else { return }
        task.didFailWithError(error)
    }

    private func consume(_ id: ObjectIdentifier) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !invalidated && liveTasks.remove(id) != nil
    }

    private func isLive(_ id: ObjectIdentifier) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !invalidated && liveTasks.contains(id)
    }

    private func successResponse(url: URL, mime: String, expectedLength: Int) -> URLResponse {
        HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Cache-Control": "no-store",
                "Content-Length": String(expectedLength),
                "Content-Type": mime,
            ]
        ) ?? URLResponse(
            url: url,
            mimeType: mime,
            expectedContentLength: expectedLength,
            textEncodingName: nil
        )
    }

    private func mimeType(for key: String) -> String {
        if key.hasSuffix(".html") { return "text/html" }
        if key.hasSuffix(".js") { return "text/javascript" }
        if key.hasSuffix(".css") { return "text/css" }
        if key.hasSuffix(".wasm") { return "application/wasm" }
        return "application/octet-stream"
    }

    private func diagnostic(_ message: String) {
        guard diagnosticsEnabled,
              let bytes = "[PlacekeeperMac] \(message)\n".data(using: .utf8) else { return }
        FileHandle.standardError.write(bytes)
    }
}
