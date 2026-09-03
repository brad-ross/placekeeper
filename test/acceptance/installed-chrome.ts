import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { chromium, type BrowserContext } from "@playwright/test";
import { PDFDocument } from "pdf-lib";

import {
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_BUNDLE_PATH,
  CHROME_EXTENSION_ORIGIN,
  CHROME_NATIVE_HOST_NAME,
  chromeExtensionInstallPath,
  parseChromeNativeHostManifest,
  validateChromeExtensionDirectory,
  validateChromeIntegrationBundle,
} from "../../packaging/macos/chrome-integration.js";
import { AUTO_OPEN_SENTINEL_KEY, PDF_MIME_TYPE } from "../../apps/chrome-extension/src/opt-in.js";
import { BUILD_IDENTITY_FILENAME } from "../../packaging/macos/build-app.js";
import { startChromePdfFixtureServer, type ChromePdfFixtureServer } from "./chrome-pdf-fixture-server.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXTENSION_WAIT_MS = 10 * 60_000;
const DOCUMENT_WAIT_MS = 45_000;

interface RunnerOptions {
  readonly appPath: string;
  readonly pdfPath: string;
  readonly chromePath: string;
  readonly evidencePath?: string;
  readonly manualEvidencePath?: string;
}

const MANUAL_SCENARIOS = [
  "ae3PreActivationFallback", "ae4ActiveDisconnect", "ae5CanonicalPresentations",
  "ae6Navigation", "ae7CapabilityFreeLink", "ae8ProtectedSuccessor", "ordinaryReview",
  "updateSkew", "hostileCanaries", "keyboardAccessibility", "crossSurfaceRegression",
] as const;
const KTD8_FIXTURES = [
  "small-text", "representative-mixed", "image-heavy-scan",
  "structurally-complex", "near-64-mib",
] as const;

interface InstalledChromeManualEvidence {
  readonly schemaVersion: 1;
  readonly appBuildIdentity: string;
  readonly chromeVersion: string;
  readonly extensionRuntimeIdentitySha256: string;
  readonly scenarios: Record<typeof MANUAL_SCENARIOS[number], true>;
  readonly ktd8: {
    readonly corpusVersion: "chrome-native-v1";
    readonly coldRunsPerFixture: 5;
    readonly warmRunsPerFixture: 10;
    readonly localAndAuthenticatedRemote: true;
    readonly latencyBudgetPassed: true;
    readonly memoryBudgetPassed: true;
    readonly progressResponsive: true;
    readonly cancellationReleaseMs: number;
    readonly measurements: readonly {
      readonly fixtureId: typeof KTD8_FIXTURES[number];
      readonly disposition: "local" | "authenticated-remote";
      readonly redirectP50Ms: number;
      readonly nativeP50Ms: number;
      readonly nativeP95Ms: number;
      readonly peakRssBytes: {
        readonly extension: number;
        readonly nativeHost: number;
        readonly service: number;
        readonly aggregate: number;
      };
    }[];
  };
}

interface InstalledPrerequisites {
  readonly appBuildIdentity: string;
  readonly extensionPath: string;
  readonly hostManifestPath: string;
  readonly hostManifestSha256: string;
  readonly minimumChromeVersion: number;
  readonly extensionRuntimeIdentitySha256: string;
}

interface ChromeExtensionEvidence {
  readonly extensionVersion: string;
  readonly startsPaused: boolean;
  readonly mimeApi: true;
  readonly runtimeIdentitySha256: string;
}

interface PlatformProofEvidence {
  readonly workerStarted: boolean;
  readonly pdfiumReady: boolean;
  readonly packagedAssetFetch: boolean;
  readonly forbiddenWorkerPrivileges: readonly string[];
}

type ChromeServiceWorker = ReturnType<BrowserContext["serviceWorkers"]>[number];

function usage(): string {
  return `Usage: pnpm test:chrome-installed -- [--app <Placekeeper.app>] [--pdf <fixture.pdf>] [--chrome <Google Chrome binary>] [--evidence <output.json>] [--manual-evidence <input.json>]

This release gate opens a disposable Google Chrome profile. You load the exact
packaged extension in Developer Mode and enable it through the Placekeeper popup.
The runner then checks the outer tab URL/title and embedded production client.
It never opens or modifies your everyday Chrome profile.`;
}

export function parseChromeMajor(version: string): number | undefined {
  const match = /Google Chrome\s+(\d+)(?:\.|\s|$)/u.exec(version);
  if (match?.[1] === undefined) return undefined;
  const major = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(major) ? major : undefined;
}

function parseOptions(args: readonly string[]): RunnerOptions {
  let appPath = join(homedir(), "Applications/Placekeeper.app");
  let pdfPath = resolve("test/fixtures/pdfs/text-native.pdf");
  let chromePath = DEFAULT_CHROME;
  let evidencePath: string | undefined;
  let manualEvidencePath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") continue;
    if (flag === "--help" || flag === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = args[index + 1];
    if (value === undefined || !["--app", "--pdf", "--chrome", "--evidence", "--manual-evidence"].includes(flag ?? "")) {
      throw new Error(`Unknown or incomplete option: ${flag ?? ""}\n\n${usage()}`);
    }
    index += 1;
    if (flag === "--app") appPath = resolve(value);
    else if (flag === "--pdf") pdfPath = resolve(value);
    else if (flag === "--chrome") chromePath = resolve(value);
    else if (flag === "--evidence") evidencePath = resolve(value);
    else manualEvidencePath = resolve(value);
  }
  return {
    appPath, pdfPath, chromePath,
    ...(evidencePath === undefined ? {} : { evidencePath }),
    ...(manualEvidencePath === undefined ? {} : { manualEvidencePath }),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateManualEvidence(
  value: unknown,
  expected: Pick<InstalledChromeManualEvidence, "appBuildIdentity" | "chromeVersion" | "extensionRuntimeIdentitySha256">,
): InstalledChromeManualEvidence {
  if (!record(value) || value.schemaVersion !== 1 ||
    value.appBuildIdentity !== expected.appBuildIdentity ||
    value.chromeVersion !== expected.chromeVersion ||
    value.extensionRuntimeIdentitySha256 !== expected.extensionRuntimeIdentitySha256 ||
    !record(value.scenarios) || !record(value.ktd8)) {
    throw new Error("Installed Chrome manual evidence is missing, stale, or incomplete.");
  }
  const scenarios = value.scenarios;
  if (Object.keys(scenarios).sort().join("\n") !== [...MANUAL_SCENARIOS].sort().join("\n") ||
    MANUAL_SCENARIOS.some((name) => scenarios[name] !== true)) {
    throw new Error("Installed Chrome manual evidence is missing, stale, or incomplete.");
  }
  const ktd8 = value.ktd8;
  if (Object.keys(ktd8).sort().join("\n") !== [
    "cancellationReleaseMs", "coldRunsPerFixture", "corpusVersion",
    "latencyBudgetPassed", "localAndAuthenticatedRemote", "memoryBudgetPassed",
    "measurements", "progressResponsive", "warmRunsPerFixture",
  ].sort().join("\n") || ktd8.corpusVersion !== "chrome-native-v1" ||
    ktd8.coldRunsPerFixture !== 5 || ktd8.warmRunsPerFixture !== 10 ||
    ktd8.localAndAuthenticatedRemote !== true || ktd8.latencyBudgetPassed !== true ||
    ktd8.memoryBudgetPassed !== true || ktd8.progressResponsive !== true ||
    typeof ktd8.cancellationReleaseMs !== "number" ||
    !Number.isFinite(ktd8.cancellationReleaseMs) || ktd8.cancellationReleaseMs < 0 ||
    ktd8.cancellationReleaseMs > 2_000 || !Array.isArray(ktd8.measurements)) {
    throw new Error("Installed Chrome KTD8 evidence does not meet the committed budget.");
  }
  const expectedMeasurements = KTD8_FIXTURES.flatMap((fixtureId) => [
    `${fixtureId}:local`, `${fixtureId}:authenticated-remote`,
  ]).sort();
  const observedMeasurements: string[] = [];
  for (const measurement of ktd8.measurements) {
    if (!record(measurement) || Object.keys(measurement).sort().join("\n") !== [
      "disposition", "fixtureId", "nativeP50Ms", "nativeP95Ms", "peakRssBytes", "redirectP50Ms",
    ].sort().join("\n") || !KTD8_FIXTURES.includes(measurement.fixtureId as typeof KTD8_FIXTURES[number]) ||
      (measurement.disposition !== "local" && measurement.disposition !== "authenticated-remote") ||
      !record(measurement.peakRssBytes) || Object.keys(measurement.peakRssBytes).sort().join("\n") !==
        ["aggregate", "extension", "nativeHost", "service"].sort().join("\n")) {
      throw new Error("Installed Chrome KTD8 measurements are incomplete.");
    }
    const timings = [measurement.redirectP50Ms, measurement.nativeP50Ms, measurement.nativeP95Ms];
    const peaks = Object.values(measurement.peakRssBytes);
    if ([...timings, ...peaks].some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) ||
      (measurement.nativeP95Ms as number) < (measurement.nativeP50Ms as number) ||
      (measurement.nativeP50Ms as number) > (measurement.redirectP50Ms as number) +
        Math.max((measurement.redirectP50Ms as number) * 0.2, 1_000)) {
      throw new Error("Installed Chrome KTD8 measurements exceed the committed latency budget.");
    }
    observedMeasurements.push(`${measurement.fixtureId}:${measurement.disposition}`);
  }
  if (observedMeasurements.sort().join("\n") !== expectedMeasurements.join("\n")) {
    throw new Error("Installed Chrome KTD8 measurements do not cover the complete corpus.");
  }
  return value as unknown as InstalledChromeManualEvidence;
}

async function installedPrerequisites(appPath: string): Promise<InstalledPrerequisites> {
  const contract = await validateChromeIntegrationBundle(appPath);
  const bundledExtensionPath = join(appPath, CHROME_EXTENSION_BUNDLE_PATH);
  const extensionPath = chromeExtensionInstallPath(appPath);
  await validateChromeExtensionDirectory(extensionPath);
  if (await extensionTreeDigest(bundledExtensionPath) !== await extensionTreeDigest(extensionPath)) {
    throw new Error("Installed Chrome extension does not match this Placekeeper app. Reinstall Placekeeper before running the gate.");
  }
  const hostManifestPath = join(
    homedir(),
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    `${CHROME_NATIVE_HOST_NAME}.json`,
  );
  const manifestBytes = await readFile(hostManifestPath);
  const actualManifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
  try {
    parseChromeNativeHostManifest(actualManifest, appPath);
  } catch {
    throw new Error("Installed Chrome native-host registration does not match this Placekeeper app. Reinstall Placekeeper before running the gate.");
  }
  const identity = JSON.parse(await readFile(
    join(appPath, `Contents/Resources/${BUILD_IDENTITY_FILENAME}`),
    "utf8",
  )) as { installArtifactIdentity?: unknown };
  if (typeof identity.installArtifactIdentity !== "string" || !/^[0-9a-f]{64}$/u.test(identity.installArtifactIdentity)) {
    throw new Error("Installed Placekeeper build identity is missing or invalid.");
  }
  return {
    appBuildIdentity: identity.installArtifactIdentity,
    extensionPath,
    hostManifestPath,
    hostManifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    minimumChromeVersion: contract.minimumChromeVersion,
    extensionRuntimeIdentitySha256: await extensionRuntimeIdentity(extensionPath),
  };
}

export async function extensionRuntimeIdentity(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, "shared/asset-manifest.json"), "utf8")) as {
    app?: unknown;
    stylesheet?: unknown;
    pdfiumWasm?: unknown;
    pdfiumWorker?: unknown;
  };
  const shared = [manifest.app, manifest.stylesheet, manifest.pdfiumWasm, manifest.pdfiumWorker];
  if (shared.some((name) => typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name))) {
    throw new Error("Installed extension shared-client manifest is invalid.");
  }
  const roots = ["manifest.json", "background.js", "handler.html", "popup.html", "shared/asset-manifest.json"];
  const html = `${await readFile(join(root, "handler.html"), "utf8")}\n${await readFile(join(root, "popup.html"), "utf8")}`;
  const entries = [...html.matchAll(/(?:src|href)="(?:\.\/|\/)(assets\/[A-Za-z0-9._-]+)"/gu)]
    .map((match) => match[1]!);
  const paths = [...new Set([...roots, ...entries, ...shared.map((name) => `shared/${name as string}`)])].sort();
  const records = await Promise.all(paths.map(async (path) => [
    path,
    createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
  ] as const));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

async function extensionTreeDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (prefix === "" && entry.name === ".placekeeper-managed-extension") continue;
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Installed Chrome extension contains a symbolic link.");
      if (entry.isDirectory()) await visit(path, relativePath);
      else {
        hash.update(relativePath);
        hash.update("\0");
        hash.update(await readFile(path));
        hash.update("\0");
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

async function waitForDevToolsPort(profile: string, chrome: ChildProcess): Promise<number> {
  const path = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Google Chrome exited before the release gate connected (${chrome.exitCode}).`);
    const source = await readFile(path, "utf8").catch(() => undefined);
    const port = Number.parseInt(source?.split("\n")[0] ?? "", 10);
    if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) return port;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Google Chrome did not publish its disposable-profile DevTools endpoint.");
}

async function waitForExtension(context: BrowserContext): Promise<ChromeServiceWorker> {
  const expected = `${CHROME_EXTENSION_ORIGIN}background.js`;
  const existing = context.serviceWorkers().find((worker) => worker.url() === expected);
  if (existing !== undefined) return existing;
  return context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url() === expected,
    timeout: EXTENSION_WAIT_MS,
  });
}

async function extensionState(worker: ChromeServiceWorker): Promise<{
  readonly version: string;
  readonly sentinel: boolean | undefined;
  readonly mimeEnabled: boolean;
  readonly mimeApi: boolean;
  readonly runtimeIdentitySha256: string;
}> {
  return worker.evaluate(async ({ sentinelKey, pdfMimeType }) => {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      getManifest(): { readonly version: string };
    };
    const manifest = runtime.getManifest();
    const stored = await chrome.storage.local.get(sentinelKey);
    const mimeApi = typeof chrome.mimeHandler?.getMimeHandlerOptions === "function" &&
      typeof chrome.mimeHandler?.setMimeHandlerOptions === "function" &&
      typeof chrome.mimeHandler?.getStreamInfo === "function" &&
      typeof chrome.mimeHandler?.abortAndFallbackToNativeHandler === "function";
    const mimeEnabled = mimeApi
      ? (await chrome.mimeHandler.getMimeHandlerOptions(pdfMimeType)).enabled
      : false;
    const sha256 = async (bytes: ArrayBuffer): Promise<string> =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const read = async (path: string): Promise<ArrayBuffer> => {
      const response = await fetch(chrome.runtime.getURL(path));
      if (!response.ok) throw new Error(`Extension resource unavailable: ${path}`);
      return response.arrayBuffer();
    };
    const decoder = new TextDecoder();
    const [handlerBytes, popupBytes, sharedManifestBytes] = await Promise.all([
      read("handler.html"), read("popup.html"), read("shared/asset-manifest.json"),
    ]);
    const sharedManifest = JSON.parse(decoder.decode(sharedManifestBytes)) as {
      app: string; stylesheet: string; pdfiumWasm: string; pdfiumWorker: string;
    };
    const html = `${decoder.decode(handlerBytes)}\n${decoder.decode(popupBytes)}`;
    const entries = [...html.matchAll(/(?:src|href)="(?:\.\/|\/)(assets\/[A-Za-z0-9._-]+)"/gu)]
      .map((match) => match[1]!);
    const paths = [...new Set([
      "manifest.json", "background.js", "handler.html", "popup.html", "shared/asset-manifest.json",
      ...entries,
      ...[sharedManifest.app, sharedManifest.stylesheet, sharedManifest.pdfiumWasm, sharedManifest.pdfiumWorker]
        .map((name) => `shared/${name}`),
    ])].sort();
    const known = new Map<string, ArrayBuffer>([
      ["handler.html", handlerBytes], ["popup.html", popupBytes],
      ["shared/asset-manifest.json", sharedManifestBytes],
    ]);
    const records = await Promise.all(paths.map(async (path) => [
      path,
      await sha256(known.get(path) ?? await read(path)),
    ]));
    const runtimeIdentitySha256 = await sha256(new TextEncoder().encode(JSON.stringify(records)).buffer);
    return {
      version: manifest.version,
      sentinel: typeof stored[sentinelKey] === "boolean"
        ? stored[sentinelKey]
        : undefined,
      mimeEnabled,
      mimeApi,
      runtimeIdentitySha256,
    };
  }, { sentinelKey: AUTO_OPEN_SENTINEL_KEY, pdfMimeType: PDF_MIME_TYPE });
}

async function waitForInitialState(
  worker: ChromeServiceWorker,
  expectedRuntimeIdentity: string,
): Promise<ChromeExtensionEvidence> {
  const deadline = Date.now() + 10_000;
  let current = await extensionState(worker);
  while (current.sentinel === undefined && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    current = await extensionState(worker);
  }
  if (!current.mimeApi) throw new Error("Installed Chrome does not expose the complete public PDF MIME-handler API.");
  if (current.runtimeIdentitySha256 !== expectedRuntimeIdentity) {
    throw new Error("Chrome loaded a different Placekeeper extension build than the installed app.");
  }
  if (current.sentinel !== false || current.mimeEnabled) {
    throw new Error("The disposable profile did not start with Placekeeper PDF interception paused.");
  }
  return {
    extensionVersion: current.version,
    startsPaused: true,
    mimeApi: true,
    runtimeIdentitySha256: current.runtimeIdentitySha256,
  };
}

async function waitUntilEnabled(worker: ChromeServiceWorker): Promise<void> {
  const deadline = Date.now() + EXTENSION_WAIT_MS;
  while (Date.now() < deadline) {
    const current = await extensionState(worker);
    if (current.sentinel === true && current.mimeEnabled) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Timed out waiting for automatic PDF opening to be enabled in the Placekeeper popup.");
}

async function titledPdf(source: Uint8Array): Promise<Uint8Array> {
  const document = await PDFDocument.load(source, { updateMetadata: false });
  document.setTitle("Quarterly Results");
  return document.save({ useObjectStreams: true });
}

async function authenticate(page: import("@playwright/test").Page, fixture: ChromePdfFixtureServer): Promise<void> {
  await page.goto(fixture.origin);
  await page.getByLabel("Fixture password").fill("reader");
  await Promise.all([
    page.waitForURL(`${fixture.origin}/`),
    page.getByRole("button", { name: "Start authenticated session" }).click(),
  ]);
}

async function openAndVerify(
  page: import("@playwright/test").Page,
  fixture: ChromePdfFixtureServer,
  expectedTitle: string,
): Promise<{ readonly latencyMs: number; readonly platformProof: PlatformProofEvidence }> {
  await authenticate(page, fixture);
  const sourceUrl = `${fixture.origin}/document?id=42`;
  const started = performance.now();
  await page.getByRole("link", { name: "Suffixless PDF" }).click();
  await page.locator("[data-production-review]").waitFor({ state: "visible", timeout: DOCUMENT_WAIT_MS });
  if (page.url() !== sourceUrl) {
    throw new Error("Embedded review replaced the original PDF URL.");
  }
  await page.waitForFunction((title) => document.title === title, expectedTitle, { timeout: DOCUMENT_WAIT_MS });
  await page.waitForFunction(() =>
    typeof (globalThis as typeof globalThis & { __placekeeperPlatformProof?: unknown })
      .__placekeeperPlatformProof === "object", undefined, { timeout: DOCUMENT_WAIT_MS });
  const platformProof = await page.evaluate(() =>
    (globalThis as typeof globalThis & { __placekeeperPlatformProof: PlatformProofEvidence })
      .__placekeeperPlatformProof);
  if (!platformProof.workerStarted || !platformProof.pdfiumReady ||
    !platformProof.packagedAssetFetch || platformProof.forbiddenWorkerPrivileges.length !== 0) {
    throw new Error("The installed PDFium worker failed its privilege-isolation proof.");
  }
  return { latencyMs: Math.round(performance.now() - started), platformProof };
}

async function waitForEnter(message: string): Promise<void> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { await terminal.question(message); }
  finally { terminal.close(); }
}

async function run(options: RunnerOptions): Promise<void> {
  if (process.platform !== "darwin") throw new Error("The installed-Chrome release gate requires macOS.");
  await access(options.chromePath, constants.X_OK);
  await access(options.pdfPath, constants.R_OK);
  const [{ stdout: versionOutput }, prerequisites, sourcePdf] = await Promise.all([
    execFileAsync(options.chromePath, ["--version"]),
    installedPrerequisites(options.appPath),
    readFile(options.pdfPath),
  ]);
  const chromeVersion = versionOutput.trim();
  const chromeMajor = parseChromeMajor(chromeVersion);
  if (chromeMajor === undefined || chromeMajor < prerequisites.minimumChromeVersion) {
    throw new Error(`Google Chrome ${prerequisites.minimumChromeVersion} or newer is required; found ${chromeVersion || "an unknown version"}.`);
  }

  const metadataPdf = await titledPdf(sourcePdf);
  let metadataFixture: ChromePdfFixtureServer | undefined;
  let filenameFixture: ChromePdfFixtureServer | undefined;
  let profile: string | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let chrome: ChildProcess | undefined;

  try {
    metadataFixture = await startChromePdfFixtureServer({ pdfBytes: metadataPdf });
    filenameFixture = await startChromePdfFixtureServer({ pdfBytes: sourcePdf });
    profile = await mkdtemp(join(tmpdir(), "placekeeper-installed-chrome-"));
    chrome = spawn(options.chromePath, [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "chrome://extensions/",
    ], { stdio: "ignore" });
    const port = await waitForDevToolsPort(profile, chrome);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error("Google Chrome did not expose its disposable browser context.");
    await context.addInitScript(({ loopbackUrl }) => {
      const NativeWorker = globalThis.Worker;
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: new Proxy(NativeWorker, {
          construct(Target, args) {
            const worker = Reflect.construct(Target, args) as Worker;
            const rawUrl = args[0];
            let isPdfiumWorker = false;
            try {
              isPdfiumWorker = new URL(String(rawUrl), globalThis.location.href).pathname
                .endsWith("/shared/pdfium-worker.js");
            } catch {
              isPdfiumWorker = false;
            }
            if (isPdfiumWorker) {
              worker.addEventListener("message", (event: MessageEvent<unknown>) => {
                const value = event.data;
                if (typeof value !== "object" || value === null || Array.isArray(value) ||
                  (value as { type?: unknown }).type !== "placekeeper-pdfium-worker-privilege-probe") return;
                const proof = value as Record<string, unknown>;
                const allowed = new Set(["type", "workerStarted", "pdfiumReady", "packagedAssetFetch"]);
                (globalThis as typeof globalThis & { __placekeeperPlatformProof?: unknown })
                  .__placekeeperPlatformProof = {
                    workerStarted: proof.workerStarted === true,
                    pdfiumReady: proof.pdfiumReady === true,
                    packagedAssetFetch: proof.packagedAssetFetch === true,
                    forbiddenWorkerPrivileges: Object.entries(proof)
                      .filter(([name, enabled]) => !allowed.has(name) && enabled === true)
                      .map(([name]) => name),
                  };
              });
              worker.postMessage({
                type: "start-placekeeper-pdfium-worker-privilege-probe",
                loopbackUrl,
              });
            }
            return worker;
          },
        }),
      });
    }, { loopbackUrl: `${metadataFixture.origin}/worker-probe` });

    process.stdout.write(`\nDisposable Chrome profile is open. Complete these steps there:\n\n` +
      `1. On chrome://extensions, enable Developer mode.\n` +
      `2. Click Load unpacked and select exactly:\n   ${prerequisites.extensionPath}\n` +
      `3. Confirm the extension ID is ${CHROME_EXTENSION_ID}.\n\n` +
      `Waiting up to 10 minutes for that exact packaged extension…\n`);
    const worker = await waitForExtension(context);
    const extension = await waitForInitialState(worker, prerequisites.extensionRuntimeIdentitySha256);
    process.stdout.write(`\nPackaged extension detected and verified paused. Open its Placekeeper toolbar popup and turn on “Open PDFs automatically.”\n`);
    await waitUntilEnabled(worker);

    const page = await context.newPage();
    const metadataResult = await openAndVerify(page, metadataFixture, "Quarterly Results");
    await page.goBack({ waitUntil: "domcontentloaded" });
    if (page.url() !== `${metadataFixture.origin}/`) throw new Error("Browser Back did not return to the fixture landing page.");
    const filenameResult = await openAndVerify(page, filenameFixture, "document");

    const manualEvidence = options.manualEvidencePath === undefined
      ? undefined
      : validateManualEvidence(
          JSON.parse(await readFile(options.manualEvidencePath, "utf8")) as unknown,
          {
            appBuildIdentity: prerequisites.appBuildIdentity,
            chromeVersion,
            extensionRuntimeIdentitySha256: extension.runtimeIdentitySha256,
          },
        );
    const evidence = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      appBuildIdentity: prerequisites.appBuildIdentity,
      chromeVersion,
      extensionId: CHROME_EXTENSION_ID,
      extensionVersion: extension.extensionVersion,
      extensionRuntimeIdentitySha256: extension.runtimeIdentitySha256,
      mimeApi: extension.mimeApi,
      hostManifest: {
        path: prerequisites.hostManifestPath,
        sha256: prerequisites.hostManifestSha256,
      },
      startsPaused: extension.startsPaused,
      outerTab: {
        originalUrlPreserved: true,
        metadataTitle: true,
        filenameFallback: true,
        browserBack: true,
        sharedProductionClient: true,
      },
      platformProof: metadataResult.platformProof,
      firstPageLatencyMs: {
        metadataFixture: metadataResult.latencyMs,
        filenameFixture: filenameResult.latencyMs,
      },
      manualMatrix: manualEvidence === undefined ? "pending" : "passed",
      ...(manualEvidence === undefined ? {} : { manualEvidence }),
    } as const;
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    process.stdout.write(`\nAutomated installed checks passed:\n${serialized}`);
    if (options.evidencePath !== undefined) {
      await writeFile(options.evidencePath, serialized, { flag: "wx", mode: 0o600 });
      process.stdout.write(`Evidence written to ${options.evidencePath}\n`);
    }

    if (manualEvidence === undefined) {
      process.stdout.write(`\nThe Chrome window remains open for AE3–AE8 and the KTD8 repetitions. Use the checklist in test/acceptance/installed-hosts.md.\n`);
      await waitForEnter("Press Enter to close and erase the disposable profile. The gate remains failed until --manual-evidence is supplied. ");
      throw new Error("Automated checks passed, but the installed manual matrix and KTD8 evidence remain pending.");
    }
  } finally {
    await browser?.close().catch(() => undefined);
    if (chrome?.exitCode === null) chrome.kill("SIGTERM");
    await Promise.all([
      metadataFixture?.close(),
      filenameFixture?.close(),
    ]);
    if (profile !== undefined) await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void run(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`Installed Chrome gate failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
