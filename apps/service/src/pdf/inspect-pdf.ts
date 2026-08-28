import { isAbsolute } from "node:path";

import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { Rotation, type PdfDocumentObject } from "@embedpdf/models";
import { init } from "@embedpdf/pdfium";

export type PdfPageEvidenceRequest = {
  readonly kind: "page-text" | "page-layout" | "page-render";
  readonly pageIndex: number;
};

export interface InspectedPdfPageEvidence {
  readonly mediaType: string;
  readonly bytes: Buffer;
}

export interface InspectedPdfPageText {
  readonly pageIndex: number;
  readonly text: string;
  readonly geometry: readonly InspectedPdfTextGeometryRun[];
}

export interface InspectedPdfGlyphGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface InspectedPdfTextGeometryRun {
  readonly charStart: number;
  readonly glyphs: readonly InspectedPdfGlyphGeometry[];
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

async function createEngine(): Promise<PdfiumNative> {
  const configuredWasm = process.env.PLACEKEEPER_PDFIUM_WASM;
  if (configuredWasm !== undefined && !isAbsolute(configuredWasm)) {
    throw new Error("The packaged PDFium runtime path must be absolute");
  }
  const module = await init(
    configuredWasm === undefined
      ? {}
      : { locateFile: (path: string) => path.endsWith(".wasm") ? configuredWasm : path },
  );
  return new PdfiumNative(module, { fontFallback: null });
}

function pageAt(document: PdfDocumentObject, pageIndex: number) {
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new RangeError("pageIndex must be a non-negative safe integer");
  }
  const page = document.pages[pageIndex];
  if (page === undefined) throw new RangeError("pageIndex is outside the document");
  return page;
}

/**
 * Extracts one truthful page evidence representation. Rendering stays as raw
 * RGBA JSON so no lossy image encoder is introduced; the document evidence
 * operation remains available when the generic PDF capability needs its own
 * renderer or an unsupported structural detail.
 */
export async function inspectPdfPageEvidence(
  bytes: Uint8Array,
  request: PdfPageEvidenceRequest,
): Promise<InspectedPdfPageEvidence> {
  const engine = await createEngine();
  let document: PdfDocumentObject | undefined;
  try {
    document = await engine.openDocumentBuffer({
      id: "live-context-evidence",
      content: toArrayBuffer(bytes),
    }).toPromise();
    const page = pageAt(document, request.pageIndex);
    if (request.kind === "page-text") {
      const text = await engine.extractText(document, [request.pageIndex]).toPromise();
      return {
        mediaType: "text/plain; charset=utf-8",
        bytes: Buffer.from(text, "utf8"),
      };
    }
    if (request.kind === "page-layout") {
      const [geometry, textRuns] = await Promise.all([
        engine.getPageGeometry(document, page).toPromise(),
        engine.getPageTextRuns(document, page).toPromise(),
      ]);
      return {
        mediaType: "application/json",
        bytes: Buffer.from(JSON.stringify({
          pageIndex: request.pageIndex,
          page: { size: page.size, rotation: page.rotation, boxes: page.boxes ?? null },
          geometry,
          textRuns,
        })),
      };
    }
    const rendered = await engine.renderPageRaw(document, page, {
      scaleFactor: 1,
      dpr: 1,
      rotation: Rotation.Degree0,
      withAnnotations: true,
      withForms: true,
      transparentBackground: false,
    }).toPromise();
    const rgba = Buffer.from(
      rendered.data.buffer,
      rendered.data.byteOffset,
      rendered.data.byteLength,
    );
    return {
      mediaType: "application/vnd.placekeeper.rgba+json",
      bytes: Buffer.from(JSON.stringify({
        pageIndex: request.pageIndex,
        width: rendered.width,
        height: rendered.height,
        colorSpace: rendered.colorSpace ?? "srgb",
        encoding: "base64",
        rgba: rgba.toString("base64"),
      })),
    };
  } finally {
    if (document !== undefined) {
      await engine.closeDocument(document).toPromise().catch(() => false);
    }
    await engine.destroy().toPromise();
  }
}

/** Extracts every page's text while sharing one PDFium engine/document open. */
export async function inspectPdfPageTexts(bytes: Uint8Array): Promise<readonly InspectedPdfPageText[]> {
  const engine = await createEngine();
  let document: PdfDocumentObject | undefined;
  try {
    document = await engine.openDocumentBuffer({
      id: "generation-anchor-reconciliation",
      content: toArrayBuffer(bytes),
    }).toPromise();
    const pages: InspectedPdfPageText[] = [];
    for (let pageIndex = 0; pageIndex < document.pageCount; pageIndex += 1) {
      const page = pageAt(document, pageIndex);
      const [text, geometry] = await Promise.all([
        engine.extractText(document, [pageIndex]).toPromise(),
        engine.getPageGeometry(document, page).toPromise(),
      ]);
      pages.push({
        pageIndex,
        text,
        geometry: geometry.runs.map((run) => ({
          charStart: run.charStart,
          glyphs: run.glyphs.map((glyph) => ({
            x: glyph.x,
            y: glyph.y,
            width: glyph.width,
            height: glyph.height,
          })),
        })),
      });
    }
    return pages;
  } finally {
    if (document !== undefined) {
      await engine.closeDocument(document).toPromise().catch(() => false);
    }
    await engine.destroy().toPromise();
  }
}
