import Foundation

struct DocumentWindowRegistry {
    struct Record: Equatable {
        let windowID: String
        let canonicalReviewID: String
        let documentDigest: String
        fileprivate var keyOrdinal: Int
    }

    private(set) var records: [String: Record] = [:]
    private var nextKeyOrdinal = 1

    mutating func register(windowID: String, canonicalReviewID: String, documentDigest: String) -> Bool {
        guard records[windowID] == nil,
              canonicalReviewID.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil,
              documentDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { return false }
        records[windowID] = .init(
            windowID: windowID,
            canonicalReviewID: canonicalReviewID,
            documentDigest: documentDigest,
            keyOrdinal: nextKeyOrdinal
        )
        nextKeyOrdinal += 1
        return true
    }

    mutating func noteKey(windowID: String) {
        guard var record = records[windowID] else { return }
        record.keyOrdinal = nextKeyOrdinal
        nextKeyOrdinal += 1
        records[windowID] = record
    }

    func matchingWindow(canonicalReviewID: String) -> String? {
        records.values
            .filter { $0.canonicalReviewID == canonicalReviewID }
            .max { $0.keyOrdinal < $1.keyOrdinal }?
            .windowID
    }

    mutating func remove(windowID: String) {
        records.removeValue(forKey: windowID)
    }
}
