import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateBackendRuntimeManifest } from "./validate-manifest.js";

const execFileAsync = promisify(execFile);

export interface DoctorEvidence {
  readonly ok: true;
  readonly offline: true;
  readonly writer: "embedpdf-node-pdfium";
  readonly nodeVersion: string;
  readonly pdfiumSha256: string;
  readonly pages: number;
  readonly structurallyValid: true;
}

export function validateDoctorEvidence(value: unknown, expectedNode: string, expectedPdfiumDigest: string): DoctorEvidence {
  if (typeof value !== "object" || value === null) throw new Error("Doctor evidence must be an object");
  const evidence = value as Partial<DoctorEvidence>;
  if (
    evidence.ok !== true ||
    evidence.offline !== true ||
    evidence.writer !== "embedpdf-node-pdfium" ||
    evidence.nodeVersion !== expectedNode ||
    evidence.pdfiumSha256 !== expectedPdfiumDigest ||
    typeof evidence.pages !== "number" ||
    !Number.isSafeInteger(evidence.pages) ||
    evidence.pages <= 0 ||
    evidence.structurallyValid !== true
  ) {
    throw new Error("Installed writer doctor evidence did not match the distribution manifest");
  }
  return evidence as DoctorEvidence;
}

export async function smokeInstalledBundle(appPath: string, fixturePath: string, repoRoot = process.cwd()): Promise<DoctorEvidence> {
  const manifest = validateBackendRuntimeManifest(JSON.parse(await readFile(resolve(repoRoot, "packaging/macos/backend-runtime-manifest.json"), "utf8")) as unknown);
  const pdfium = manifest.assets.find((asset) => asset.id === "pdfium-wasm");
  if (pdfium === undefined) throw new Error("PDFium runtime asset is absent");
  const executable = resolve(appPath, "Contents/MacOS/pdf-proofreader");
  const result = await execFileAsync(executable, ["doctor", "--json", "--offline", "--writer", "--pdf", resolve(fixturePath)], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 65_536,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env.HOME,
      PDF_PROOFREADER_OFFLINE: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    },
  });
  return validateDoctorEvidence(JSON.parse(result.stdout) as unknown, manifest.nodeVersion, pdfium.sha256);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const appPath = args[0];
  const fixturePath = args[1];
  if (appPath === undefined || fixturePath === undefined) throw new Error("Usage: smoke-installed.ts <app-path> <pdf-fixture>");
  const evidence = await smokeInstalledBundle(appPath, fixturePath);
  process.stdout.write(`Installed offline writer smoke passed (${evidence.pages} page(s)).\n`);
}
