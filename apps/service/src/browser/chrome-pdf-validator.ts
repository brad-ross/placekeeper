import { spawn } from "node:child_process";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { assessPdfRewriteEligibility } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import { readEditableReviewItems } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import type { PdfRewriteEligibility } from "../../../../packages/core/src/pdf-writer.js";
import type { ReviewItem } from "../../../../packages/core/src/review-model.js";
import { MAX_CHROME_PDF_BYTES } from "./chrome-pdf-limits.js";

const MAX_VALIDATION_OUTPUT_BYTES = 1_024;
const MAX_INSPECTION_OUTPUT_BYTES = 16 * 1024 * 1024;
// Remote browser responses are intentionally held below the broader local-file
// limits. PDFium, Wasm, and Buffer memory live outside V8's old-space limit, so
// a smaller input ceiling is the dependable cross-platform bound here.
const VALIDATOR_HEAP_MIB = 192;

export interface PdfValidationSubprocessOptions {
  readonly executable?: string;
  readonly entryPath?: string;
  readonly execArgv?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ChromePdfInspection {
  readonly nativeAnnotationsImported?: boolean;
  readonly rewriteEligibility: PdfRewriteEligibility;
  readonly importedItems: readonly ReviewItem[];
}

/** Runs the existing backend's structural open in the isolated worker. */
export async function validatePdfFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("invalid-pdf");
  const canonical = await realpath(path).catch(() => { throw new Error("invalid-pdf"); });
  const file = await open(canonical, "r").catch(() => { throw new Error("invalid-pdf"); });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_CHROME_PDF_BYTES) {
      throw new Error("invalid-pdf");
    }
  } finally {
    await file.close();
  }
  try {
    // The rewrite assessment performs a real PDFium structural open and also
    // rejects encrypted, signed, and permission-restricted documents that the
    // review pipeline cannot safely annotate. Unlike the conformance inspector,
    // it does not render every page merely to validate an incoming source.
    const eligibility = await assessPdfRewriteEligibility(new Uint8Array(await readFile(canonical)));
    if (!eligibility.eligible) throw new Error("invalid-pdf");
  } catch {
    throw new Error("invalid-pdf");
  }
}

export async function inspectPdfFile(path: string): Promise<ChromePdfInspection> {
  if (!isAbsolute(path)) throw new Error("invalid-pdf");
  const canonical = await realpath(path).catch(() => { throw new Error("invalid-pdf"); });
  const file = await open(canonical, "r").catch(() => { throw new Error("invalid-pdf"); });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_CHROME_PDF_BYTES) {
      throw new Error("invalid-pdf");
    }
  } finally {
    await file.close();
  }
  const bytes = new Uint8Array(await readFile(canonical));
  const rewriteEligibility = await assessPdfRewriteEligibility(bytes);
  let importedItems: readonly ReviewItem[] = [];
  let nativeAnnotationsImported = false;
  try {
    importedItems = await readEditableReviewItems(bytes);
    nativeAnnotationsImported = true;
  } catch (error) {
    if ((error as { readonly code?: unknown }).code === "invalid-portable-annotation") {
      throw error;
    }
    importedItems = [];
  }
  return { rewriteEligibility, importedItems, nativeAnnotationsImported };
}

async function runPdfWorker(
  path: string,
  command: "chrome-validate-pdf" | "chrome-inspect-pdf",
  maxOutputBytes: number,
  options: PdfValidationSubprocessOptions,
): Promise<unknown> {
  options.signal?.throwIfAborted();
  const executable = options.executable ?? process.execPath;
  const entryPath = options.entryPath ?? process.argv[1];
  if (entryPath === undefined) throw new Error("validation-unavailable");
  const child = spawn(executable, [
    ...(options.execArgv ?? process.execArgv),
    `--max-old-space-size=${VALIDATOR_HEAP_MIB}`,
    entryPath,
    command,
    "--path",
    path,
  ], {
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      PATH: "/usr/bin:/bin",
      ...(process.env.PLACEKEEPER_PDFIUM_WASM === undefined
        ? {}
        : { PLACEKEEPER_PDFIUM_WASM: process.env.PLACEKEEPER_PDFIUM_WASM }),
    },
  });

  return new Promise<unknown>((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    const terminate = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: { readonly value?: unknown; readonly error?: Error }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result.error === undefined) resolvePromise(result.value);
      else reject(result.error);
    };
    const onAbort = (): void => {
      terminate();
      finish({ error: options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("validation-cancelled") });
    };
    const timer = setTimeout(() => {
      terminate();
      finish({ error: new Error("validation-timeout") });
    }, options.timeoutMs ?? 5_000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > maxOutputBytes) {
        terminate();
        finish({ error: new Error("invalid-pdf") });
      }
    });
    child.once("error", () => finish({ error: new Error("validation-unavailable") }));
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ error: new Error("invalid-pdf") });
        return;
      }
      try {
        finish({ value: JSON.parse(output) as unknown });
      } catch {
        finish({ error: new Error("invalid-pdf") });
      }
    });
  });
}

export async function validatePdfInSubprocess(
  path: string,
  options: PdfValidationSubprocessOptions = {},
): Promise<void> {
  const result = await runPdfWorker(path, "chrome-validate-pdf", MAX_VALIDATION_OUTPUT_BYTES, options);
  if (
    typeof result !== "object" || result === null ||
    (result as { readonly ok?: unknown }).ok !== true
  ) throw new Error("invalid-pdf");
}

export async function inspectPdfInSubprocess(
  path: string,
  options: PdfValidationSubprocessOptions = {},
): Promise<ChromePdfInspection> {
  const result = await runPdfWorker(path, "chrome-inspect-pdf", MAX_INSPECTION_OUTPUT_BYTES, options);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("invalid-pdf");
  }
  const record = result as Record<string, unknown>;
  const eligibility = record.rewriteEligibility as PdfRewriteEligibility | undefined;
  const validEligibility = eligibility?.eligible === true
    ? Object.keys(eligibility).length === 1
    : eligibility?.eligible === false &&
      ["encrypted", "permission-denied", "signature-restricted", "invalid-pdf"].includes(eligibility.code) &&
      typeof eligibility.message === "string" && eligibility.message.length <= 1_024 &&
      Object.keys(eligibility).sort().join("\0") === ["code", "eligible", "message"].join("\0");
  if (
    eligibility === undefined || !validEligibility || !Array.isArray(record.importedItems)
  ) throw new Error("invalid-pdf");
  return {
    rewriteEligibility: eligibility,
    importedItems: record.importedItems as readonly ReviewItem[],
    nativeAnnotationsImported: record.nativeAnnotationsImported === true,
  };
}

export async function runChromePdfValidationCommand(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args.length !== 2 || args[0] !== "--path" || !isAbsolute(args[1] ?? "")) {
    throw new Error("Invalid PDF validation command");
  }
  try {
    await validatePdfFile(args[1]!);
    write(`${JSON.stringify({ ok: true })}\n`);
    return 0;
  } catch {
    write(`${JSON.stringify({ ok: false })}\n`);
    return 2;
  }
}

export async function runChromePdfInspectionCommand(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args.length !== 2 || args[0] !== "--path" || !isAbsolute(args[1] ?? "")) {
    throw new Error("Invalid PDF inspection command");
  }
  try {
    write(`${JSON.stringify(await inspectPdfFile(args[1]!))}\n`);
    return 0;
  } catch {
    write(`${JSON.stringify({ ok: false })}\n`);
    return 2;
  }
}
