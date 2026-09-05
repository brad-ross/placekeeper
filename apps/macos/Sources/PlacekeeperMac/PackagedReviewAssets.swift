import Foundation

struct PackagedReviewAssets: Sendable {
    let pdfium: Data
    let worker: Data

    static func load(from packagedRoot: URL) async -> PackagedReviewAssets? {
        await Task.detached(priority: .userInitiated) {
            let pdfiumURL = packagedRoot.appendingPathComponent("assets/pdfium.wasm")
            let workerURL = packagedRoot.appendingPathComponent("assets/pdfium-worker.js")
            guard let pdfium = try? Data(contentsOf: pdfiumURL),
                  let worker = try? Data(contentsOf: workerURL) else { return nil }
            return validate(pdfium: pdfium, worker: worker)
        }.value
    }

    static func validate(pdfium: Data, worker: Data) -> PackagedReviewAssets? {
        guard pdfium.count > 8, pdfium.count <= 16 * 1024 * 1024,
              pdfium.starts(with: Data([0x00, 0x61, 0x73, 0x6d])),
              !worker.isEmpty, worker.count <= 4 * 1024 * 1024,
              let source = String(data: worker, encoding: .utf8),
              source.contains("class PdfiumEngineRunner"),
              source.contains("type === \"wasmInit\"") else { return nil }
        return PackagedReviewAssets(pdfium: pdfium, worker: worker)
    }
}
