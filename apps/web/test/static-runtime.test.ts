import { describe, expect, it, vi } from "vitest";

import { addPageNote } from "../../../packages/core/src/review-commands.js";
import type { PdfWriter } from "../../../packages/core/src/pdf-writer.js";
import {
  STATIC_PDF_MAX_BYTES,
  createStaticHostRuntime,
  readStaticPdfFile,
  readStaticPdfUrl,
} from "../src/host/static-runtime.js";

const sourceBytes = new TextEncoder().encode("%PDF-1.7\n%%EOF");

describe("static browser review runtime", () => {
  it("opens a user-selected PDF as an export-only in-memory review", async () => {
    const write = vi.fn<PdfWriter["write"]>(async (request) => ({
      pdfBytes: Uint8Array.of(37, 80, 68, 70),
      evidence: {
        backend: "embedpdf",
        backendVersion: "test",
        originalSha256: request.sourceSha256,
        outputSha256: "b".repeat(64),
        pageCount: 1,
        structurallyValid: true,
        preexistingAnnotationIds: [],
        annotations: request.annotations.map(({ id, contents }) => ({
          id,
          subtype: "text",
          contents,
          flags: ["print"],
          hasNormalAppearance: true,
        })),
      },
    }));
    const writer: PdfWriter = {
      assess: async () => ({ eligible: true }),
      write,
    };
    const download = vi.fn();
    const revokeObjectURL = vi.fn();
    const runtime = await createStaticHostRuntime({
      source: { name: "notes.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer,
      digest: async () => "a".repeat(64),
      sessionId: "11111111-1111-4111-8111-111111111111",
      origin: "https://placekeeper.example",
      createObjectURL: () => "blob:https://placekeeper.example/source",
      revokeObjectURL,
      download,
    });

    const bootstrap = await runtime.bootstrap();
    expect(runtime.host).toBe("static");
    expect(bootstrap).toMatchObject({
      state: { revision: 0, items: [] },
      scope: {
        documentTitle: "notes.pdf",
        launchSurface: "static",
        persistenceMode: "export-only",
      },
      saveStatus: {
        destination: { phase: "none" },
        sync: { phase: "not-saved", savedRevision: -1 },
        rewriteEligibility: { eligible: true },
      },
      viewerAssets: {
        documentUrl: "blob:https://placekeeper.example/source",
        pdfiumWasm: "https://placekeeper.example/pdfium.wasm",
      },
      resourcePolicy: { host: "browser", origin: "https://placekeeper.example" },
    });

    const next = await runtime.command(addPageNote(
      bootstrap.state,
      0,
      { x: 40, y: 50, width: 18, height: 18 },
      "Check this claim.",
      {
        createId: () => "22222222-2222-4222-8222-222222222222",
        now: () => "2026-09-03T12:00:00.000Z",
      },
    ));
    expect(next).toMatchObject({ revision: 1, items: [{ kind: "pageNote" }] });
    await expect(runtime.saveStatus()).resolves.toMatchObject({
      sync: { phase: "not-saved", desiredRevision: 1, savedRevision: -1 },
    });

    await expect(runtime.exportReviewedCopy()).resolves.toEqual({
      kind: "reviewed-copy",
      path: "notes-reviewed.pdf",
      revision: 1,
      digest: "b".repeat(64),
    });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toMatchObject({
      sourceSha256: "a".repeat(64),
      revision: 1,
      annotations: [{
        id: "22222222-2222-4222-8222-222222222222",
        kind: "pageNote",
        contents: "Check this claim.",
      }],
    });
    expect(download).toHaveBeenCalledWith(
      Uint8Array.of(37, 80, 68, 70),
      "notes-reviewed.pdf",
    );

    runtime.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://placekeeper.example/source");
  });

  it("accepts only bounded PDF files with a real PDF header", async () => {
    await expect(readStaticPdfFile(new File([sourceBytes], "paper.pdf", {
      type: "application/pdf",
    }))).resolves.toEqual({ name: "paper.pdf", bytes: sourceBytes });

    await expect(readStaticPdfFile(new File(["not a pdf"], "paper.pdf", {
      type: "application/pdf",
    }))).rejects.toThrow("does not look like a PDF");

    const oversized = {
      name: "large.pdf",
      size: STATIC_PDF_MAX_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File;
    await expect(readStaticPdfFile(oversized)).rejects.toThrow("64 MB");
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });

  it("fetches only CORS-readable, bounded PDF URLs", async () => {
    const fetchPdf = vi.fn(async () => new Response(sourceBytes, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    await expect(readStaticPdfUrl(
      "https://papers.example/review%20copy.pdf?download=1",
      fetchPdf,
    )).resolves.toEqual({ name: "review copy.pdf", bytes: sourceBytes });
    expect(fetchPdf).toHaveBeenCalledWith(
      new URL("https://papers.example/review%20copy.pdf?download=1"),
      expect.objectContaining({ mode: "cors", credentials: "omit" }),
    );

    await expect(readStaticPdfUrl("file:///private/paper.pdf", fetchPdf))
      .rejects.toThrow("HTTP or HTTPS");
    await expect(readStaticPdfUrl("https://blocked.example/paper.pdf", async () => {
      throw new TypeError("Failed to fetch");
    })).rejects.toThrow("CORS");
    await expect(readStaticPdfUrl("https://papers.example/large.pdf", async () => (
      new Response(null, {
        status: 200,
        headers: { "content-length": String(STATIC_PDF_MAX_BYTES + 1) },
      })
    ))).rejects.toThrow("64 MB");
  });

  it("times out a remote PDF request that never settles", async () => {
    const fetchPdf = vi.fn(() => new Promise<Response>(() => undefined));

    await expect(readStaticPdfUrl(
      "https://papers.example/stalled.pdf",
      fetchPdf,
      5,
    )).rejects.toThrow("PDF request timed out");
    expect(fetchPdf).toHaveBeenCalledWith(
      new URL("https://papers.example/stalled.pdf"),
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("times out a stalled PDF writer without downloading a partial export", async () => {
    const writer: PdfWriter = {
      assess: async () => ({ eligible: true }),
      write: () => new Promise(() => undefined),
    };
    const download = vi.fn();
    const runtime = await createStaticHostRuntime({
      source: { name: "notes.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer,
      writerTimeoutMs: 5,
      digest: async () => "a".repeat(64),
      sessionId: "11111111-1111-4111-8111-111111111111",
      origin: "https://placekeeper.example",
      createObjectURL: () => "blob:https://placekeeper.example/source",
      revokeObjectURL: vi.fn(),
      download,
    });

    await expect(runtime.exportReviewedCopy()).rejects.toThrow("PDF export timed out");
    expect(download).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
