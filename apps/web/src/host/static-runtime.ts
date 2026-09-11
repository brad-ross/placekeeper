import type { SaveStatus } from "../../../../packages/core/src/save-status.js";
import { projectReviewItems } from "../../../../packages/core/src/annotation-projection.js";
import type {
  PdfRewriteEligibility,
  PdfWriteResult,
} from "../../../../packages/core/src/pdf-writer.js";
import { assertPortableAnnotationWritable, createImportedReviewState } from "../../../../packages/core/src/portable-annotation.js";
import type { ReviewState } from "../../../../packages/core/src/review-model.js";
import { reduceReview } from "../../../../packages/core/src/review-reducer.js";
import { createBrowserEmbedPdfWriter } from "../../../../packages/pdf-backends/src/browser-writer.js";
import {
  BrowserDocumentSessionError,
  createBrowserDocumentSession,
  type BrowserDocumentSession,
  type DisposablePdfWriter,
} from "../../../../packages/pdf-backends/src/browser-document-session.js";
import type {
  ProductionExportResult,
} from "./session-contracts.js";
import type { ViewerAssetUrls } from "../pdf/embedpdf-viewer.js";
import type { HostRuntime } from "./runtime.js";

export const STATIC_PDF_MAX_BYTES = 64 * 1024 * 1024;
const STATIC_PDF_FETCH_TIMEOUT_MS = 30_000;
const STATIC_PDF_STARTUP_TIMEOUT_MS = 30_000;
const STATIC_PDF_EXPORT_TIMEOUT_MS = 60_000;

export interface StaticPdfSource {
  readonly name: string;
  readonly bytes: Uint8Array;
}

type StaticFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StaticPdfReadOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly currentUrl?: string;
}

interface StaticLifecycleTarget {
  addEventListener(type: "beforeunload", listener: EventListener): void;
  removeEventListener(type: "beforeunload", listener: EventListener): void;
}

interface StaticRuntimeDependencies {
  readonly writer?: DisposablePdfWriter;
  readonly documentSession?: BrowserDocumentSession;
  readonly digest?: (bytes: Uint8Array) => Promise<string>;
  readonly sessionId?: string;
  readonly origin?: string;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
  readonly download?: (bytes: Uint8Array, filename: string) => void;
  readonly writerTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly lifecycle?: StaticLifecycleTarget;
}

class StaticOperationTimeoutError extends Error {}
class StaticOperationCancelledError extends Error {
  constructor() {
    super("Opening was cancelled.");
    this.name = "AbortError";
  }
}

export function isStaticOperationCancelled(error: unknown): boolean {
  return error instanceof StaticOperationCancelledError
    || (error instanceof BrowserDocumentSessionError && error.code === "cancelled");
}

async function waitWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
  signal?: AbortSignal,
  onCancel?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelListener: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      onTimeout?.();
      reject(new StaticOperationTimeoutError(message));
    }, timeoutMs);
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return;
    cancelListener = () => {
      onCancel?.();
      reject(new StaticOperationCancelledError());
    };
    if (signal.aborted) cancelListener();
    else signal.addEventListener("abort", cancelListener, { once: true });
  });
  try {
    return await Promise.race([operation, timeout, cancelled]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (cancelListener !== undefined) signal?.removeEventListener("abort", cancelListener);
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
  const stem = safePdfFilename(filename).replace(/\.pdf$/iu, "") || "document";
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

function notSavedStatus(
  state: ReviewState,
  eligibility: PdfRewriteEligibility,
  lastExportedRevision: number,
): SaveStatus {
  return {
    destination: { phase: "none", generation: 0 },
    sync: {
      phase: "not-saved",
      desiredRevision: state.revision,
      savedRevision: lastExportedRevision,
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

export async function readStaticPdfFile(
  file: File,
  signal?: AbortSignal,
): Promise<StaticPdfSource> {
  if (signal?.aborted) throw new StaticOperationCancelledError();
  if (file.size > STATIC_PDF_MAX_BYTES) {
    throw new Error("Choose a PDF no larger than 64 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (signal?.aborted) throw new StaticOperationCancelledError();
  return validateStaticPdf(
    safePdfFilename(file.name),
    bytes,
  );
}

function safePdfFilename(filename: string): string {
  const leaf = filename
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .split(/[\\/]/u)
    .at(-1)
    ?.trim();
  const safe = leaf?.replace(/[^\p{L}\p{N}._()\[\] -]+/gu, "-")
    .replace(/^\.+$/u, "")
    .slice(0, 160);
  return safe || "document.pdf";
}

function remoteFilename(url: URL): string {
  const encoded = url.pathname.split("/").at(-1) || "document.pdf";
  try {
    return safePdfFilename(decodeURIComponent(encoded));
  } catch {
    return safePdfFilename(encoded);
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/gu, "").toLowerCase().replace(/\.$/u, "");
}

function ipv4Parts(hostname: string): readonly number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return undefined;
  const values = parts.map(Number);
  return values.every((value) => value >= 0 && value <= 255) ? values : undefined;
}

function mappedIpv4Parts(hostname: string): readonly number[] | undefined {
  const mapped = hostname.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/u);
  if (mapped === null) return undefined;
  const high = Number.parseInt(mapped[1]!, 16);
  const low = Number.parseInt(mapped[2]!, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff];
}

function isObviousLocalOrPrivateIpv4(ipv4: readonly number[]): boolean {
  const [a, b] = ipv4;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a! >= 224;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  const ipv4 = ipv4Parts(normalized);
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized === "::1"
    || ipv4?.[0] === 127;
}

function isObviousLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
  if (
    isLoopbackHostname(normalized)
    || normalized === "0.0.0.0"
    || normalized === "::"
    || normalized.endsWith(".local")
    || (!normalized.includes(".") && !normalized.includes(":"))
  ) return true;
  const ipv4 = ipv4Parts(normalized);
  if (ipv4 !== undefined) return isObviousLocalOrPrivateIpv4(ipv4);
  if (normalized.includes(":")) {
    if (/^(?:fc|fd)/u.test(normalized) || /^fe[89ab]/u.test(normalized)) return true;
    const mapped = mappedIpv4Parts(normalized);
    return mapped === undefined ? false : isObviousLocalOrPrivateIpv4(mapped);
  }
  return false;
}

function validatedRemoteUrl(rawUrl: string, currentUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Enter a complete HTTPS PDF URL.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("PDF URLs cannot include a username or password.");
  }
  const current = new URL(currentUrl);
  const localDevelopment = current.protocol === "http:"
    && isLoopbackHostname(normalizedHostname(current));
  const targetLoopback = isLoopbackHostname(normalizedHostname(url));
  if (url.protocol !== "https:" && !(localDevelopment && url.protocol === "http:" && targetLoopback)) {
    throw new Error("PDF URLs must use HTTPS. Local development may use HTTP loopback URLs.");
  }
  if (isObviousLocalOrPrivateHostname(normalizedHostname(url)) && !(localDevelopment && targetLoopback)) {
    throw new Error("Choose a public PDF URL, or download the PDF and upload it here.");
  }
  return url;
}

async function boundedResponseBytes(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
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
  const cancelReader = () => { void reader.cancel(); };
  signal?.addEventListener("abort", cancelReader, { once: true });
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new StaticOperationCancelledError();
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > STATIC_PDF_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Choose a PDF no larger than 64 MB.");
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
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
  options: StaticPdfReadOptions | number = {},
): Promise<StaticPdfSource> {
  const resolvedOptions = typeof options === "number" ? { timeoutMs: options } : options;
  const currentUrl = resolvedOptions.currentUrl
    ?? (typeof globalThis.location?.href === "string"
      ? globalThis.location.href
      : "https://placekeeper.invalid/");
  const url = validatedRemoteUrl(rawUrl, currentUrl);
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  resolvedOptions.signal?.addEventListener("abort", relayAbort, { once: true });
  let timedOut = false;
  try {
    return await waitWithin((async () => {
      let response: Response;
      try {
        response = await fetchPdf(url, {
          mode: "cors",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch (error) {
        if (resolvedOptions.signal?.aborted) throw new StaticOperationCancelledError();
        if (isAbortError(error)) throw error;
        throw new Error("The PDF could not be read because its host blocked cross-origin browser access (CORS) or the network request failed. Download it and upload the file instead.");
      }
      if (response.redirected) {
        throw new Error("The PDF URL redirected. Use the final public HTTPS URL, or download and upload the file instead.");
      }
      if (!response.ok) throw new Error(`The PDF host returned status ${response.status}. Download and upload the file instead.`);
      return validateStaticPdf(remoteFilename(url), await boundedResponseBytes(response, controller.signal));
    })(), resolvedOptions.timeoutMs ?? STATIC_PDF_FETCH_TIMEOUT_MS, "The PDF request timed out. Try downloading it and uploading the file instead.", () => {
      timedOut = true;
      controller.abort();
    }, resolvedOptions.signal, relayAbort);
  } catch (error) {
    if (error instanceof StaticOperationCancelledError || resolvedOptions.signal?.aborted) {
      throw new StaticOperationCancelledError();
    }
    if (error instanceof StaticOperationTimeoutError || (timedOut && isAbortError(error))) {
      throw new Error("The PDF request timed out. Try downloading it and uploading the file instead.");
    }
    throw error;
  } finally {
    resolvedOptions.signal?.removeEventListener("abort", relayAbort);
  }
}

export async function createStaticHostRuntime(
  input: {
    readonly source: StaticPdfSource;
    readonly viewerAssets: Omit<ViewerAssetUrls, "documentUrl">;
  },
  dependencies: StaticRuntimeDependencies = {},
): Promise<HostRuntime> {
  const startupTimeoutMs = dependencies.startupTimeoutMs ?? STATIC_PDF_STARTUP_TIMEOUT_MS;
  const writerTimeoutMs = dependencies.writerTimeoutMs ?? STATIC_PDF_EXPORT_TIMEOUT_MS;
  const documentSession = dependencies.documentSession ?? createBrowserDocumentSession({
    createWriter: dependencies.writer === undefined
      ? () => createBrowserEmbedPdfWriter(
          input.viewerAssets.pdfiumWasm,
          input.viewerAssets.workerUrl,
        )
      : () => dependencies.writer!,
    operationTimeoutMs: writerTimeoutMs,
  });
  let digest: string;
  let eligibility: PdfRewriteEligibility;
  let inspection: Awaited<ReturnType<BrowserDocumentSession["inspect"]>>;
  try {
    [digest, eligibility] = await waitWithin(Promise.all([
      (dependencies.digest ?? sha256)(input.source.bytes),
      documentSession.assess(input.source.bytes, {
        ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
        timeoutMs: startupTimeoutMs,
      }),
    ]), startupTimeoutMs, "PDF assessment timed out.", () => {
      void documentSession.dispose();
    }, dependencies.signal, () => {
      void documentSession.dispose();
    });
    inspection = await documentSession.inspect(input.source.bytes, {
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      timeoutMs: startupTimeoutMs,
    });
  } catch (error) {
    await documentSession.dispose();
    if (isStaticOperationCancelled(error)) throw new StaticOperationCancelledError();
    if (
      error instanceof StaticOperationTimeoutError
      || (error instanceof BrowserDocumentSessionError && error.code === "timeout")
    ) {
      throw new Error("This PDF took too long to assess. Try a different PDF.");
    }
    throw error;
  }
  if (!eligibility.eligible) {
    await documentSession.dispose();
    throw new Error(eligibility.message);
  }
  const sessionId = dependencies.sessionId ?? crypto.randomUUID();
  const createObjectURL = dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL = dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const documentUrl = createObjectURL(new Blob(
    [toArrayBuffer(input.source.bytes)],
    { type: "application/pdf" },
  ));
  const origin = dependencies.origin ?? globalThis.location?.origin ?? "https://placekeeper.invalid";
  const download = dependencies.download ?? downloadBytes;
  const lifecycle = dependencies.lifecycle ?? globalThis as unknown as StaticLifecycleTarget;
  let state = createImportedReviewState({
    sessionId,
    source: {
      fileId: digest,
      digest,
      byteLength: input.source.bytes.byteLength,
    },
    items: inspection.portableItems,
  });
  let disposed = false;
  let lastExportedRevision = inspection.portableItems.length > 0 ? 0 : -1;
  let unloadGuardRegistered = false;

  const beforeUnload: EventListener = (rawEvent) => {
    const event = rawEvent as BeforeUnloadEvent;
    if (state.revision === 0 || state.revision <= lastExportedRevision) return;
    event.preventDefault();
    event.returnValue = "";
  };
  const updateUnloadGuard = (): void => {
    const dirty = !disposed && state.revision > 0 && state.revision > lastExportedRevision;
    if (dirty === unloadGuardRegistered) return;
    unloadGuardRegistered = dirty;
    if (dirty) lifecycle.addEventListener?.("beforeunload", beforeUnload);
    else lifecycle.removeEventListener?.("beforeunload", beforeUnload);
  };

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
        saveStatus: notSavedStatus(state, eligibility, lastExportedRevision),
        viewerAssets: { ...input.viewerAssets, documentUrl },
        resourcePolicy: { host: "browser", origin },
      };
    },
    subscribeInvalidations: () => () => undefined,
    async command(command) {
      if (disposed) throw new Error("This review is closed.");
      const nextState = reduceReview(state, command);
      projectReviewItems(nextState.items, undefined, {
        ...(nextState.annotationName === undefined ? {} : { annotationName: nextState.annotationName }),
      }).forEach(assertPortableAnnotationWritable);
      state = nextState;
      updateUnloadGuard();
      return state;
    },
    async saveStatus() {
      return notSavedStatus(state, eligibility, lastExportedRevision);
    },
    async saveProposal() {
      return { sourceDisposition: "local", filename: reviewedCopyName(input.source.name), folder: "" };
    },
    async chooseCopy() {
      return notSavedStatus(state, eligibility, lastExportedRevision);
    },
    async chooseFolder() {
      return { cancelled: true };
    },
    async chooseOriginal() {
      return notSavedStatus(state, eligibility, lastExportedRevision);
    },
    async retrySave() {
      return notSavedStatus(state, eligibility, lastExportedRevision);
    },
    async locateSave() {
      return notSavedStatus(state, eligibility, lastExportedRevision);
    },
    async exportReviewedCopy(): Promise<ProductionExportResult> {
      if (disposed) throw new Error("This review is closed.");
      const exportState = state;
      let output: PdfWriteResult;
      try {
        output = await documentSession.write({
          sourcePdf: input.source.bytes,
          sourceSha256: digest,
          revision: exportState.revision,
          manageNativeAnnotations: true,
          annotations: projectReviewItems(
            exportState.items,
            exportState.workflow.documentGeneration,
            { ...(exportState.annotationName === undefined ? {} : { annotationName: exportState.annotationName }) },
          ),
        }, { timeoutMs: writerTimeoutMs });
      } catch (error) {
        if (isStaticOperationCancelled(error)) {
          throw new Error("Export was cancelled. Your in-memory review is still available; try again.");
        }
        if (error instanceof BrowserDocumentSessionError && error.code === "timeout") {
          throw new Error("PDF export timed out. Your in-memory review is still available; try again.");
        }
        throw error;
      }
      if (disposed) throw new Error("Export was cancelled. No download was started.");
      const filename = reviewedCopyName(input.source.name);
      download(output.pdfBytes, filename);
      lastExportedRevision = Math.max(lastExportedRevision, exportState.revision);
      updateUnloadGuard();
      const newerEdits = state.revision > exportState.revision;
      const structuralCheck = "Placekeeper confirmed the copy opens and contains the exported review marks; other PDF content was not comprehensively checked, and the browser was only asked to start the download.";
      return {
        kind: "reviewed-copy",
        path: filename,
        revision: exportState.revision,
        digest: output.evidence.outputSha256,
        warning: newerEdits
          ? `${structuralCheck} Newer edits are still unexported; export again to include them.`
          : structuralCheck,
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
      updateUnloadGuard();
      revokeObjectURL(documentUrl);
      void documentSession.dispose();
    },
  };
  return runtime;
}
