import { projectReviewItems } from "../../../../packages/core/src/annotation-projection.js";
import type {
  PdfRewriteEligibility,
  PdfWriter,
} from "../../../../packages/core/src/pdf-writer.js";
import { createReviewState, type ReviewState } from "../../../../packages/core/src/review-model.js";
import { reduceReview } from "../../../../packages/core/src/review-reducer.js";
import { createBrowserEmbedPdfWriter } from "../../../../packages/pdf-backends/src/browser-writer.js";
import type {
  ProductionExportResult,
  ProductionSaveStatus,
} from "../app/ProductionReviewApp.js";
import type { ViewerAssetUrls } from "../pdf/embedpdf-viewer.js";
import type { HostRuntime } from "./runtime.js";

export const STATIC_PDF_MAX_BYTES = 64 * 1024 * 1024;
const STATIC_PDF_FETCH_TIMEOUT_MS = 30_000;
const STATIC_PDF_EXPORT_TIMEOUT_MS = 60_000;

export interface StaticPdfSource {
  readonly name: string;
  readonly bytes: Uint8Array;
}

type StaticFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface StaticRuntimeDependencies {
  readonly writer?: PdfWriter;
  readonly digest?: (bytes: Uint8Array) => Promise<string>;
  readonly sessionId?: string;
  readonly origin?: string;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly download?: (bytes: Uint8Array, filename: string) => void;
  readonly writerTimeoutMs?: number;
}

class StaticOperationTimeoutError extends Error {}

async function waitWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      onTimeout?.();
      reject(new StaticOperationTimeoutError(message));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function reviewedCopyName(filename: string): string {
  const stem = filename.replace(/\.pdf$/iu, "") || "document";
  return `${stem}-reviewed.pdf`;
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function notSavedStatus(state: ReviewState, eligibility: PdfRewriteEligibility): ProductionSaveStatus {
  return {
    destination: { phase: "none", generation: 0 },
    sync: {
      phase: "not-saved",
      desiredRevision: state.revision,
      savedRevision: -1,
    },
    rewriteEligibility: eligibility,
  };
}

function validateStaticPdf(name: string, bytes: Uint8Array): StaticPdfSource {
  if (bytes.byteLength > STATIC_PDF_MAX_BYTES) {
    throw new Error("Choose a PDF no larger than 64 MB.");
  }
  if (bytes.byteLength === 0) throw new Error("The selected PDF is empty.");
  const header = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!header.includes("%PDF-")) {
    throw new Error("The selected file does not look like a PDF.");
  }
  return { name, bytes };
}

export async function readStaticPdfFile(file: File): Promise<StaticPdfSource> {
  if (file.size > STATIC_PDF_MAX_BYTES) {
    throw new Error("Choose a PDF no larger than 64 MB.");
  }
  return validateStaticPdf(
    file.name || "document.pdf",
    new Uint8Array(await file.arrayBuffer()),
  );
}

function remoteFilename(url: URL): string {
  const encoded = url.pathname.split("/").at(-1) || "document.pdf";
  try {
    return decodeURIComponent(encoded) || "document.pdf";
  } catch {
    return encoded;
  }
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > STATIC_PDF_MAX_BYTES) {
    throw new Error("Choose a PDF no larger than 64 MB.");
  }
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > STATIC_PDF_MAX_BYTES) {
      throw new Error("Choose a PDF no larger than 64 MB.");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > STATIC_PDF_MAX_BYTES) {
      await reader.cancel();
      throw new Error("Choose a PDF no larger than 64 MB.");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readStaticPdfUrl(
  rawUrl: string,
  fetchPdf: StaticFetch = fetch,
  timeoutMs = STATIC_PDF_FETCH_TIMEOUT_MS,
): Promise<StaticPdfSource> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a complete PDF URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PDF URLs must use HTTP or HTTPS.");
  }
  const controller = new AbortController();
  try {
    return await waitWithin((async () => {
      let response: Response;
      try {
        response = await fetchPdf(url, {
          mode: "cors",
          credentials: "omit",
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new Error("That PDF host did not allow cross-origin browser access (CORS).");
      }
      if (!response.ok) throw new Error(`The PDF request failed with status ${response.status}.`);
      return validateStaticPdf(remoteFilename(url), await boundedResponseBytes(response));
    })(), timeoutMs, "The PDF request timed out. Try downloading it and uploading the file instead.", () => {
      controller.abort();
    });
  } catch (error) {
    if (error instanceof StaticOperationTimeoutError || isAbortError(error)) {
      throw new Error("The PDF request timed out. Try downloading it and uploading the file instead.");
    }
    throw error;
  }
}

export async function createStaticHostRuntime(
  input: {
    readonly source: StaticPdfSource;
    readonly viewerAssets: Omit<ViewerAssetUrls, "documentUrl">;
  },
  dependencies: StaticRuntimeDependencies = {},
): Promise<HostRuntime> {
  const [digest, writer] = await Promise.all([
    (dependencies.digest ?? sha256)(input.source.bytes),
    dependencies.writer === undefined
      ? createBrowserEmbedPdfWriter(input.viewerAssets.pdfiumWasm)
      : Promise.resolve(dependencies.writer),
  ]);
  const eligibility = writer.assess === undefined
    ? { eligible: true } as const
    : await writer.assess(input.source.bytes);
  const sessionId = dependencies.sessionId ?? crypto.randomUUID();
  const createObjectURL = dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL = dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const documentUrl = createObjectURL(new Blob(
    [toArrayBuffer(input.source.bytes)],
    { type: "application/pdf" },
  ));
  const origin = dependencies.origin ?? globalThis.location.origin;
  const download = dependencies.download ?? downloadBytes;
  const writerTimeoutMs = dependencies.writerTimeoutMs ?? STATIC_PDF_EXPORT_TIMEOUT_MS;
  let state = createReviewState({
    sessionId,
    source: {
      fileId: digest,
      digest,
      byteLength: input.source.bytes.byteLength,
    },
  });
  let disposed = false;
  let lastExportedRevision = 0;

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (state.revision <= lastExportedRevision) return;
    event.preventDefault();
  };
  globalThis.addEventListener?.("beforeunload", beforeUnload);

  const runtime: HostRuntime = {
    host: "static",
    async bootstrap() {
      return {
        sessionId,
        generation: state.workflow.documentGeneration,
        revision: state.revision,
        session: { sessionId },
        state,
        scope: {
          documentTitle: input.source.name,
          sourceDisposition: "local",
          launchSurface: "static",
          persistenceMode: "export-only",
        },
        saveStatus: notSavedStatus(state, eligibility),
        viewerAssets: { ...input.viewerAssets, documentUrl },
        resourcePolicy: { host: "browser", origin },
      };
    },
    subscribeInvalidations: () => () => undefined,
    async command(command) {
      if (disposed) throw new Error("This review is closed.");
      state = reduceReview(state, command);
      return state;
    },
    async saveStatus() {
      return notSavedStatus(state, eligibility);
    },
    async saveProposal() {
      return { sourceDisposition: "local", filename: reviewedCopyName(input.source.name), folder: "" };
    },
    async chooseCopy() {
      return notSavedStatus(state, eligibility);
    },
    async chooseFolder() {
      return { cancelled: true };
    },
    async chooseOriginal() {
      return notSavedStatus(state, eligibility);
    },
    async retrySave() {
      return notSavedStatus(state, eligibility);
    },
    async locateSave() {
      return notSavedStatus(state, eligibility);
    },
    async exportReviewedCopy(): Promise<ProductionExportResult> {
      if (disposed) throw new Error("This review is closed.");
      if (!eligibility.eligible) throw new Error(eligibility.message);
      const exportState = state;
      const output = await waitWithin(writer.write({
        sourcePdf: input.source.bytes,
        sourceSha256: digest,
        revision: exportState.revision,
        annotations: projectReviewItems(
          exportState.items,
          exportState.workflow.documentGeneration,
        ),
      }), writerTimeoutMs, "PDF export timed out. Try again.");
      const filename = reviewedCopyName(input.source.name);
      download(output.pdfBytes, filename);
      lastExportedRevision = Math.max(lastExportedRevision, exportState.revision);
      return {
        kind: "reviewed-copy",
        path: filename,
        revision: exportState.revision,
        digest: output.evidence.outputSha256,
      };
    },
    async scope() {
      return {
        documentTitle: input.source.name,
        sourceDisposition: "local",
        launchSurface: "static",
        persistenceMode: "export-only",
      };
    },
    async forwardSyncTex() {
      throw new Error("SyncTeX is unavailable in the static browser edition.");
    },
    async reverseSyncTex() {
      throw new Error("SyncTeX is unavailable in the static browser edition.");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.removeEventListener?.("beforeunload", beforeUnload);
      revokeObjectURL(documentUrl);
    },
  };
  return runtime;
}
