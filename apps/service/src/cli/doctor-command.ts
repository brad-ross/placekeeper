import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { inspectPdfWithEmbedPdf } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";

const EXPECTED_PDFIUM_SHA256 = "c0af5a6aca30d7e54a149c3a68e317116ca906d6edc28fd3318b12c7d9478ac8";
const MAX_FIXTURE_BYTES = 128 * 1024 * 1024;

function pdfArgument(args: readonly string[]): string {
  if (
    args.length !== 6 ||
    args[0] !== "doctor" ||
    args[1] !== "--json" ||
    args[2] !== "--offline" ||
    args[3] !== "--writer" ||
    args[4] !== "--pdf" ||
    args[5] === undefined ||
    !isAbsolute(args[5])
  ) {
    throw new Error("Invalid doctor invocation");
  }
  return args[5];
}

/** Content-free, machine-readable proof that the packaged offline writer opens a PDF. */
export async function runDoctorCommand(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  try {
    const pdfPath = pdfArgument(args);
    const wasmPath = process.env.PDF_PROOFREADER_PDFIUM_WASM;
    if (wasmPath === undefined || !isAbsolute(wasmPath)) throw new Error("PDFium unavailable");
    const wasm = await readFile(wasmPath);
    const pdfiumSha256 = createHash("sha256").update(wasm).digest("hex");
    if (pdfiumSha256 !== EXPECTED_PDFIUM_SHA256) throw new Error("PDFium mismatch");

    const info = await stat(pdfPath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_FIXTURE_BYTES) {
      throw new Error("Fixture unavailable");
    }
    const inspected = await inspectPdfWithEmbedPdf(new Uint8Array(await readFile(pdfPath)));
    if (!Number.isSafeInteger(inspected.pageCount) || inspected.pageCount <= 0) {
      throw new Error("Invalid structure");
    }
    write(`${JSON.stringify({
      ok: true,
      offline: true,
      writer: "embedpdf-node-pdfium",
      nodeVersion: process.versions.node,
      pdfiumSha256,
      pages: inspected.pageCount,
      structurallyValid: true,
    })}\n`);
    return 0;
  } catch {
    write(`${JSON.stringify({ ok: false, error: "writer-unavailable" })}\n`);
    return 2;
  }
}
