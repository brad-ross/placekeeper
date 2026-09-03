import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPackagedPdfiumWorkerSource,
  extractPinnedPdfiumWorkerSource,
} from "../scripts/embedpdf-worker-source.js";
import { platformProofEnabled, platformProofFailureCode } from "../src/platform-proof.js";

describe("installed Chrome platform proof", () => {
  it("cannot block the production handoff when diagnostic storage is unavailable", async () => {
    await expect(platformProofEnabled({
      storage: { local: { get: async () => { throw new Error("storage unavailable"); } } },
    } as never)).resolves.toBe(false);
    expect(platformProofFailureCode(new Error("sensitive implementation detail")))
      .toBe("unexpected-failure");
  });

  it("keeps proof mode independent of unavailable handler-local attachment identity", async () => {
    const source = await readFile(resolve(
      "apps/chrome-extension/src/platform-proof.ts",
    ), "utf8");

    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("PerformanceNavigationTiming");
    expect(source).not.toContain("placekeeperPlatformProofNextScenario");
    expect(source).not.toContain("placekeeperPlatformProofRecords");
    expect(source).toContain("createPdfiumEngine");
    expect(source).toContain("shared/pdfium-worker.js");
    expect(source).toContain("shared/pdfium.wasm");
  });

  it("extracts the exact pinned EmbedPDF worker and instruments that worker context", async () => {
    const engineSource = await readFile(resolve(
      "node_modules/@embedpdf/engines/dist/lib/pdfium/web/worker-engine.js",
    ), "utf8");
    const workerSource = extractPinnedPdfiumWorkerSource(engineSource);
    const packagedSource = buildPackagedPdfiumWorkerSource(workerSource);

    expect(workerSource).toContain("class PdfiumEngineRunner");
    expect(workerSource).toContain('type === "wasmInit"');
    expect(packagedSource).toContain("placekeeper-pdfium-worker-privilege-probe");
    for (const marker of [
      "chromeApi",
      "packagedAssetFetch",
      "nativeMessaging",
      "loopbackFetch",
      "remoteFetch",
      "dom",
      "evalCode",
      "functionConstructor",
      "importScriptsCode",
    ]) expect(packagedSource).toContain(marker);
  });

  it("pins the caller-created worker seam to EmbedPDF 2.14.4", async () => {
    const [engineSource, engineTypes, workspace, lockfile, patch] = await Promise.all([
      readFile(resolve("node_modules/@embedpdf/engines/dist/lib/pdfium/web/worker-engine.js"), "utf8"),
      readFile(resolve("node_modules/@embedpdf/engines/dist/lib/pdfium/web/worker-engine.d.ts"), "utf8"),
      readFile(resolve("pnpm-workspace.yaml"), "utf8"),
      readFile(resolve("pnpm-lock.yaml"), "utf8"),
      readFile(resolve("patches/@embedpdf__engines@2.14.4.patch"), "utf8"),
    ]);

    expect(engineSource).toContain("providedWorker ?? new Worker(");
    expect(engineTypes).toContain("worker?: Worker;");
    expect(workspace).toContain("'@embedpdf/engines@2.14.4': patches/@embedpdf__engines@2.14.4.patch");
    expect(patch).toContain("Caller-created PDFium worker");
    expect(lockfile).toContain("5ee7d7e7371522d182e02ec9c84951c02146f8199284eb288d8b9b551da91406");
  });
});
