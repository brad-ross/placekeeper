import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { SourceHint } from "../../../../packages/core/src/structured-review-item.js";
import type { ReviewItem } from "../../../../packages/core/src/review-model.js";
import type { FrozenReviewDelivery } from "../export/export-coordinator.js";
import { isContained } from "../files/file-capabilities.js";
import {
  canonicalSourceRoot,
  resolveSyncTexSourcePath,
  UnsafeSourcePathError,
} from "../files/source-scope.js";
import type {
  GenerationOutputIdentity,
  GenerationSyncTexSnapshot,
} from "../recovery/source-snapshot.js";
import { parseSyncTexOutput, parseSyncTexViewOutput } from "./parser.js";

export interface SyncTexRunRequest {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface SyncTexRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut?: boolean;
  readonly oversized?: boolean;
  readonly unavailableTool?: boolean;
}

export type SyncTexRunner = (request: SyncTexRunRequest) => Promise<SyncTexRunResult>;

export const runSyncTex: SyncTexRunner = (request) =>
  new Promise((resolveRun) => {
    const child = spawn(request.executable, [...request.argv], {
      cwd: request.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let oversized = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolveRun({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        ...(oversized ? { oversized: true } : {}),
      });
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > request.maxOutputBytes) {
        oversized = true;
        child.kill("SIGKILL");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolveRun({ stdout: "", stderr: "", exitCode: null, unavailableTool: true });
        return;
      }
      finish(null);
    });
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
  });

export interface QuerySyncTexInput {
  readonly sourceRoot: string;
  readonly pdfPath: string;
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly run?: SyncTexRunner;
  readonly timeoutMs?: number;
}

export async function querySyncTex(input: QuerySyncTexInput): Promise<SourceHint | undefined> {
  const sourceRoot = await realpath(input.sourceRoot);
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 2_000, 2_000));
  const maxOutputBytes = 64 * 1024;
  const result = await (input.run ?? runSyncTex)({
    executable: "synctex",
    argv: ["edit", "-o", `${input.pageIndex + 1}:${input.point.x}:${input.point.y}:${input.pdfPath}`],
    cwd: sourceRoot,
    timeoutMs,
    maxOutputBytes,
  });
  if (
    result.exitCode !== 0 || result.timedOut === true || result.oversized === true ||
    Buffer.byteLength(result.stdout) > maxOutputBytes
  ) return undefined;

  const candidates = parseSyncTexOutput(result.stdout)
    .filter((candidate) => candidate.page === undefined || candidate.page === input.pageIndex + 1)
    .sort((left, right) => {
      const distance = (candidate: { x?: number; y?: number }) =>
        candidate.x === undefined || candidate.y === undefined
          ? Number.MAX_SAFE_INTEGER
          : Math.hypot(candidate.x - input.point.x, candidate.y - input.point.y);
      return distance(left) - distance(right);
    });
  for (const candidate of candidates) {
    try {
      if (candidate.path.includes("\0")) continue;
      const normalizedAbsolute = isAbsolute(candidate.path);
      const lexical = resolve(normalizedAbsolute ? candidate.path : resolve(sourceRoot, candidate.path));
      if (!normalizedAbsolute && !isContained(sourceRoot, lexical)) continue;
      const physical = await realpath(lexical);
      if (!isContained(sourceRoot, physical)) continue;
      const path = relative(sourceRoot, physical);
      if (path.length === 0 || path.startsWith("..") || isAbsolute(path)) continue;
      const approximate = candidate.x !== undefined && candidate.y !== undefined &&
        Math.hypot(candidate.x - input.point.x, candidate.y - input.point.y) > 72;
      return {
        path,
        line: candidate.line,
        confidence: approximate || normalizedAbsolute ? "low" : "high",
        provenance: "synctex",
      };
    } catch {
      // Missing, stale, or inaccessible SyncTeX targets are advisory failures.
    }
  }
  return undefined;
}

function geometryPoint(item: ReviewItem): { x: number; y: number } | undefined {
  const value = item.payload[item.kind === "insert" || item.kind === "pageNote" ? "position" : "rect"];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { x, y, width, height } = record;
  return [x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part))
    ? { x: (x as number) + (width as number) / 2, y: (y as number) + (height as number) / 2 }
    : undefined;
}

export async function querySyncTexHints(input: {
  readonly delivery: FrozenReviewDelivery;
  readonly pdfPath: string;
  readonly run?: SyncTexRunner;
}): Promise<ReadonlyMap<string, SourceHint>> {
  if (input.delivery.sourceRootPath === undefined) return new Map();
  return querySyncTexHintsForItems({
    items: input.delivery.items,
    sourceRoot: input.delivery.sourceRootPath,
    pdfPath: input.pdfPath,
    ...(input.run === undefined ? {} : { run: input.run }),
  });
}

export async function querySyncTexHintsForItems(input: {
  readonly items: readonly ReviewItem[];
  readonly sourceRoot: string;
  readonly pdfPath: string;
  readonly run?: SyncTexRunner;
  readonly timeoutMs?: number;
}): Promise<ReadonlyMap<string, SourceHint>> {
  const hints = new Map<string, SourceHint>();
  for (const item of input.items) {
    const point = geometryPoint(item);
    if (point === undefined) continue;
    const hint = await querySyncTex({
      sourceRoot: input.sourceRoot,
      pdfPath: input.pdfPath,
      pageIndex: item.pageIndex,
      point,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.run === undefined ? {} : { run: input.run }),
    });
    if (hint !== undefined) hints.set(item.id, hint);
  }
  return hints;
}

export interface GenerationSyncTexBinding {
  readonly outputIdentity: GenerationOutputIdentity;
  readonly documentGeneration: number;
  readonly pdfDigest: string;
  readonly privatePdfPath: string;
  readonly sidecar: GenerationSyncTexSnapshot;
  readonly sourceRoot: string;
  readonly operationToken: string;
}

export type SyncTexNavigationStatus =
  | "ok"
  | "missing"
  | "pending"
  | "stale"
  | "ambiguous"
  | "out-of-root"
  | "unavailable-tool"
  | "timeout"
  | "oversized"
  | "malformed"
  | "failed";

export interface SyncTexNavigationBase {
  readonly status: SyncTexNavigationStatus;
  readonly operationToken: string;
  readonly documentGeneration: number;
  readonly pdfDigest: string;
  readonly sidecarFingerprint: GenerationSyncTexSnapshot["fingerprint"];
  readonly outputIdentity: GenerationOutputIdentity;
  readonly reason?: string;
}

export type ForwardSyncTexResult = SyncTexNavigationBase & {
  readonly target?: { readonly pageIndex: number; readonly x: number; readonly y: number };
};

export type ReverseSyncTexResult = SyncTexNavigationBase & {
  readonly target?: {
    readonly path: string;
    readonly line: number;
    readonly column?: number;
    readonly confidence: "high" | "low";
    readonly provenance: "synctex";
  };
};

function navigationResult(
  binding: GenerationSyncTexBinding,
  status: SyncTexNavigationStatus,
  reason?: string,
): SyncTexNavigationBase {
  return {
    status,
    operationToken: binding.operationToken,
    documentGeneration: binding.documentGeneration,
    pdfDigest: binding.pdfDigest,
    sidecarFingerprint: binding.sidecar.fingerprint,
    outputIdentity: binding.outputIdentity,
    ...(reason === undefined ? {} : { reason }),
  };
}

function classifyRunFailure(
  binding: GenerationSyncTexBinding,
  result: SyncTexRunResult,
  maxOutputBytes: number,
): SyncTexNavigationBase | undefined {
  if (result.unavailableTool === true) {
    return navigationResult(binding, "unavailable-tool", "synctex-executable-unavailable");
  }
  if (result.timedOut === true) return navigationResult(binding, "timeout", "synctex-query-timed-out");
  if (
    result.oversized === true ||
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes
  ) return navigationResult(binding, "oversized", "synctex-output-exceeded-limit");
  if (result.exitCode === null) return navigationResult(binding, "unavailable-tool", "synctex-could-not-start");
  if (result.exitCode !== 0) return navigationResult(binding, "failed", "synctex-query-failed");
  return undefined;
}

const privatePairIntegrityCache = new Map<string, string>();

async function hashStablePrivateFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await handle.stat();
    if (
      !before.isFile() || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs
    ) throw new Error("Private SyncTeX input changed during integrity validation");
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function validatePrivatePair(binding: GenerationSyncTexBinding): Promise<boolean> {
  if (
    binding.operationToken.length === 0 || binding.operationToken.length > 256 ||
    binding.operationToken.includes("\0") || !Number.isSafeInteger(binding.documentGeneration) ||
    binding.documentGeneration <= 0
  ) return false;
  const pdfName = basename(binding.privatePdfPath);
  const pdfStem = pdfName.toLowerCase().endsWith(".pdf") ? pdfName.slice(0, -4) : pdfName;
  const expectedSidecarNames = new Set([`${pdfStem}.synctex`, `${pdfStem}.synctex.gz`]);
  if (
    dirname(binding.privatePdfPath) !== dirname(binding.sidecar.snapshotPath) ||
    !expectedSidecarNames.has(basename(binding.sidecar.snapshotPath))
  ) return false;
  try {
    const [pdfInfo, sidecarInfo] = await Promise.all([
      lstat(binding.privatePdfPath),
      lstat(binding.sidecar.snapshotPath),
    ]);
    if (!(pdfInfo.isFile() && !pdfInfo.isSymbolicLink() &&
      sidecarInfo.isFile() && !sidecarInfo.isSymbolicLink() &&
      pdfInfo.size === binding.outputIdentity.byteLength &&
      sidecarInfo.size === binding.sidecar.fingerprint.byteLength)) return false;
    const cacheKey = [
      binding.privatePdfPath,
      binding.pdfDigest,
      binding.sidecar.snapshotPath,
      binding.sidecar.fingerprint.digest,
    ].join("\0");
    const identity = `${pdfInfo.dev}:${pdfInfo.ino}:${pdfInfo.size}:${pdfInfo.mtimeMs}:` +
      `${sidecarInfo.dev}:${sidecarInfo.ino}:${sidecarInfo.size}:${sidecarInfo.mtimeMs}`;
    if (privatePairIntegrityCache.get(cacheKey) === identity) return true;
    const [pdfDigest, sidecarDigest] = await Promise.all([
      hashStablePrivateFile(binding.privatePdfPath),
      hashStablePrivateFile(binding.sidecar.snapshotPath),
    ]);
    if (
      pdfDigest !== binding.pdfDigest || sidecarDigest !== binding.sidecar.fingerprint.digest
    ) return false;
    privatePairIntegrityCache.set(cacheKey, identity);
    if (privatePairIntegrityCache.size > 256) {
      privatePairIntegrityCache.delete(privatePairIntegrityCache.keys().next().value!);
    }
    return true;
  } catch {
    return false;
  }
}

function forwardOutputMatches(privatePdfPath: string, output: string): boolean {
  if (output.includes("\0")) return false;
  const candidate = isAbsolute(output)
    ? resolve(output)
    : resolve(dirname(privatePdfPath), output);
  return candidate === resolve(privatePdfPath);
}

export async function queryForwardSyncTex(input: {
  readonly binding: GenerationSyncTexBinding;
  readonly sourcePath: string;
  readonly line: number;
  readonly column?: number;
  readonly run?: SyncTexRunner;
  readonly timeoutMs?: number;
  readonly isCurrent?: (binding: GenerationSyncTexBinding) => boolean | Promise<boolean>;
}): Promise<ForwardSyncTexResult> {
  const { binding } = input;
  if (!await validatePrivatePair(binding)) {
    return navigationResult(binding, "stale", "private-generation-pair-failed-integrity-check");
  }
  let root: string;
  let source: { readonly path: string; readonly relativePath: string };
  try {
    root = await canonicalSourceRoot(binding.sourceRoot);
    source = await resolveSyncTexSourcePath(root, input.sourcePath);
  } catch (error) {
    return navigationResult(
      binding,
      error instanceof UnsafeSourcePathError ? "out-of-root" : "stale",
      "forward-source-is-not-a-contained-current-file",
    );
  }
  if (
    !Number.isSafeInteger(input.line) || input.line < 1 ||
    (input.column !== undefined && (!Number.isSafeInteger(input.column) || input.column < 0))
  ) return navigationResult(binding, "malformed", "invalid-forward-source-position");
  if (input.isCurrent !== undefined && !await input.isCurrent(binding)) {
    return navigationResult(binding, "stale", "operation-binding-is-no-longer-current");
  }
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 2_000, 2_000));
  const maxOutputBytes = 64 * 1024;
  const result = await (input.run ?? runSyncTex)({
    executable: "synctex",
    argv: [
      "view",
      "-i",
      `${input.line}:${input.column ?? 0}:${source.path}`,
      "-o",
      binding.privatePdfPath,
    ],
    cwd: root,
    timeoutMs,
    maxOutputBytes,
  });
  const failure = classifyRunFailure(binding, result, maxOutputBytes);
  if (failure !== undefined) return failure;
  const candidates = parseSyncTexViewOutput(result.stdout).filter((candidate) =>
    forwardOutputMatches(binding.privatePdfPath, candidate.output)
  );
  if (candidates.length === 0) return navigationResult(binding, "malformed", "no-bound-forward-target");
  const unique = new Map(candidates.map((candidate) => [
    `${candidate.page}:${candidate.x}:${candidate.y}`,
    candidate,
  ]));
  if (unique.size !== 1) return navigationResult(binding, "ambiguous", "multiple-forward-targets");
  if (input.isCurrent !== undefined && !await input.isCurrent(binding)) {
    return navigationResult(binding, "stale", "operation-binding-changed-before-forward-result");
  }
  const candidate = [...unique.values()][0]!;
  return {
    ...navigationResult(binding, "ok"),
    target: { pageIndex: candidate.page - 1, x: candidate.x, y: candidate.y },
  };
}

export async function queryReverseSyncTex(input: {
  readonly binding: GenerationSyncTexBinding;
  readonly pageIndex: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly run?: SyncTexRunner;
  readonly timeoutMs?: number;
  readonly isCurrent?: (binding: GenerationSyncTexBinding) => boolean | Promise<boolean>;
}): Promise<ReverseSyncTexResult> {
  const { binding } = input;
  if (!await validatePrivatePair(binding)) {
    return navigationResult(binding, "stale", "private-generation-pair-failed-integrity-check");
  }
  if (
    !Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0 ||
    !Number.isFinite(input.point.x) || !Number.isFinite(input.point.y)
  ) return navigationResult(binding, "malformed", "invalid-reverse-pdf-position");
  let root: string;
  try {
    root = await canonicalSourceRoot(binding.sourceRoot);
  } catch {
    return navigationResult(binding, "out-of-root", "approved-source-root-is-unavailable");
  }
  if (input.isCurrent !== undefined && !await input.isCurrent(binding)) {
    return navigationResult(binding, "stale", "operation-binding-is-no-longer-current");
  }
  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? 2_000, 2_000));
  const maxOutputBytes = 64 * 1024;
  const result = await (input.run ?? runSyncTex)({
    executable: "synctex",
    argv: ["edit", "-o", `${input.pageIndex + 1}:${input.point.x}:${input.point.y}:${binding.privatePdfPath}`],
    cwd: root,
    timeoutMs,
    maxOutputBytes,
  });
  const failure = classifyRunFailure(binding, result, maxOutputBytes);
  if (failure !== undefined) return failure;
  const parsed = parseSyncTexOutput(result.stdout)
    .filter((candidate) => candidate.page === undefined || candidate.page === input.pageIndex + 1);
  if (parsed.length === 0) return navigationResult(binding, "malformed", "no-reverse-target");
  const contained = new Map<string, {
    path: string;
    line: number;
    column?: number;
    confidence: "high" | "low";
    provenance: "synctex";
  }>();
  let rejectedPath = false;
  for (const candidate of parsed) {
    try {
      const resolved = await resolveSyncTexSourcePath(root, candidate.path);
      const approximate = candidate.x !== undefined && candidate.y !== undefined &&
        Math.hypot(candidate.x - input.point.x, candidate.y - input.point.y) > 72;
      const target = {
        path: resolved.relativePath,
        line: candidate.line,
        ...(candidate.column === undefined ? {} : { column: candidate.column }),
        confidence: approximate || isAbsolute(candidate.path) ? "low" as const : "high" as const,
        provenance: "synctex" as const,
      };
      contained.set(`${target.path}\0${target.line}\0${target.column ?? ""}`, target);
    } catch {
      rejectedPath = true;
    }
  }
  if (contained.size === 0) {
    return navigationResult(
      binding,
      rejectedPath ? "out-of-root" : "malformed",
      "no-unique-contained-reverse-target",
    );
  }
  if (contained.size !== 1) return navigationResult(binding, "ambiguous", "multiple-contained-reverse-targets");
  if (input.isCurrent !== undefined && !await input.isCurrent(binding)) {
    return navigationResult(binding, "stale", "operation-binding-changed-before-reverse-result");
  }
  return { ...navigationResult(binding, "ok"), target: [...contained.values()][0]! };
}
