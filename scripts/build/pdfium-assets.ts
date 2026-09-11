import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Rollup } from "vite";
import { EMBEDPDF_ENGINE_VERSION, extractPinnedPdfiumWorkerSource } from "./pdfium-worker-source.js";

/** Hosts choose their diagnostic and the lifecycle hook in which loading occurs. */
export function loadPinnedPdfiumWorkerSource(versionDiagnostic: string): string {
  const engineRoot = resolve("node_modules/@embedpdf/engines");
  const metadata = JSON.parse(readFileSync(resolve(engineRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  if (metadata.version !== EMBEDPDF_ENGINE_VERSION) throw new Error(versionDiagnostic);
  return extractPinnedPdfiumWorkerSource(readFileSync(
    resolve(engineRoot, "dist/lib/pdfium/web/worker-engine.js"),
    "utf8",
  ));
}

type AssetName = { readonly fileName: string } | { readonly name: string };

/** Read WASM at emission time; hosts retain worker specialization and naming policy. */
export function emitPdfiumAssets(
  context: Pick<Rollup.PluginContext, "emitFile">,
  assets: { readonly wasm: AssetName; readonly worker: AssetName; readonly workerSource: string },
): { readonly wasmReference: string; readonly workerReference: string } {
  const wasmReference = context.emitFile({
    type: "asset",
    ...assets.wasm,
    source: readFileSync(resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm")),
  });
  const workerReference = context.emitFile({
    type: "asset",
    ...assets.worker,
    source: assets.workerSource,
  });
  return { wasmReference, workerReference };
}
