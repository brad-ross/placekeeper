import CryptoKit
@preconcurrency import Foundation

let macosHelperMaxFrameBytes = 4 * 1024 * 1024
let macosHelperMaxStreamBytes = 16 * 1024 * 1024
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

enum HelperResponseStreamResult {
    case pending
    case complete(Data)
}

struct HelperResponseStreamAccumulator {
    private final class Stream {
        let id: String
        let totalBytes: Int
        let chunkCount: Int
        let digest: String
        var nextSequence = 0
        var bytes: Data

        init(id: String, totalBytes: Int, chunkCount: Int, digest: String) {
            self.id = id
            self.totalBytes = totalBytes
            self.chunkCount = chunkCount
            self.digest = digest
            bytes = Data()
            bytes.reserveCapacity(totalBytes)
        }
    }
    private var streams: [String: Stream] = [:]
    private var reservedBytes = 0

    func contains(_ requestID: String) -> Bool { streams[requestID] != nil }
    mutating func removeAll() {
        streams.removeAll()
        reservedBytes = 0
    }

    mutating func accept(
        _ message: [String: Any], windowID: String, attemptID: String, requestID: String
    ) -> HelperResponseStreamResult? {
        guard message["protocolVersion"] as? Int == 1,
              message["windowId"] as? String == windowID,
              message["attemptId"] as? String == attemptID,
              message["requestId"] as? String == requestID else { return nil }
        if message["type"] as? String == "response-stream-start" {
            let keys = Set([
                "protocolVersion", "windowId", "attemptId", "requestId", "type", "streamId",
                "totalBytes", "chunkCount", "sha256",
            ])
            guard Set(message.keys) == keys, streams[requestID] == nil,
                  let streamID = message["streamId"] as? String,
                  streamID.range(of: "^[A-Za-z0-9_-]{8,128}$", options: .regularExpression) != nil,
                  let totalBytes = message["totalBytes"] as? Int,
                  totalBytes > macosHelperMaxFrameBytes, totalBytes <= macosHelperMaxStreamBytes,
                  reservedBytes <= macosHelperMaxStreamBytes - totalBytes,
                  let chunkCount = message["chunkCount"] as? Int,
                  chunkCount == (totalBytes + macosHelperResourceChunkBytes - 1) / macosHelperResourceChunkBytes,
                  let digest = message["sha256"] as? String,
                  digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return nil }
            streams[requestID] = Stream(id: streamID, totalBytes: totalBytes, chunkCount: chunkCount, digest: digest)
            reservedBytes += totalBytes
            return .pending
        }
        guard message["type"] as? String == "response-stream-chunk" else { return nil }
        let keys = Set([
            "protocolVersion", "windowId", "attemptId", "requestId", "type", "streamId", "sequence", "data",
        ])
        guard Set(message.keys) == keys, let stream = streams[requestID],
              message["streamId"] as? String == stream.id,
              message["sequence"] as? Int == stream.nextSequence,
              let encoded = message["data"] as? String,
              encoded.utf8.count <= macosHelperResourceChunkBytes * 2,
              let chunk = Data(base64Encoded: encoded), !chunk.isEmpty,
              chunk.count <= macosHelperResourceChunkBytes,
              stream.bytes.count + chunk.count <= stream.totalBytes else { return nil }
        stream.bytes.append(chunk)
        stream.nextSequence += 1
        if stream.nextSequence < stream.chunkCount { return .pending }
        guard stream.bytes.count == stream.totalBytes,
              SHA256.hash(data: stream.bytes).map({ String(format: "%02x", $0) }).joined() == stream.digest else {
            return nil
        }
        streams.removeValue(forKey: requestID)
        reservedBytes -= stream.totalBytes
        return .complete(stream.bytes)
    }
}
