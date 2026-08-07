import type { PdfWriter } from "../../core/src/pdf-writer.js";
import { createEmbedPdfWriter } from "./embedpdf-adapter.js";

export const selectedWriterRuntime = Object.freeze({
  backend: "embedpdf" as const,
  version: "2.14.4",
});

export async function createSelectedPdfWriter(): Promise<PdfWriter> {
  return createEmbedPdfWriter();
}
