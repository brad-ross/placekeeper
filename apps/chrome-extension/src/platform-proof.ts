import { createPdfiumEngine } from "@embedpdf/engines/pdfium-worker-engine";

import type { ChromeApi } from "./chrome-api.js";

export const PLACEKEEPER_PLATFORM_PROOF_KEY = "placekeeperPlatformProofEnabled";

type PlatformProofFailureCode =
  | "worker-create-failed"
  | "pdfium-engine-create-failed"
  | "pdfium-initialization-failed"
  | "worker-runtime-failed"
  | "proof-timeout"
  | "unexpected-failure";

class PlatformProofFailure extends Error {
  constructor(readonly code: PlatformProofFailureCode) {
    super(code);
  }
}

export function platformProofFailureCode(error: unknown): PlatformProofFailureCode {
  return error instanceof PlatformProofFailure ? error.code : "unexpected-failure";
}

interface WorkerProbeResult {
  readonly type: "placekeeper-pdfium-worker-privilege-probe";
  readonly workerStarted: boolean;
  readonly pdfiumReady: boolean;
  readonly packagedAssetFetch: boolean;
  readonly chromeApi: boolean;
  readonly nativeMessaging: boolean;
  readonly loopbackFetch: boolean;
  readonly remoteFetch: boolean;
  readonly dom: boolean;
  readonly evalCode: boolean;
  readonly functionConstructor: boolean;
  readonly importScriptsCode: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packagedAsset(path: string): string {
  return new URL(path, globalThis.location.href).href;
}

function startPdfiumWorkerProbe(loopbackUrl: string): Promise<WorkerProbeResult> {
  let worker: Worker;
  try {
    worker = new Worker(packagedAsset("assets/pdfium-worker.js"), { type: "module" });
  } catch {
    throw new PlatformProofFailure("worker-create-failed");
  }
  worker.postMessage({
    type: "start-placekeeper-pdfium-worker-privilege-probe",
    loopbackUrl,
  });
  let engine: ReturnType<typeof createPdfiumEngine>;
  try {
    engine = createPdfiumEngine(packagedAsset("assets/pdfium.wasm"), {
      encoderPoolSize: 0,
      fontFallback: null,
      worker,
    });
  } catch {
    worker.terminate();
    throw new PlatformProofFailure("pdfium-engine-create-failed");
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      engine.destroy?.();
      reject(new PlatformProofFailure("proof-timeout"));
    }, 10_000);
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (!isRecord(event.data)) return;
      if (event.data.type === "wasmError") {
        clearTimeout(timer);
        engine.destroy?.();
        reject(new PlatformProofFailure("pdfium-initialization-failed"));
        return;
      }
      if (event.data.type !== "placekeeper-pdfium-worker-privilege-probe") return;
      clearTimeout(timer);
      engine.destroy?.();
      resolve(event.data as unknown as WorkerProbeResult);
    });
    worker.addEventListener("error", () => {
      clearTimeout(timer);
      engine.destroy?.();
      reject(new PlatformProofFailure("worker-runtime-failed"));
    }, { once: true });
  });
}

export async function platformProofEnabled(api: ChromeApi): Promise<boolean> {
  try {
    const stored = await api.storage.local.get(PLACEKEEPER_PLATFORM_PROOF_KEY);
    return stored[PLACEKEEPER_PLATFORM_PROOF_KEY] === true;
  } catch {
    // Diagnostics must never become a dependency of the production handoff.
    return false;
  }
}

export async function runInstalledPlatformProof(options: {
  readonly api: ChromeApi;
  readonly status: HTMLElement;
  readonly output: HTMLElement;
}): Promise<void> {
  const streamInfo = await options.api.mimeHandler.getStreamInfo();
  if (streamInfo === undefined) {
    options.status.textContent = "MIME handler stream metadata unavailable — stop the embedded-viewer rollout.";
    return;
  }

  document.title = "Placekeeper platform proof";
  const original = new URL(streamInfo.originalUrl);
  const loopbackUrl = original.hostname === "127.0.0.1"
    ? new URL("/worker-probe", original).href
    : "http://127.0.0.1:43179/worker-probe";
  const privilege = await startPdfiumWorkerProbe(loopbackUrl);
  const allowedTrueFields = new Set(["type", "workerStarted", "pdfiumReady", "packagedAssetFetch"]);
  const forbiddenReachable = Object.entries(privilege)
    .filter(([name, value]) => !allowedTrueFields.has(name) && value === true)
    .map(([name]) => name);

  options.output.hidden = false;
  options.output.textContent = JSON.stringify({
    documentTitleApplied: document.title === "Placekeeper platform proof",
    sourceUrlAvailable: streamInfo.originalUrl.length > 0,
    workerStarted: privilege.workerStarted,
    pdfiumReady: privilege.pdfiumReady,
    packagedAssetFetch: privilege.packagedAssetFetch,
    forbiddenWorkerPrivileges: forbiddenReachable,
  }, null, 2);
  options.status.textContent = privilege.workerStarted && privilege.pdfiumReady &&
    privilege.packagedAssetFetch && forbiddenReachable.length === 0
    ? "Proof captured. Confirm the visible tab title and original PDF URL."
    : "PDFium worker privilege isolation failed — stop the embedded-viewer rollout.";
}
