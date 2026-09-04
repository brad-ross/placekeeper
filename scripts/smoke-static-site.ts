import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type APIRequestContext, type Browser } from "@playwright/test";
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

import { sha256Hex } from "../packages/core/src/sha256.js";
import { addStaticKeyboardPageNote, waitForStaticPdf } from "./static-browser-journey.js";

const EXPECTED_URL = "https://brad-ross.github.io/placekeeper/";
const MAX_PROPAGATION_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_ENVIRONMENT_KEYS = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_PAT",
  "GITHUB_TOKEN",
  "PLACEKEEPER_PAGES_TOKEN",
] as const;
const TRUSTED_ORIGINS = new Set([
  "git@github.com:brad-ross/placekeeper.git",
  "https://github.com/brad-ross/placekeeper",
  "https://github.com/brad-ross/placekeeper.git",
  "ssh://git@github.com/brad-ross/placekeeper.git",
]);

type TerminalResult =
  | "passed"
  | "propagation-timeout"
  | "superseded"
  | "regression"
  | "first-release-failure";

export interface CliOptions {
  readonly targetUrl: string;
  readonly sourceSha: string;
  readonly contentDigest: string;
  readonly firstRelease: boolean;
}

interface ContentManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CoherentIdentity {
  readonly sourceSha: string;
  readonly contentDigest: string;
  readonly manifest: readonly ContentManifestEntry[];
}

interface SmokeRecord {
  readonly schemaVersion: 1;
  readonly probeCommit: string;
  readonly targetUrl: string;
  readonly deployedSourceSha: string;
  readonly payloadDigest: string;
  readonly browserVersion: string;
  readonly timestamp: string;
  readonly result: TerminalResult;
  readonly observedSourceSha?: string;
  readonly observedPayloadDigest?: string;
  readonly detail: string;
}

class IdentityReadError extends Error {
  constructor(message: string, readonly observedSourceSha?: string) {
    super(message);
    this.name = "IdentityReadError";
  }
}

export function parseArguments(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let firstRelease = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") continue;
    if (argument === "--first-release") {
      firstRelease = true;
      continue;
    }
    if (!["--url", "--source", "--content"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}.`);
    values.set(argument, value);
    index += 1;
  }
  const targetUrl = values.get("--url");
  const sourceSha = values.get("--source")?.toLowerCase();
  const contentDigest = values.get("--content")?.toLowerCase();
  if (targetUrl === undefined || sourceSha === undefined || contentDigest === undefined) {
    throw new Error("Usage: pnpm smoke:static-pages -- --url <page-url> --source <source-sha> --content <content-manifest-sha256> [--first-release]");
  }
  if (targetUrl !== EXPECTED_URL) throw new Error(`The reviewed Pages target is exactly ${EXPECTED_URL}`);
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) throw new Error("--source must be a full lowercase commit SHA.");
  if (!/^[0-9a-f]{64}$/u.test(contentDigest)) throw new Error("--content must be a lowercase SHA-256 digest.");
  return { targetUrl, sourceSha, contentDigest, firstRelease };
}

function git(...args: readonly string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function assertTokenlessTrustedCheckout(options: CliOptions): void {
  const presentTokens = TOKEN_ENVIRONMENT_KEYS.filter((key) => (process.env[key]?.length ?? 0) > 0);
  if (presentTokens.length > 0) {
    throw new Error(`Refusing to run with token-bearing environment variables: ${presentTokens.join(", ")}.`);
  }
  if (git("rev-parse", "--is-inside-work-tree") !== "true") throw new Error("Smoke must run in a Git worktree.");
  const head = git("rev-parse", "HEAD").toLowerCase();
  if (head !== options.sourceSha) throw new Error("The clean probe checkout HEAD does not equal --source.");
  if (git("status", "--porcelain=v1", "--untracked-files=all") !== "") {
    throw new Error("The probe checkout is not clean; preserve evidence and use a clean trusted checkout.");
  }
  const origin = git("config", "--get", "remote.origin.url").replace(/\/$/u, "");
  if (!TRUSTED_ORIGINS.has(origin)) throw new Error("remote.origin.url is not the reviewed brad-ross/placekeeper repository.");
  const trustedMain = git("rev-parse", "refs/remotes/origin/main").toLowerCase();
  if (trustedMain !== head) throw new Error("The local trusted origin/main ref does not equal the deployed source; fetch and verify it first.");
}

function responsePathMatches(responseUrl: string, expectedUrl: URL): boolean {
  const observed = new URL(responseUrl);
  return observed.origin === expectedUrl.origin && observed.pathname === expectedUrl.pathname;
}

async function fetchBytes(
  request: APIRequestContext,
  absoluteUrl: URL,
  deadline: number,
): Promise<{ readonly bytes: Buffer; readonly contentType: string }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Propagation deadline reached.");
  absoluteUrl.searchParams.set("placekeeper_probe", `${Date.now()}-${randomUUID()}`);
  const response = await request.get(absoluteUrl.href, {
    failOnStatusCode: false,
    headers: { "cache-control": "no-cache", pragma: "no-cache" },
    timeout: Math.min(REQUEST_TIMEOUT_MS, remaining),
  });
  if (!responsePathMatches(response.url(), absoluteUrl)) throw new Error(`Unexpected redirect while reading ${absoluteUrl.pathname}.`);
  if (response.status() !== 200) throw new Error(`${absoluteUrl.pathname} returned HTTP ${response.status()}.`);
  return {
    bytes: await response.body(),
    contentType: response.headers()["content-type"] ?? "",
  };
}

export function parseIdentity(versionBytes: Buffer, manifestBytes: Buffer): CoherentIdentity {
  const version = JSON.parse(versionBytes.toString("utf8")) as Record<string, unknown>;
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    readonly schemaVersion?: unknown;
    readonly entries?: readonly Record<string, unknown>[];
  };
  const contentDigest = sha256Hex(manifestBytes);
  const observedSourceSha = typeof version.sourceSha === "string" && /^[0-9a-f]{40}$/u.test(version.sourceSha)
    ? version.sourceSha
    : undefined;
  if (
    version.schemaVersion !== 1
    || observedSourceSha === undefined
    || version.base !== "/placekeeper/"
    || version.contentManifestSha256 !== contentDigest
    || manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries)
  ) throw new IdentityReadError(
    "The published version and content manifest are not a coherent supported identity.",
    observedSourceSha,
  );

  const seen = new Set<string>();
  const entries = manifest.entries.map((candidate): ContentManifestEntry => {
    const { path, bytes, sha256: digest } = candidate;
    if (
      typeof path !== "string" || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/u.test(path)
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0
      || typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)
      || seen.has(path)
    ) throw new Error("The published content manifest contains an unsafe or malformed entry.");
    seen.add(path);
    return { path, bytes, sha256: digest };
  });
  return { sourceSha: observedSourceSha, contentDigest, manifest: entries };
}

async function readCoherentIdentity(
  request: APIRequestContext,
  targetUrl: string,
  deadline: number,
): Promise<CoherentIdentity> {
  const [version, manifest] = await Promise.all([
    fetchBytes(request, new URL("version.json", targetUrl), deadline),
    fetchBytes(request, new URL("content-manifest.json", targetUrl), deadline),
  ]);
  return parseIdentity(version.bytes, manifest.bytes);
}

function observedSourceIsNewer(expected: string, observed: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${observed}^{commit}`], { stdio: "ignore" });
    execFileSync("git", ["merge-base", "--is-ancestor", expected, observed], { stdio: "ignore" });
    return expected !== observed;
  } catch {
    return false;
  }
}

async function pollForExpectedIdentity(
  request: APIRequestContext,
  options: CliOptions,
): Promise<{ readonly identity?: CoherentIdentity; readonly result?: TerminalResult; readonly detail: string; readonly observed?: CoherentIdentity }> {
  const deadline = Date.now() + MAX_PROPAGATION_MS;
  let delayMs = 1_000;
  let lastCoherent: CoherentIdentity | undefined;
  let sawExpectedSource = false;
  let lastError = "No live identity was observed.";
  while (Date.now() < deadline) {
    try {
      const observed = await readCoherentIdentity(request, options.targetUrl, deadline);
      lastCoherent = observed;
      sawExpectedSource ||= observed.sourceSha === options.sourceSha;
      if (observed.sourceSha === options.sourceSha && observed.contentDigest === options.contentDigest) {
        return { identity: observed, detail: "Expected coherent identity observed." };
      }
      if (observedSourceIsNewer(options.sourceSha, observed.sourceSha)) {
        return { result: "superseded", detail: "A newer coherent source identity replaced the requested candidate.", observed };
      }
      lastError = observed.sourceSha === options.sourceSha
        ? "Expected source appeared with a different payload digest."
        : "A prior or different coherent identity remained live during propagation.";
    } catch (error) {
      if (error instanceof IdentityReadError && error.observedSourceSha === options.sourceSha) {
        sawExpectedSource = true;
      }
      lastError = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(delayMs, remaining)));
    delayMs = Math.min(delayMs * 2, 15_000);
  }
  if (options.firstRelease) {
    return {
      result: "first-release-failure",
      detail: "The first release did not produce the expected coherent identity before the propagation deadline.",
      ...(lastCoherent === undefined ? {} : { observed: lastCoherent }),
    };
  }
  if (sawExpectedSource) {
    return {
      result: "regression",
      detail: `The expected source appeared without its expected payload cohort: ${lastError}`,
      ...(lastCoherent === undefined ? {} : { observed: lastCoherent }),
    };
  }
  return {
    result: "propagation-timeout",
    detail: `Expected identity was not coherent within ten minutes: ${lastError}`,
    ...(lastCoherent === undefined ? {} : { observed: lastCoherent }),
  };
}

async function verifyCompletePayload(
  request: APIRequestContext,
  targetUrl: string,
  identity: CoherentIdentity,
): Promise<void> {
  const deadline = Date.now() + Math.min(MAX_PROPAGATION_MS, 2 * 60 * 1_000);
  let sawWorker = false;
  let sawWasm = false;
  const batchSize = 4;
  for (let offset = 0; offset < identity.manifest.length; offset += batchSize) {
    const entries = identity.manifest.slice(offset, offset + batchSize);
    const responses = await Promise.allSettled(
      entries.map((entry) => fetchBytes(request, new URL(entry.path, targetUrl), deadline)),
    );
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const settled = responses[index]!;
      if (settled.status === "rejected") throw settled.reason;
      const response = settled.value;
      if (response.bytes.byteLength !== entry.bytes || sha256Hex(response.bytes) !== entry.sha256) {
        throw new Error(`Published payload does not match the manifest entry ${entry.path}.`);
      }
      if (/pdfium-worker-[A-Za-z0-9_-]{8,}\.js$/u.test(entry.path)) {
        sawWorker = true;
        if (!/^(?:application|text)\/(?:javascript|x-javascript)\b/iu.test(response.contentType)) {
          throw new Error(`PDFium worker has unsafe MIME type ${response.contentType || "(missing)"}.`);
        }
      }
      if (/\.wasm$/u.test(entry.path)) {
        sawWasm = true;
        if (!/^application\/wasm(?:;|$)/iu.test(response.contentType)) {
          throw new Error(`PDFium WASM has unsafe MIME type ${response.contentType || "(missing)"}.`);
        }
      }
    }
  }
  if (!sawWorker || !sawWasm) throw new Error("The complete payload lacks its declared PDFium worker or WASM asset.");
}

export async function createSmokePdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage([612, 792]);
  const font = await document.embedFont(StandardFonts.Helvetica);
  page.drawText("Placekeeper local release smoke", { x: 72, y: 690, size: 14, font });
  const context = document.context;
  const appearance = context.flateStream("1 1 0 rg 0 0 188 20 re f", {
    Type: "XObject",
    Subtype: "Form",
    BBox: [0, 0, 188, 20],
    Resources: {},
  });
  const normalAppearance = context.obj({ N: context.register(appearance) });
  const highlight = context.obj({
    Type: "Annot",
    Subtype: "Highlight",
    NM: PDFString.of("smoke-foreign-highlight"),
    Contents: PDFString.of("Foreign smoke annotation"),
    Rect: [72, 680, 260, 700],
    QuadPoints: [72, 700, 260, 700, 72, 680, 260, 680],
    C: [1, 1, 0],
    F: 4,
    AP: normalAppearance,
  });
  const annotations = PDFArray.withContext(context);
  annotations.push(context.register(highlight));
  page.node.set(PDFName.of("Annots"), annotations);
  return document.save({ useObjectStreams: true });
}

async function runLocalPdfJourney(browser: Browser, targetUrl: string, sourceSha: string): Promise<void> {
  const sourcePdf = await createSmokePdf();
  const comment = `Pages smoke ${sourceSha.slice(0, 12)}`;
  const authoring = await browser.newContext({ acceptDownloads: true });
  let exportedPdf: Buffer;
  try {
    const page = await authoring.newPage();
    await page.goto(`${targetUrl}?placekeeper_smoke=${randomUUID()}`, { waitUntil: "domcontentloaded" });
    await page.locator("input[type=file]").setInputFiles({
      name: "placekeeper-release-smoke.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(sourcePdf),
    });
    await waitForStaticPdf(page);
    await addStaticKeyboardPageNote(page, comment);
    await page.getByRole("button", { name: /Open document actions$/u }).click();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: /^(?:Retry export|Export)$/u }).click();
    const download = await downloadPromise;
    const temporaryPath = await download.path();
    if (temporaryPath === null) throw new Error("The browser did not expose the exported PDF for independent reopen.");
    exportedPdf = await readFile(temporaryPath);
    await page.locator("[data-export-result='success']").waitFor({ state: "visible" });
  } finally {
    await authoring.close();
  }

  const reopening = await browser.newContext();
  try {
    const page = await reopening.newPage();
    await page.goto(`${targetUrl}?placekeeper_smoke=${randomUUID()}`, { waitUntil: "domcontentloaded" });
    await page.locator("input[type=file]").setInputFiles({
      name: "placekeeper-release-smoke-reviewed.pdf",
      mimeType: "application/pdf",
      buffer: exportedPdf!,
    });
    await waitForStaticPdf(page);
    const ownedMarks = page.locator("[data-owned-mark='pageNote']");
    if (await ownedMarks.count() !== 1) throw new Error("Independent reopen did not restore exactly one owned Page Note.");
    if (await page.locator("[data-review-item]", { hasText: comment }).count() !== 1) {
      throw new Error("Independent reopen did not restore the exported item as editable exactly once.");
    }
    if (await page.locator("[data-existing-annotation='smoke-foreign-highlight']").count() !== 1) {
      throw new Error("Independent reopen did not preserve the representative foreign annotation.");
    }
  } finally {
    await reopening.close();
  }
}

function safeDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, " ").slice(0, 500);
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  assertTokenlessTrustedCheckout(options);
  const browser = await chromium.launch({ headless: true });
  let record: SmokeRecord;
  try {
    const probe = await browser.newContext();
    const browserVersion = browser.version();
    let polled: Awaited<ReturnType<typeof pollForExpectedIdentity>>;
    try {
      polled = await pollForExpectedIdentity(probe.request, options);
      if (polled.identity === undefined) {
        record = {
          schemaVersion: 1,
          probeCommit: options.sourceSha,
          targetUrl: options.targetUrl,
          deployedSourceSha: options.sourceSha,
          payloadDigest: options.contentDigest,
          browserVersion,
          timestamp: new Date().toISOString(),
          result: polled.result!,
          ...(polled.observed === undefined ? {} : {
            observedSourceSha: polled.observed.sourceSha,
            observedPayloadDigest: polled.observed.contentDigest,
          }),
          detail: polled.detail,
        };
      } else {
        try {
          await verifyCompletePayload(probe.request, options.targetUrl, polled.identity);
          await probe.close();
          await runLocalPdfJourney(browser, options.targetUrl, options.sourceSha);
          record = {
            schemaVersion: 1,
            probeCommit: options.sourceSha,
            targetUrl: options.targetUrl,
            deployedSourceSha: options.sourceSha,
            payloadDigest: options.contentDigest,
            browserVersion,
            timestamp: new Date().toISOString(),
            result: "passed",
            observedSourceSha: polled.identity.sourceSha,
            observedPayloadDigest: polled.identity.contentDigest,
            detail: "Identity, complete payload, MIME policy, and independent editable PDF reopen passed.",
          };
        } catch (error) {
          record = {
            schemaVersion: 1,
            probeCommit: options.sourceSha,
            targetUrl: options.targetUrl,
            deployedSourceSha: options.sourceSha,
            payloadDigest: options.contentDigest,
            browserVersion,
            timestamp: new Date().toISOString(),
            result: options.firstRelease ? "first-release-failure" : "regression",
            observedSourceSha: polled.identity.sourceSha,
            observedPayloadDigest: polled.identity.contentDigest,
            detail: safeDetail(error),
          };
        }
      }
    } finally {
      await probe.close().catch(() => undefined);
    }
  } finally {
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify(record!)}\n`);
  if (record!.result !== "passed") process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeDetail(error)}\n`);
    process.exitCode = 1;
  });
}
