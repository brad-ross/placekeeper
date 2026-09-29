import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { addPageNote, setAnnotationName } from "../../../packages/core/src/review-commands.js";
import type { PdfWriter } from "../../../packages/core/src/pdf-writer.js";
import type { ReviewItem } from "../../../packages/core/src/review-model.js";
import { createBrowserDocumentSession } from "../../../packages/pdf-backends/src/browser-document-session.js";
import {
  STATIC_PDF_MAX_BYTES,
  createStaticHostRuntime,
  isStaticOperationCancelled,
  readStaticPdfFile,
  readStaticPdfUrl,
} from "../src/host/static-runtime.js";
import { StaticLauncher } from "../src/static-entry.js";

const sourceBytes = new TextEncoder().encode("%PDF-1.7\n%%EOF");

describe("static browser review runtime", () => {
  it("reimports an exported Review Item as clean editable state", async () => {
    const imported: ReviewItem = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "pageNote",
      importedAnnotationAuthor: "Brad Ross",
      pageIndex: 0,
      createdAt: "2026-09-03T12:00:00.000Z",
      updatedAt: "2026-09-03T12:00:00.000Z",
      payload: {
        position: { x: 40, y: 50, width: 18, height: 18 },
        comment: "Imported note",
      },
    };
    const writer = {
      assess: vi.fn(async () => ({ eligible: true as const })),
      inspect: vi.fn(async () => ({
        portableItems: [imported],
        ownedProjections: [{ pageIndex: 0, annotationId: imported.id }],
      })),
      write: vi.fn<PdfWriter["write"]>(async (request) => ({
        pdfBytes: sourceBytes,
        evidence: {
          coverage: "owned-output" as const,
          backend: "embedpdf" as const,
          backendVersion: "test",
          originalSha256: request.sourceSha256,
          outputSha256: "b".repeat(64),
          pageCount: 1,
          structurallyValid: true,
          annotations: [],
        },
      })),
    };
    const runtime = await createStaticHostRuntime({
      source: { name: "notes-reviewed.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer,
      digest: async () => "a".repeat(64),
      createObjectURL: () => "blob:source",
      revokeObjectURL: vi.fn(),
      download: vi.fn(),
    });

    const bootstrap = await runtime.bootstrap();
    expect(runtime.capabilities).toEqual({ localDocumentRefresh: false });
    expect(bootstrap.state).toMatchObject({
      revision: 0,
      annotationName: "Brad Ross",
      history: [],
      historyCursor: 0,
      items: [imported],
    });
    expect(bootstrap.saveStatus.sync).toMatchObject({
      desiredRevision: 0,
      savedRevision: 0,
    });
    expect(writer.inspect).toHaveBeenCalledWith(sourceBytes);
    runtime.dispose();
  });

  it("rejects an annotation that exceeds metadata bounds with the confirmed name", async () => {
    const runtime = await createStaticHostRuntime({
      source: { name: "notes.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer: { assess: async () => ({ eligible: true }), write: vi.fn() },
      digest: async () => "a".repeat(64), createObjectURL: () => "blob:source",
      revokeObjectURL: vi.fn(), download: vi.fn(),
    });
    const initial = (await runtime.bootstrap()).state;
    await runtime.command(setAnnotationName(initial, "y".repeat(16_384)));
    const named = (await runtime.bootstrap()).state;
    await expect(runtime.command(addPageNote(named, 0,
      { x: 40, y: 50, width: 18, height: 18 }, "x".repeat(16_384), {
        createId: () => "22222222-2222-4222-8222-222222222222",
        now: () => "2026-09-03T12:00:00.000Z",
      }))).rejects.toThrow(/too much/i);
    expect((await runtime.bootstrap()).state).toEqual(named);
    await expect(runtime.command(setAnnotationName(initial, "Stale"))).rejects.toThrow(/revision/i);
    runtime.dispose();
  });

  it("showcases the reading surfaces while keeping PDF opening and manual export explicit", () => {
    const markup = renderToStaticMarkup(createElement(StaticLauncher, {
      onOpen: async () => undefined,
    }));
    expect(markup).toContain('<img class="static-launcher__mark"');
    expect(markup).toContain("Placekeeper.svg");
    expect(markup).toContain('alt=""');
    expect(markup).toMatch(/<img class="static-launcher__mark"[^>]*width="96"[^>]*height="96"/);
    expect(markup).not.toContain('aria-hidden="true">P</div>');
    expect(markup).toContain("Upload PDF");
    expect(markup).toContain('aria-label="Document URL"');
    expect(markup).not.toContain(">Document URL<");
    expect(markup).toContain("lucide-upload");
    expect(markup).toContain("lucide-link");
    expect(markup).toContain(">Open</button>");
    expect(markup).not.toContain("Open URL");
    expect(markup).toContain('id="try"');
    expect(markup).toContain('aria-label="Explore features"');
    expect(markup).toContain("Read with focus");
    expect(markup).toContain("Make comments");
    expect(markup).toContain("Follow references");
    expect(markup).toContain('title="Read with focus interactive demo"');
    expect(markup).toContain('sandbox="allow-scripts allow-same-origin allow-forms"');
    expect(markup).toContain('aria-label="Placekeeper app surfaces"');
    expect(markup).toContain('Install');
    expect(markup).not.toContain('Follow the thought.');
    expect(markup).toContain("Symbol search");
    expect(markup).not.toContain("Reset demo");
    expect(markup).not.toContain("Sample document ·");
    expect(markup).not.toContain("Annotations must be exported manually");
    expect(markup).toContain("or drop a PDF here");
    expect(markup).toContain("Keep up with changes");
    expect(markup).not.toContain("Fit to width");
    expect(markup).not.toContain("64 MB maximum");
    expect(markup).not.toContain("CORS");
    expect(markup.indexOf("Upload PDF")).toBeLessThan(markup.indexOf('aria-label="Document URL"'));
  });

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

    await expect(runtime.exportReviewedCopy()).resolves.toMatchObject({
      kind: "reviewed-copy",
      path: "notes-reviewed.pdf",
      revision: 1,
      digest: "b".repeat(64),
      warning: expect.stringMatching(/other PDF content was not comprehensively checked/i),
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

  it("fetches only CORS-readable, bounded Document URLs", async () => {
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
      expect.objectContaining({
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );

    await expect(readStaticPdfUrl("file:///private/paper.pdf", fetchPdf))
      .rejects.toThrow("HTTPS");
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

  it.each([
    "http://papers.example/paper.pdf",
    "https://reader:secret@papers.example/paper.pdf",
    "https://localhost/paper.pdf",
    "https://notes.local/paper.pdf",
    "https://127.0.0.1/paper.pdf",
    "https://2130706433/paper.pdf",
    "https://10.1.2.3/paper.pdf",
    "https://172.20.1.2/paper.pdf",
    "https://192.168.1.2/paper.pdf",
    "https://169.254.1.2/paper.pdf",
    "https://[::1]/paper.pdf",
    "https://[::ffff:127.0.0.1]/paper.pdf",
    "https://[::ffff:10.0.0.1]/paper.pdf",
    "https://[::ffff:7f00:1]/paper.pdf",
    "https://[::ffff:a00:1]/paper.pdf",
    "https://[fd00::1]/paper.pdf",
    "https://[fe80::1]/paper.pdf",
  ])("rejects unsafe deployed remote target %s without making a request", async (rawUrl) => {
    const fetchPdf = vi.fn();
    await expect(readStaticPdfUrl(rawUrl, fetchPdf, {
      currentUrl: "https://brad-ross.github.io/placekeeper/",
    })).rejects.toThrow();
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("allows HTTP loopback only when the app itself is running on loopback", async () => {
    const fetchPdf = vi.fn(async () => new Response(sourceBytes, { status: 200 }));
    await expect(readStaticPdfUrl("http://127.0.0.1:8080/paper.pdf", fetchPdf, {
      currentUrl: "http://127.0.0.1:4174/",
    })).resolves.toMatchObject({ name: "paper.pdf" });
    await expect(readStaticPdfUrl("http://127.0.0.1:8080/paper.pdf", fetchPdf, {
      currentUrl: "https://brad-ross.github.io/placekeeper/",
    })).rejects.toThrow("HTTPS");
  });

  it("rejects redirects and redacts the submitted URL from failures", async () => {
    const secretUrl = "https://papers.example/private.pdf?token=do-not-repeat";
    const redirected = new Response(sourceBytes, { status: 200 });
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(readStaticPdfUrl(secretUrl, async () => redirected)).rejects.toThrow("redirect");

    const failure = await readStaticPdfUrl(secretUrl, async () => {
      throw new TypeError("request included token=do-not-repeat");
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("do-not-repeat");
  });

  it("cancels remote acquisition distinctly from a timeout", async () => {
    const controller = new AbortController();
    const fetchPdf = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })
    ));
    const pending = readStaticPdfUrl(
      "https://papers.example/paper.pdf",
      fetchPdf,
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    controller.abort();
    const error = await pending.catch((cause: unknown) => cause);
    expect(isStaticOperationCancelled(error)).toBe(true);
    expect((error as Error).message).toBe("Opening was cancelled.");
  });

  it("times out a remote PDF request that never settles", async () => {
    const fetchPdf = vi.fn(() => new Promise<Response>(() => undefined));

    await expect(readStaticPdfUrl(
      "https://papers.example/stalled.pdf",
      fetchPdf,
      { timeoutMs: 5 },
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

  it("keeps unsupported input out of authoring and disposes its backend", async () => {
    const dispose = vi.fn();
    const writer = {
      assess: vi.fn(async () => ({
        eligible: false as const,
        code: "encrypted" as const,
        message: "This encrypted PDF cannot be annotated safely.",
      })),
      write: vi.fn(),
      dispose,
    };
    const createObjectURL = vi.fn();
    await expect(createStaticHostRuntime({
      source: { name: "locked.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer,
      startupTimeoutMs: 100,
      digest: async () => "a".repeat(64),
      createObjectURL,
    })).rejects.toThrow("encrypted PDF");
    expect(dispose).toHaveBeenCalledOnce();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("admits one backend operation and fences a late result after disposal", async () => {
    const write = Promise.withResolvers<Awaited<ReturnType<PdfWriter["write"]>>>();
    const writer: PdfWriter & { dispose(): void } = {
      assess: async () => ({ eligible: true }),
      write: () => write.promise,
      dispose: vi.fn(),
    };
    const session = createBrowserDocumentSession({
      createWriter: async () => writer,
      operationTimeoutMs: 1_000,
    });
    const request = {
      sourcePdf: sourceBytes,
      sourceSha256: "a".repeat(64),
      revision: 0,
      annotations: [],
    };
    const first = session.write(request);
    await expect(session.write(request)).rejects.toThrow("already in progress");
    const disposal = session.dispose();
    write.resolve({
      pdfBytes: sourceBytes,
      evidence: {
        backend: "embedpdf",
        backendVersion: "test",
        originalSha256: request.sourceSha256,
        outputSha256: "b".repeat(64),
        pageCount: 1,
        structurallyValid: true,
        preexistingAnnotationIds: [],
        annotations: [],
      },
    });
    await disposal;
    await expect(first).rejects.toThrow("cancelled");
    expect(writer.dispose).toHaveBeenCalledOnce();
  });

  it("registers the unload guard only while edits are newer than the export checkpoint", async () => {
    const listeners = new Map<string, EventListener>();
    const lifecycle = {
      addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    const writer: PdfWriter = {
      assess: async () => ({ eligible: true }),
      write: async (request) => ({
        pdfBytes: sourceBytes,
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
      }),
    };
    const runtime = await createStaticHostRuntime({
      source: { name: "notes.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer,
      digest: async () => "a".repeat(64),
      createObjectURL: () => "blob:source",
      revokeObjectURL: vi.fn(),
      download: vi.fn(),
      lifecycle,
    });
    expect(lifecycle.addEventListener).not.toHaveBeenCalled();
    const bootstrap = await runtime.bootstrap();
    await runtime.command(addPageNote(
      bootstrap.state,
      0,
      { x: 40, y: 50, width: 18, height: 18 },
      "Review",
      {
        createId: () => "22222222-2222-4222-8222-222222222222",
        now: () => "2026-09-03T12:00:00.000Z",
      },
    ));
    expect(lifecycle.addEventListener).toHaveBeenCalledOnce();
    expect(listeners.has("beforeunload")).toBe(true);
    await runtime.exportReviewedCopy();
    expect(lifecycle.removeEventListener).toHaveBeenCalledOnce();
    expect(listeners.has("beforeunload")).toBe(false);
    runtime.dispose();
  });

  it("exports a snapshot without clearing a newer edit and reports the limited check", async () => {
    const pendingWrite = Promise.withResolvers<Awaited<ReturnType<PdfWriter["write"]>>>();
    const writer: PdfWriter = {
      assess: async () => ({ eligible: true }),
      write: vi.fn(() => pendingWrite.promise),
    };
    const download = vi.fn();
    const runtime = await createStaticHostRuntime({
      source: { name: "notes.pdf", bytes: sourceBytes },
      viewerAssets: { pdfiumWasm: "https://placekeeper.example/pdfium.wasm" },
    }, {
      writer,
      digest: async () => "a".repeat(64),
      createObjectURL: () => "blob:source",
      revokeObjectURL: vi.fn(),
      download,
    });
    const bootstrap = await runtime.bootstrap();
    const firstState = await runtime.command(addPageNote(
      bootstrap.state,
      0,
      { x: 40, y: 50, width: 18, height: 18 },
      "First",
      {
        createId: () => "22222222-2222-4222-8222-222222222222",
        now: () => "2026-09-03T12:00:00.000Z",
      },
    ));
    const added = "accepted" in firstState ? firstState.state : firstState;
    const named = await runtime.command(setAnnotationName(added, "Brad Ross"));
    const acknowledged = "accepted" in named ? named.state : named;
    const fence = { expectedRevision: acknowledged.revision, documentGeneration: acknowledged.workflow.documentGeneration };
    const other = await runtime.command(setAnnotationName(acknowledged, "Other Window"));
    await expect(runtime.exportReviewedCopy(undefined, fence)).rejects.toThrow("Review changed");
    expect(writer.write).not.toHaveBeenCalled();
    const retry = await runtime.command(setAnnotationName("accepted" in other ? other.state : other, "Brad Ross"));
    const retryState = "accepted" in retry ? retry.state : retry;
    await expect(runtime.exportReviewedCopy(undefined, {
      expectedRevision: retryState.revision, documentGeneration: retryState.workflow.documentGeneration + 1,
    })).rejects.toThrow("Review changed");
    const exporting = runtime.exportReviewedCopy(undefined, {
      expectedRevision: retryState.revision, documentGeneration: retryState.workflow.documentGeneration,
    });
    await runtime.command(setAnnotationName(retryState, "Later Name"));
    pendingWrite.resolve({
      pdfBytes: sourceBytes,
      evidence: {
        backend: "embedpdf",
        backendVersion: "test",
        originalSha256: "a".repeat(64),
        outputSha256: "b".repeat(64),
        pageCount: 1,
        structurallyValid: true,
        preexistingAnnotationIds: [],
        annotations: [],
      },
    });
    await expect(exporting).resolves.toMatchObject({
      revision: 4,
      warning: expect.stringMatching(/copy opens.*not comprehensively checked.*newer edits/i),
    });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      revision: 4, annotations: [expect.objectContaining({ author: "Brad Ross" })],
    }));
    expect(download).toHaveBeenCalledOnce();
    await expect(runtime.saveStatus()).resolves.toMatchObject({
      sync: { desiredRevision: 5, savedRevision: 4 },
    });
    runtime.dispose();
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
