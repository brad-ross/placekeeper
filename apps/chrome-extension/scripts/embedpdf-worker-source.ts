import { runInNewContext } from "node:vm";

export const EMBEDPDF_ENGINE_VERSION = "2.14.4";
export const PACKAGED_PDFIUM_WORKER_PATH = "shared/pdfium-worker.js";
export const PACKAGED_PDFIUM_WASM_PATH = "shared/pdfium.wasm";

const workerBlobStart = "URL.createObjectURL(new Blob([";
const workerBlobEnd = '], { type: "application/javascript" }))';

function readStringLiteral(source: string, offset: number): string {
  const quote = source[offset];
  if (quote !== "\"" && quote !== "'") {
    throw new Error("EmbedPDF 2.14.4 worker source did not begin with a string literal");
  }
  let escaped = false;
  for (let index = offset + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return source.slice(offset, index + 1);
    }
  }
  throw new Error("EmbedPDF 2.14.4 worker source string was unterminated");
}

/** Extracts only the pinned package's inline worker string; no package code is executed. */
export function extractPinnedPdfiumWorkerSource(engineSource: string): string {
  const marker = engineSource.indexOf(workerBlobStart);
  if (marker < 0 || engineSource.indexOf(workerBlobStart, marker + 1) >= 0) {
    throw new Error("EmbedPDF 2.14.4 must contain exactly one inline PDFium worker");
  }
  const literalOffset = marker + workerBlobStart.length;
  const literal = readStringLiteral(engineSource, literalOffset);
  if (!engineSource.startsWith(workerBlobEnd, literalOffset + literal.length)) {
    throw new Error("EmbedPDF 2.14.4 inline worker shape changed");
  }
  const workerSource = runInNewContext(`(${literal})`, Object.create(null), {
    timeout: 1_000,
  }) as unknown;
  if (typeof workerSource !== "string" ||
    !workerSource.includes("class PdfiumEngineRunner") ||
    !workerSource.includes('type === "wasmInit"')) {
    throw new Error("EmbedPDF 2.14.4 PDFium worker signature changed");
  }
  return workerSource;
}

const privilegeBootstrap = String.raw`
const __placekeeperNativePostMessage = globalThis.postMessage.bind(globalThis);
let __placekeeperProbeRequest;
let __placekeeperProbeComplete = false;

async function __placekeeperFetchReachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 750);
  try {
    const response = await fetch(url, { cache: "no-store", mode: "cors", signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function __placekeeperExecutableCodeAvailable(source) {
  try {
    return globalThis.eval(source) === 1;
  } catch {
    return false;
  }
}

function __placekeeperFunctionConstructorAvailable() {
  try {
    return Function("return 1")() === 1;
  } catch {
    return false;
  }
}

function __placekeeperImportScriptsAvailable() {
  try {
    if (typeof globalThis.importScripts !== "function") return false;
    globalThis.importScripts("data:text/javascript,void%200");
    return true;
  } catch {
    return false;
  }
}

async function __placekeeperReportPrivileges() {
  if (__placekeeperProbeComplete || __placekeeperProbeRequest === undefined) return;
  __placekeeperProbeComplete = true;
  const [packagedAssetFetch, loopbackFetch, remoteFetch] = await Promise.all([
    __placekeeperFetchReachable(globalThis.location.href),
    __placekeeperFetchReachable(__placekeeperProbeRequest.loopbackUrl),
    __placekeeperFetchReachable("https://example.com/"),
  ]);
  const chromeValue = globalThis.chrome;
  const runtime = typeof chromeValue === "object" && chromeValue !== null
    ? chromeValue.runtime
    : undefined;
  __placekeeperNativePostMessage({
    type: "placekeeper-pdfium-worker-privilege-probe",
    workerStarted: true,
    pdfiumReady: true,
    packagedAssetFetch,
    chromeApi: chromeValue !== undefined,
    nativeMessaging: typeof runtime === "object" && runtime !== null &&
      typeof runtime.connectNative === "function",
    loopbackFetch,
    remoteFetch,
    dom: globalThis.document !== undefined,
    evalCode: __placekeeperExecutableCodeAvailable("1"),
    functionConstructor: __placekeeperFunctionConstructorAvailable(),
    importScriptsCode: __placekeeperImportScriptsAvailable(),
  });
}

globalThis.addEventListener("message", (event) => {
  if (event.data?.type !== "start-placekeeper-pdfium-worker-privilege-probe" ||
    typeof event.data.loopbackUrl !== "string") return;
  __placekeeperProbeRequest = { loopbackUrl: event.data.loopbackUrl };
});

globalThis.postMessage = (message, transfer) => {
  if (transfer === undefined) __placekeeperNativePostMessage(message);
  else __placekeeperNativePostMessage(message, transfer);
  if (message?.type === "ready") void __placekeeperReportPrivileges();
};
`;

export function buildPackagedPdfiumWorkerSource(workerSource: string): string {
  return `${privilegeBootstrap}\n${workerSource}\n`;
}
