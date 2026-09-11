import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildPackagedPdfiumWorkerSource, extractPinnedPdfiumWorkerSource } from "./pdfium-worker-source.js";
import { emitPdfiumAssets, loadPinnedPdfiumWorkerSource } from "./pdfium-assets.js";
import { offlinePdfium } from "../../apps/web/vite.production.config.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

const worker = 'class PdfiumEngineRunner {}\nif (type === "wasmInit") {}';
const inline = (source: string) => `URL.createObjectURL(new Blob([${JSON.stringify(source)}], { type: "application/javascript" }))`;

describe("pinned PDFium worker", () => {
  it("extracts the literal without executing surrounding package code", () => {
    expect(extractPinnedPdfiumWorkerSource(`throw new Error("must not execute");${inline(worker + '\n// quotes: " \\')}`)).toBe(worker + '\n// quotes: " \\');
  });

  it.each([
    ["", "must contain exactly one inline PDFium worker"],
    [inline(worker) + inline(worker), "must contain exactly one inline PDFium worker"],
    ['URL.createObjectURL(new Blob([123', "worker source did not begin with a string literal"],
    ['URL.createObjectURL(new Blob(["unfinished', "worker source string was unterminated"],
    [inline(worker).replace("application/javascript", "text/javascript"), "inline worker shape changed"],
    [inline("class DifferentRunner {}"), "PDFium worker signature changed"],
  ])("rejects incompatible engine source: %s", (source, diagnostic) => {
    expect(() => extractPinnedPdfiumWorkerSource(source)).toThrow(`EmbedPDF 2.14.4 ${diagnostic}`);
  });

  it("preserves the pinned package worker and packaged privilege bootstrap bytes", () => {
    const raw = extractPinnedPdfiumWorkerSource(readFileSync("node_modules/@embedpdf/engines/dist/lib/pdfium/web/worker-engine.js", "utf8"));
    const packaged = buildPackagedPdfiumWorkerSource(raw);
    expect(packaged.endsWith(`\n${raw}\n`)).toBe(true);
    expect(createHash("sha256").update(packaged).digest("hex")).toBe("4463487ece74309901036d06584c7296509eba9b26ff67d9154e32dfc8d04b5a");
  });

  it("rejects an unpinned engine with the existing production diagnostic", () => {
    vi.mocked(readFileSync).mockReturnValueOnce('{"version":"0.0.0"}');
    expect(() => offlinePdfium()).toThrow("Shared PDFium worker requires @embedpdf/engines 2.14.4");
  });
});


describe("PDFium asset mechanisms", () => {
  it.each(["Shared", "Mac", "Static"])("retains the %s host's engine-version diagnostic", (host) => {
    const diagnostic = `${host} PDFium worker requires @embedpdf/engines 2.14.4`;
    vi.mocked(readFileSync).mockReturnValueOnce('{"version":"0.0.0"}');
    expect(() => loadPinnedPdfiumWorkerSource(diagnostic)).toThrow(diagnostic);
  });

  it.each([
    [{ fileName: "pdfium.wasm" }, { fileName: "pdfium-worker.js" }],
    [{ fileName: "assets/pdfium.wasm" }, { fileName: "assets/pdfium-worker.js" }],
    [{ name: "pdfium.wasm" }, { name: "pdfium-worker.js" }],
  ])("emits unchanged WASM and the host-provided worker under host-selected names", (wasm, workerName) => {
    const emitFile = vi.fn().mockReturnValueOnce("wasm-reference").mockReturnValueOnce("worker-reference");
    expect(emitPdfiumAssets({ emitFile }, { wasm, worker: workerName, workerSource: worker })).toEqual({
      wasmReference: "wasm-reference", workerReference: "worker-reference",
    });
    const wasmAsset = emitFile.mock.calls[0]?.[0];
    expect(wasmAsset).toMatchObject({ type: "asset", ...wasm });
    expect(createHash("sha256").update(wasmAsset.source).digest("hex")).toBe("c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8");
    expect(emitFile.mock.calls[1]?.[0]).toEqual({ type: "asset", ...workerName, source: worker });
  });
});
