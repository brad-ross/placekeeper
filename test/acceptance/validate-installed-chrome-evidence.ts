import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { CHROME_EXTENSION_BUNDLE_PATH, CHROME_EXTENSION_ID } from "../../packaging/macos/chrome-integration.js";
import { BUILD_IDENTITY_FILENAME } from "../../packaging/macos/build-app.js";
import {
  extensionRuntimeIdentity,
  parseChromeMajor,
  validateManualEvidence,
} from "./installed-chrome.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const appPath = resolve(process.argv[2] ?? "");
  if (!appPath.endsWith("/Placekeeper.app")) throw new Error("Expected a packaged Placekeeper.app path.");
  const raw = process.env.PLACEKEEPER_INSTALLED_CHROME_EVIDENCE;
  if (raw === undefined || raw.trim() === "") throw new Error("Installed Chrome release evidence is required.");
  const evidence = JSON.parse(raw) as unknown;
  if (!record(evidence) || !record(evidence.outerTab) || !record(evidence.platformProof) ||
    evidence.schemaVersion !== 1 || evidence.extensionId !== CHROME_EXTENSION_ID ||
    evidence.mimeApi !== true || evidence.startsPaused !== true || evidence.manualMatrix !== "passed" ||
    Object.values(evidence.outerTab).some((value) => value !== true) ||
    evidence.platformProof.workerStarted !== true || evidence.platformProof.pdfiumReady !== true ||
    evidence.platformProof.packagedAssetFetch !== true ||
    !Array.isArray(evidence.platformProof.forbiddenWorkerPrivileges) ||
    evidence.platformProof.forbiddenWorkerPrivileges.length !== 0 ||
    typeof evidence.chromeVersion !== "string" || (parseChromeMajor(evidence.chromeVersion) ?? 0) < 151 ||
    !record(evidence.manualEvidence)) {
    throw new Error("Installed Chrome release evidence is incomplete or failed.");
  }
  const identity = JSON.parse(await readFile(
    join(appPath, `Contents/Resources/${BUILD_IDENTITY_FILENAME}`), "utf8",
  )) as { installArtifactIdentity?: unknown };
  const runtimeIdentity = await extensionRuntimeIdentity(join(appPath, CHROME_EXTENSION_BUNDLE_PATH));
  if (typeof identity.installArtifactIdentity !== "string" ||
    evidence.appBuildIdentity !== identity.installArtifactIdentity ||
    evidence.extensionRuntimeIdentitySha256 !== runtimeIdentity) {
    throw new Error("Installed Chrome evidence belongs to a different app or extension build.");
  }
  validateManualEvidence(evidence.manualEvidence, {
    appBuildIdentity: identity.installArtifactIdentity,
    chromeVersion: evidence.chromeVersion,
    extensionRuntimeIdentitySha256: runtimeIdentity,
  });
  process.stdout.write("Installed Google Chrome release evidence verified.\n");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Installed Chrome evidence validation failed."}\n`);
  process.exitCode = 1;
});
