import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { PdfEvidenceRequest } from "../context/pdf-evidence-service.js";
import type { ProofreaderControlRequest, ProofreaderControlResponse } from "../host/launch-control.js";
import { controlThroughDaemon } from "../host/service-daemon.js";

type ControlClient = (request: ProofreaderControlRequest) => Promise<ProofreaderControlResponse>;

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

export function parseContextEvidenceArguments(args: readonly string[]): ParsedContextEvidenceRequest {
  if (args[0] !== "context" || args[1] !== "evidence") {
    throw new Error("Use: pdf-proofreader context evidence --handle <opaque-handle> --kind <evidence-kind>");
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
  if (handle === undefined || !/^[A-Za-z0-9._~-]{16,512}$/u.test(handle) || kind === undefined) {
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
  if (args[0] !== "context" || args[1] !== "items") {
    throw new Error("Use: pdf-proofreader context items --handle <opaque-handle>");
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
    else if (flag === "--page" && pageIndex === undefined) pageIndex = integer(raw);
    else if (flag === "--max-bytes" && maxBytes === undefined) maxBytes = integer(raw);
    else throw new Error("The context items request is invalid or contains a duplicate option");
  }
  if (handle === undefined || !/^[A-Za-z0-9._~-]{16,512}$/u.test(handle)) {
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
  if (args[1] === "items") {
    let items: ParsedContextItemsRequest;
    try { items = parseContextItemsArguments(args); } catch (error) {
      write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Invalid context items request" })}\n`);
      return 2;
    }
    try {
      const response = await control({ kind: "retrieve-review-items-by-handle", ...items });
      if (response.kind !== "evidence" || response.result.status !== "ok") {
        write(`${JSON.stringify({ ok: false, reason: response.kind === "evidence" && response.result.status === "unavailable" ? response.result.reason : "unavailable" })}\n`);
        return 2;
      }
      write(`${JSON.stringify({
        ok: true,
        kind: "review-items",
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
