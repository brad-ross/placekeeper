import { spawn } from "node:child_process";
import { open, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { assessPdfRewriteEligibility } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";

const MAX_VALIDATION_OUTPUT_BYTES = 1_024;
const MAX_VALIDATED_PDF_BYTES = 256 * 1024 * 1024;
// The validator reads one bounded transfer into memory before PDFium opens it.
// Keep the isolated heap above the accepted 256 MiB file ceiling so a valid
// large document is not rejected solely by a contradictory worker limit.
const VALIDATOR_HEAP_MIB = 384;

export interface PdfValidationSubprocessOptions {
  readonly executable?: string;
  readonly entryPath?: string;
  readonly execArgv?: readonly string[];
  readonly timeoutMs?: number;
}

/** Runs the existing backend's structural open in the isolated worker. */
export async function validatePdfFile(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("invalid-pdf");
  const canonical = await realpath(path).catch(() => { throw new Error("invalid-pdf"); });
  const file = await open(canonical, "r").catch(() => { throw new Error("invalid-pdf"); });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_VALIDATED_PDF_BYTES) {
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

export async function validatePdfInSubprocess(
  path: string,
  options: PdfValidationSubprocessOptions = {},
): Promise<void> {
  const executable = options.executable ?? process.execPath;
  const entryPath = options.entryPath ?? process.argv[1];
  if (entryPath === undefined) throw new Error("validation-unavailable");
  const child = spawn(executable, [
    ...(options.execArgv ?? process.execArgv),
    `--max-old-space-size=${VALIDATOR_HEAP_MIB}`,
    entryPath,
    "chrome-validate-pdf",
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

  await new Promise<void>((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise();
      else reject(error);
    };
    const terminate = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => {
      terminate();
      finish(new Error("validation-timeout"));
    }, options.timeoutMs ?? 5_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_VALIDATION_OUTPUT_BYTES) {
        terminate();
        finish(new Error("invalid-pdf"));
      }
    });
    child.once("error", () => finish(new Error("validation-unavailable")));
    child.once("exit", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error("invalid-pdf"));
        return;
      }
      try {
        const result = JSON.parse(output) as { readonly ok?: unknown };
        finish(result.ok === true ? undefined : new Error("invalid-pdf"));
      } catch {
        finish(new Error("invalid-pdf"));
      }
    });
  });
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
