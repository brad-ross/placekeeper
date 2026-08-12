import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { LiveDispositionItemV1 } from "../../../../packages/core/src/disposition.js";
import type { PdfEvidenceRequest } from "../context/pdf-evidence-service.js";
import type { SourceReplacementProposalV1 } from "../context/source-reconciliation-service.js";
import type { ProofreaderControlRequest, ProofreaderControlResponse } from "../host/launch-control.js";
import { controlThroughDaemon } from "../host/service-daemon.js";

type ControlClient = (request: ProofreaderControlRequest) => Promise<ProofreaderControlResponse>;

const HANDLE = /^[A-Za-z0-9._~-]{16,512}$/u;
const INSTALLED = '"$HOME/Applications/PDF Proofreader.app/Contents/MacOS/pdf-proofreader"';

export interface ParsedContextEvidenceRequest {
  readonly handle: string;
  readonly request: PdfEvidenceRequest;
  readonly outputPath?: string;
}

export interface ParsedContextItemsRequest {
  readonly handle: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly pageIndex?: number;
  readonly maxBytes?: number;
}

function valueAfter(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("A context option is missing its value");
  return value;
}

function integer(value: string): number {
  if (!/^\d+$/u.test(value)) throw new Error("Context bounds must be non-negative integers");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Context bounds are too large");
  return parsed;
}

function parsedJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

async function requestPayload(args: readonly string[], flag: string, label: string): Promise<unknown> {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const path = valueAfter(args, index);
  if (!isAbsolute(path)) throw new Error(`${label} input path must be absolute`);
  const bytes = await readFile(path);
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error(`${label} input exceeds the 2 MiB limit`);
  return parsedJson(bytes.toString("utf8"), label);
}

function withoutFilePayloadFlags(args: readonly string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (["--proposal-file", "--guards-file", "--items-file"].includes(args[index]!)) {
      index += 1;
      continue;
    }
    filtered.push(args[index]!);
  }
  return filtered;
}

export function parseContextSourceArguments(args: readonly string[]): ProofreaderControlRequest {
  if (args[0] !== "context" || args[1] !== "source" || args[2] === undefined) {
    throw new Error(`Use: ${INSTALLED} context source <begin|propose|reconcile|rebuild-plan|rebuild-verify|complete>`);
  }
  const operation = args[2];
  let handle: string | undefined;
  let executionId: string | undefined;
  let planId: string | undefined;
  let command: string | undefined;
  let outputPath: string | undefined;
  let proposal: SourceReplacementProposalV1 | undefined;
  let guards: Readonly<Record<string, string>> | undefined;
  let items: readonly LiveDispositionItemV1[] | undefined;
  let rebuildVerificationId: string | undefined;
  const sourcePaths: string[] = [];
  for (let index = 3; index < args.length; index += 1) {
    const flag = args[index]!;
    const raw = valueAfter(args, index);
    index += 1;
    if (flag === "--handle" && handle === undefined) handle = raw;
    else if (flag === "--execution" && executionId === undefined) executionId = raw;
    else if (flag === "--path" && operation === "begin") sourcePaths.push(raw);
    else if (flag === "--proposal-json" && proposal === undefined) {
      proposal = parsedJson<SourceReplacementProposalV1>(raw, "Proposal");
    } else if (flag === "--guards-json" && guards === undefined) {
      guards = parsedJson<Readonly<Record<string, string>>>(raw, "Guard map");
    } else if (flag === "--command" && command === undefined) command = raw;
    else if (flag === "--output" && outputPath === undefined) outputPath = raw;
    else if (flag === "--plan" && planId === undefined) planId = raw;
    else if (flag === "--items-json" && items === undefined) {
      items = parsedJson<readonly LiveDispositionItemV1[]>(raw, "Disposition items");
    } else if (flag === "--rebuild-verification" && rebuildVerificationId === undefined) {
      rebuildVerificationId = raw;
    } else throw new Error("The context source request is invalid or contains a duplicate option");
  }
  if (handle === undefined || !HANDLE.test(handle)) throw new Error("A current opaque evidence handle is required");
  if (
    operation === "begin" && executionId === undefined && proposal === undefined && guards === undefined &&
    command === undefined && outputPath === undefined && planId === undefined && items === undefined &&
    rebuildVerificationId === undefined
  ) {
    return { kind: "source-begin", handle, ...(sourcePaths.length === 0 ? {} : { sourcePaths }) };
  }
  if (executionId === undefined || executionId.trim().length === 0) {
    throw new Error("A source-work execution id is required");
  }
  if (
    operation === "propose" && proposal !== undefined && sourcePaths.length === 0 && guards === undefined &&
    command === undefined && outputPath === undefined && planId === undefined && items === undefined &&
    rebuildVerificationId === undefined
  ) {
    return { kind: "source-propose", handle, executionId, proposal };
  }
  if (
    operation === "reconcile" && sourcePaths.length === 0 && proposal === undefined && command === undefined &&
    outputPath === undefined && planId === undefined && items === undefined && rebuildVerificationId === undefined
  ) {
    return {
      kind: "source-reconcile",
      handle,
      executionId,
      ...(guards === undefined ? {} : { expectedSourceSha256ByProposal: guards }),
    };
  }
  if (
    operation === "rebuild-plan" && command !== undefined && outputPath !== undefined && sourcePaths.length === 0 &&
    proposal === undefined && guards === undefined && planId === undefined && items === undefined &&
    rebuildVerificationId === undefined
  ) {
    return { kind: "source-rebuild-plan", handle, executionId, command, outputPath };
  }
  if (
    operation === "rebuild-verify" && planId !== undefined && sourcePaths.length === 0 && proposal === undefined &&
    guards === undefined && command === undefined && outputPath === undefined && items === undefined &&
    rebuildVerificationId === undefined
  ) {
    return { kind: "source-rebuild-verify", handle, executionId, planId };
  }
  if (
    operation === "complete" && Array.isArray(items) && sourcePaths.length === 0 && proposal === undefined &&
    guards === undefined && command === undefined && outputPath === undefined && planId === undefined
  ) {
    return {
      kind: "source-complete",
      handle,
      executionId,
      items,
      ...(rebuildVerificationId === undefined ? {} : { rebuildVerificationId }),
    };
  }
  throw new Error(`The context source ${operation} request is incomplete`);
}

export function parseContextEvidenceArguments(args: readonly string[]): ParsedContextEvidenceRequest {
  if (args[0] !== "context" || args[1] !== "evidence") {
    throw new Error(`Use: ${INSTALLED} context evidence --handle <opaque-handle> --kind <evidence-kind>`);
  }
  let handle: string | undefined;
  let kind: PdfEvidenceRequest["kind"] | undefined;
  let pageIndex: number | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  let maxBytes: number | undefined;
  let outputPath: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    const raw = valueAfter(args, index);
    index += 1;
    if (flag === "--handle" && handle === undefined) handle = raw;
    else if (flag === "--kind" && kind === undefined && ["document", "page-text", "page-layout", "page-render", "raw-annotations"].includes(raw)) {
      kind = raw as PdfEvidenceRequest["kind"];
    } else if (flag === "--page" && pageIndex === undefined) pageIndex = integer(raw);
    else if (flag === "--offset" && offset === undefined) offset = integer(raw);
    else if (flag === "--limit" && limit === undefined) limit = integer(raw);
    else if (flag === "--max-bytes" && maxBytes === undefined) maxBytes = integer(raw);
    else if (flag === "--output" && outputPath === undefined && isAbsolute(raw)) outputPath = raw;
    else throw new Error("The context evidence request is invalid or contains a duplicate option");
  }
  if (handle === undefined || !HANDLE.test(handle) || kind === undefined) {
    throw new Error("An opaque evidence handle and supported kind are required");
  }
  const request: PdfEvidenceRequest = kind === "document"
    ? { kind, ...(maxBytes === undefined ? {} : { maxBytes }) }
    : kind === "raw-annotations"
      ? {
          kind,
          ...(offset === undefined ? {} : { offset }),
          ...(limit === undefined ? {} : { limit }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }
      : {
          kind,
          ...(pageIndex === undefined ? { pageIndex: -1 } : { pageIndex }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        };
  if (kind !== "document" && kind !== "raw-annotations" && pageIndex === undefined) {
    throw new Error("Page evidence requires --page");
  }
  if (kind === "document" && (pageIndex !== undefined || offset !== undefined || limit !== undefined)) {
    throw new Error("Document evidence does not accept page or annotation bounds");
  }
  return { handle, request, ...(outputPath === undefined ? {} : { outputPath }) };
}

export function parseContextItemsArguments(args: readonly string[]): ParsedContextItemsRequest {
  if (args[0] !== "context" || (args[1] !== "items" && args[1] !== "changes")) {
    throw new Error(`Use: ${INSTALLED} context <items|changes> --handle <opaque-handle>`);
  }
  let handle: string | undefined;
  let offset: number | undefined;
  let limit: number | undefined;
  let pageIndex: number | undefined;
  let maxBytes: number | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const flag = args[index]!;
    const raw = valueAfter(args, index);
    index += 1;
    if (flag === "--handle" && handle === undefined) handle = raw;
    else if (flag === "--offset" && offset === undefined) offset = integer(raw);
    else if (flag === "--limit" && limit === undefined) limit = integer(raw);
    else if (flag === "--page" && args[1] === "items" && pageIndex === undefined) pageIndex = integer(raw);
    else if (flag === "--max-bytes" && maxBytes === undefined) maxBytes = integer(raw);
    else throw new Error("The context retrieval request is invalid or contains a duplicate option");
  }
  if (handle === undefined || !HANDLE.test(handle)) {
    throw new Error("An opaque evidence handle is required");
  }
  return {
    handle,
    ...(offset === undefined ? {} : { offset }),
    ...(limit === undefined ? {} : { limit }),
    ...(pageIndex === undefined ? {} : { pageIndex }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  };
}

export async function runContextCommand(
  args: readonly string[],
  control: ControlClient = controlThroughDaemon,
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<number> {
  if (args[1] === "source") {
    let request: ProofreaderControlRequest;
    try {
      const payloads = await Promise.all([
        requestPayload(args, "--proposal-file", "Proposal"),
        requestPayload(args, "--guards-file", "Guard map"),
        requestPayload(args, "--items-file", "Disposition items"),
      ]);
      const normalized = withoutFilePayloadFlags(args);
      if (payloads[0] !== undefined) normalized.push("--proposal-json", JSON.stringify(payloads[0]));
      if (payloads[1] !== undefined) normalized.push("--guards-json", JSON.stringify(payloads[1]));
      if (payloads[2] !== undefined) normalized.push("--items-json", JSON.stringify(payloads[2]));
      request = parseContextSourceArguments(normalized);
    } catch (error) {
      write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Invalid context source request" })}\n`);
      return 2;
    }
    try {
      const response = await control(request);
      if (response.kind === "source-workflow-unavailable") {
        write(`${JSON.stringify({ ok: false, reason: response.reason })}\n`);
        return 2;
      }
      if (response.kind !== "source-workflow") {
        write(`${JSON.stringify({ ok: false, reason: "unavailable" })}\n`);
        return 2;
      }
      write(`${JSON.stringify({ ok: true, operation: response.operation, ...response.response })}\n`);
      return 0;
    } catch {
      write(`${JSON.stringify({ ok: false, reason: "unavailable" })}\n`);
      return 2;
    }
  }
  if (args[1] === "items" || args[1] === "changes") {
    let items: ParsedContextItemsRequest;
    try { items = parseContextItemsArguments(args); } catch (error) {
      write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Invalid context items request" })}\n`);
      return 2;
    }
    try {
      const response = await control({
        kind: args[1] === "changes"
          ? "retrieve-review-changes-by-handle"
          : "retrieve-review-items-by-handle",
        handle: items.handle,
        ...(items.offset === undefined ? {} : { offset: items.offset }),
        ...(items.limit === undefined ? {} : { limit: items.limit }),
        ...(items.maxBytes === undefined ? {} : { maxBytes: items.maxBytes }),
        ...(args[1] === "items" && items.pageIndex !== undefined ? { pageIndex: items.pageIndex } : {}),
      });
      if (response.kind !== "evidence" || response.result.status !== "ok") {
        write(`${JSON.stringify({ ok: false, reason: response.kind === "evidence" && response.result.status === "unavailable" ? response.result.reason : "unavailable" })}\n`);
        return 2;
      }
      write(`${JSON.stringify({
        ok: true,
        kind: args[1] === "changes" ? "review-changes" : "review-items",
        mediaType: response.result.mediaType,
        byteLength: Buffer.byteLength(response.result.dataBase64, "base64"),
        content: Buffer.from(response.result.dataBase64, "base64").toString("utf8"),
      })}\n`);
      return 0;
    } catch {
      write(`${JSON.stringify({ ok: false, reason: "unavailable" })}\n`);
      return 2;
    }
  }
  let parsed: ParsedContextEvidenceRequest;
  try {
    parsed = parseContextEvidenceArguments(args);
  } catch (error) {
    write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Invalid context request" })}\n`);
    return 2;
  }
  let response: ProofreaderControlResponse;
  try {
    response = await control({
      kind: "retrieve-evidence-by-handle",
      handle: parsed.handle,
      request: parsed.request,
    });
  } catch {
    write(`${JSON.stringify({ ok: false, reason: "unavailable" })}\n`);
    return 2;
  }
  if (response.kind !== "evidence") {
    write(`${JSON.stringify({ ok: false, reason: "unavailable" })}\n`);
    return 2;
  }
  if (response.result.status !== "ok") {
    const reason = response.result.reason;
    write(`${JSON.stringify({ ok: false, reason })}\n`);
    return 2;
  }
  const bytes = Buffer.from(response.result.dataBase64, "base64");
  if (parsed.outputPath !== undefined) {
    try {
      await writeFile(parsed.outputPath, bytes, { flag: "wx", mode: 0o600 });
    } catch {
      write(`${JSON.stringify({ ok: false, reason: "output-unavailable" })}\n`);
      return 2;
    }
    write(`${JSON.stringify({
      ok: true,
      kind: response.result.evidenceKind,
      mediaType: response.result.mediaType,
      byteLength: bytes.byteLength,
      outputPath: parsed.outputPath,
    })}\n`);
    return 0;
  }
  if (response.result.evidenceKind === "document" || response.result.evidenceKind === "page-render") {
    write(`${JSON.stringify({ ok: false, reason: "output-required" })}\n`);
    return 2;
  }
  write(`${JSON.stringify({
    ok: true,
    kind: response.result.evidenceKind,
    mediaType: response.result.mediaType,
    byteLength: bytes.byteLength,
    content: bytes.toString("utf8"),
  })}\n`);
  return 0;
}
