import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { SourceHint } from "../../../../packages/core/src/handoff.js";
import type { ReviewItem } from "../../../../packages/core/src/review-model.js";
import type { FrozenReviewDelivery } from "../export/export-coordinator.js";
import { isContained } from "../files/file-capabilities.js";
import { parseSyncTexOutput } from "./parser.js";

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
    child.on("error", () => finish(null));
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
}

export async function querySyncTex(input: QuerySyncTexInput): Promise<SourceHint | undefined> {
  const sourceRoot = await realpath(input.sourceRoot);
  const timeoutMs = 2_000;
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
  const hints = new Map<string, SourceHint>();
  if (input.delivery.sourceRootPath === undefined) return hints;
  for (const item of input.delivery.items) {
    const point = geometryPoint(item);
    if (point === undefined) continue;
    const hint = await querySyncTex({
      sourceRoot: input.delivery.sourceRootPath,
      pdfPath: input.pdfPath,
      pageIndex: item.pageIndex,
      point,
      ...(input.run === undefined ? {} : { run: input.run }),
    });
    if (hint !== undefined) hints.set(item.id, hint);
  }
  return hints;
}
