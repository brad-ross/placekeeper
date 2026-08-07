import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import {
  createHandoff,
  type HandoffV1,
  type SourceHint,
} from "../../../../packages/core/src/handoff.js";
import type { FrozenReviewDelivery, PdfExportResult } from "../export/export-coordinator.js";
import { isContained } from "../files/file-capabilities.js";
import { validateHandoffDocument } from "./schema-validator.js";

const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");

export interface CodexHandoffExportInput {
  readonly delivery: FrozenReviewDelivery;
  readonly reviewedPdf: Pick<PdfExportResult, "path" | "revision" | "digest" | "verification">;
  readonly resultParent: string;
  readonly revisedPdfFilename: string;
  readonly createdAt?: string;
  readonly sourceHints?: ReadonlyMap<string, SourceHint>;
}

export interface CodexHandoffExportResult {
  readonly handoff: HandoffV1;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly resultDirectory: string;
  readonly prompt: string;
}

async function syncJson(path: string, value: HandoffV1): Promise<string> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const temporaryPath = join(dirname(path), `.handoff-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return sha256(contents);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function safeHints(
  root: string,
  hints: ReadonlyMap<string, SourceHint> | undefined,
): Promise<ReadonlyMap<string, SourceHint>> {
  if (hints === undefined) return new Map();
  const safe = new Map<string, SourceHint>();
  for (const [id, hint] of hints) {
    if (isAbsolute(hint.path) || hint.path.includes("\0")) continue;
    try {
      const physical = await realpath(join(root, hint.path));
      if (!isContained(root, physical)) continue;
      safe.set(id, { ...hint, path: relative(root, physical) });
    } catch {
      // A stale or missing hint is omitted; the semantic fallback stays mandatory.
    }
  }
  return safe;
}

export async function exportCodexHandoff(
  input: CodexHandoffExportInput,
): Promise<CodexHandoffExportResult> {
  if (input.delivery.items.length === 0) throw new Error("An empty review cannot create a Codex handoff");
  if (input.delivery.sourceRootPath === undefined) throw new Error("Choose an approved source root before Codex delivery");
  if (input.reviewedPdf.revision !== input.delivery.revision) {
    throw new Error("The reviewed PDF and handoff must use the same frozen revision");
  }
  const frozenIds = input.delivery.items.map(({ id }) => id).sort();
  const reviewedIds = input.reviewedPdf.verification.annotationIds.toSorted();
  if (JSON.stringify(frozenIds) !== JSON.stringify(reviewedIds)) {
    throw new Error("The reviewed PDF does not account for the exact frozen stable-ID set");
  }
  const [sourceRoot, resultParent, reviewedPath] = await Promise.all([
    realpath(input.delivery.sourceRootPath),
    realpath(input.resultParent),
    realpath(input.reviewedPdf.path),
  ]);
  const reviewedInfo = await stat(reviewedPath);
  if (!reviewedInfo.isFile() || sha256(await readFile(reviewedPath)) !== input.reviewedPdf.digest) {
    throw new Error("The reviewed PDF digest does not match the frozen export");
  }
  const requestedName = basename(input.revisedPdfFilename);
  if (requestedName !== input.revisedPdfFilename || !requestedName.toLowerCase().endsWith(".pdf")) {
    throw new Error("The revised PDF filename must be a local PDF basename");
  }

  const stem = `${input.delivery.sessionId}-r${input.delivery.revision}`;
  let resultDirectory: string | undefined;
  for (let index = 0; index < 10_000; index += 1) {
    const candidate = join(resultParent, index === 0 ? stem : `${stem}-${index + 1}`);
    try {
      await mkdir(candidate, { mode: 0o700 });
      resultDirectory = await realpath(candidate);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (resultDirectory === undefined || !isContained(resultParent, resultDirectory)) {
    throw new Error("Could not allocate a contained result directory");
  }
  const revisedPdfDestination = join(resultDirectory, requestedName);
  const sourceHints = await safeHints(sourceRoot, input.sourceHints);
  const state = {
    sessionId: input.delivery.sessionId,
    source: input.delivery.source,
    revision: input.delivery.revision,
    items: input.delivery.items,
  };
  try {
    const handoff = createHandoff({
      state,
      createdAt: input.createdAt ?? new Date().toISOString(),
      reviewedPdf: { path: reviewedPath, sha256: input.reviewedPdf.digest },
      sourceRoot,
      resultDirectory,
      revisedPdfDestination,
      sourceHints,
    });
    const validation = await validateHandoffDocument(handoff);
    if (!validation.valid) throw new Error(`Generated handoff is invalid: ${validation.errors}`);
    const handoffPath = join(resultDirectory, "handoff.json");
    const handoffSha256 = await syncJson(handoffPath, handoff);
    const { buildCodexPrompt } = await import("./prompt-template.js");
    return {
      handoff,
      handoffPath,
      handoffSha256,
      resultDirectory,
      prompt: buildCodexPrompt(handoff),
    };
  } catch (error) {
    await rm(resultDirectory, { recursive: true, force: true });
    throw error;
  }
}
