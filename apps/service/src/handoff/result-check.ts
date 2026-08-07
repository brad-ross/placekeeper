import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type { DispositionV1 } from "../../../../packages/core/src/disposition.js";
import type { HandoffV1 } from "../../../../packages/core/src/handoff.js";
import { inspectPdfWithEmbedPdf } from "../../../../packages/pdf-backends/src/embedpdf-adapter.js";
import { isContained } from "../files/file-capabilities.js";
import {
  validateDispositionDocument,
  validateHandoffDocument,
} from "./schema-validator.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function checkedRelativePaths(root: string, paths: readonly string[]): Promise<string[] | undefined> {
  const checked: string[] = [];
  for (const path of paths) {
    if (isAbsolute(path) || path.includes("\0") || path.split("/").includes("..")) return undefined;
    const lexical = resolve(root, path);
    if (!isContained(root, lexical)) return undefined;
    let ancestor = lexical;
    for (;;) {
      try {
        const physical = await realpath(ancestor);
        if (!isContained(root, physical)) return undefined;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        const parent = dirname(ancestor);
        if (parent === ancestor) return undefined;
        ancestor = parent;
      }
    }
    checked.push(relative(root, lexical));
  }
  return checked;
}

export interface PdfResultInspection {
  readonly annotationIds: readonly string[];
  readonly annotations?: readonly {
    readonly id?: string;
    readonly author?: string;
    readonly subtype?: string;
  }[];
  readonly generatedLinkCount?: number;
}

export interface CheckCodexResultInput {
  readonly handoffPath: string;
  readonly expectedHandoffSha256: string;
  readonly expectedReviewedPdfSha256: string;
  readonly dispositionPath: string;
  readonly revisedPdfPath?: string;
  readonly observableChangedPaths: readonly string[];
  readonly inspectPdf?: (bytes: Uint8Array) => Promise<PdfResultInspection>;
}

export interface CodexResultCheck {
  readonly status: "Complete" | "Partial" | "Invalid";
  readonly handoff?: HandoffV1;
  readonly disposition?: DispositionV1;
  readonly issues: readonly string[];
}

export async function inspectRevisedPdf(bytes: Uint8Array): Promise<PdfResultInspection> {
  const inspected = await inspectPdfWithEmbedPdf(bytes);
  return {
    annotationIds: inspected.annotations.map(({ id }) => id),
    annotations: inspected.annotations.map(({ id, author, subtype }) => ({
      id,
      ...(author === undefined ? {} : { author }),
      subtype,
    })),
  };
}

function invalid(issues: readonly string[]): CodexResultCheck {
  return { status: "Invalid", issues };
}

export async function checkCodexResult(input: CheckCodexResultInput): Promise<CodexResultCheck> {
  const issues: string[] = [];
  let handoffBytes: Buffer;
  let dispositionBytes: Buffer;
  try {
    const [selectedResultDirectory, selectedDisposition] = await Promise.all([
      realpath(dirname(input.handoffPath)),
      realpath(input.dispositionPath),
    ]);
    if (!isContained(selectedResultDirectory, selectedDisposition)) {
      return invalid(["The selected disposition is outside the handoff result directory."]);
    }
    const [handoffInfo, dispositionInfo] = await Promise.all([
      stat(input.handoffPath),
      stat(input.dispositionPath),
    ]);
    if (handoffInfo.size > 16 * 1024 * 1024 || dispositionInfo.size > 16 * 1024 * 1024) {
      return invalid(["The selected handoff or disposition exceeds the 16 MiB result limit."]);
    }
    [handoffBytes, dispositionBytes] = await Promise.all([
      readFile(input.handoffPath),
      readFile(input.dispositionPath),
    ]);
  } catch {
    return invalid(["The selected handoff or disposition could not be read."]);
  }
  if (sha256(handoffBytes) !== input.expectedHandoffSha256) {
    return invalid(["The selected handoff changed after export."]);
  }

  let rawHandoff: unknown;
  let rawDisposition: unknown;
  try {
    rawHandoff = JSON.parse(handoffBytes.toString("utf8"));
    rawDisposition = JSON.parse(dispositionBytes.toString("utf8"));
  } catch {
    return invalid(["The selected handoff or disposition is malformed JSON."]);
  }
  const [handoffValidation, dispositionValidation] = await Promise.all([
    validateHandoffDocument(rawHandoff),
    validateDispositionDocument(rawDisposition),
  ]);
  if (!handoffValidation.valid) issues.push(`Handoff schema: ${handoffValidation.errors}`);
  if (!dispositionValidation.valid) issues.push(`Disposition schema: ${dispositionValidation.errors}`);
  if (!handoffValidation.valid || !dispositionValidation.valid) return invalid(issues);
  const handoff = handoffValidation.value;
  const disposition = dispositionValidation.value;
  if (handoff.reviewedPdf.sha256 !== input.expectedReviewedPdfSha256) {
    issues.push("The handoff no longer names the exported reviewed-PDF digest.");
  }

  const [sourceRoot, resultDirectory] = await Promise.all([
    realpath(handoff.sourceRoot).catch(() => undefined),
    realpath(handoff.resultDirectory).catch(() => undefined),
  ]);
  if (sourceRoot === undefined || resultDirectory === undefined) {
    return invalid(["The approved source root or result directory is no longer available."]);
  }
  if (sourceRoot !== handoff.sourceRoot || resultDirectory !== handoff.resultDirectory) {
    issues.push("The handoff source root or result directory is no longer canonical.");
  }
  const revisedDestination = resolve(handoff.revisedPdfDestination);
  if (!isContained(resultDirectory, revisedDestination) || revisedDestination === resultDirectory) {
    issues.push("The designated revised PDF escapes the frozen result directory.");
  }
  const hintPaths = handoff.items.flatMap(({ sourceHint }) => sourceHint === undefined ? [] : [sourceHint.path]);
  if (await checkedRelativePaths(sourceRoot, hintPaths) === undefined) {
    issues.push("A SyncTeX hint no longer resolves inside the approved source root.");
  }
  const handoffPhysical = await realpath(input.handoffPath).catch(() => undefined);
  const dispositionPhysical = await realpath(input.dispositionPath).catch(() => undefined);
  if (
    handoffPhysical !== resolve(resultDirectory, "handoff.json") ||
    dispositionPhysical === undefined || !isContained(resultDirectory, dispositionPhysical)
  ) issues.push("Selected result files are outside the frozen result directory.");

  if (disposition.reviewId !== handoff.reviewId) issues.push("The disposition review ID does not match the handoff.");
  if (disposition.handoffSha256 !== input.expectedHandoffSha256) issues.push("The handoff digest does not match the immutable export record.");
  let reviewedBytes: Buffer | undefined;
  try {
    if (await realpath(handoff.reviewedPdf.path) !== handoff.reviewedPdf.path) {
      issues.push("The reviewed PDF path no longer resolves to its canonical export target.");
    }
    reviewedBytes = await readFile(handoff.reviewedPdf.path);
  } catch {
    issues.push("The reviewed PDF evidence is missing.");
  }
  if (
    reviewedBytes !== undefined &&
    (sha256(reviewedBytes) !== input.expectedReviewedPdfSha256 || disposition.reviewedPdfSha256 !== input.expectedReviewedPdfSha256)
  ) issues.push("The reviewed PDF digest does not match the immutable evidence.");

  const expectedIds = handoff.items.map(({ id }) => id).sort();
  const returnedIds = disposition.items.map(({ id }) => id).sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(returnedIds)) {
    issues.push("The disposition must account for every stable review ID exactly once.");
  }

  const changedPaths = await checkedRelativePaths(sourceRoot, disposition.changedPaths);
  if (changedPaths === undefined) issues.push("A reported changed path escapes the approved source root.");
  for (const item of disposition.items) {
    if (item.status === "Applied" && (item.changedPaths === undefined || item.changedPaths.length === 0)) {
      issues.push(`Applied review item ${item.id} must identify a contained changed path.`);
    }
    if (item.changedPaths === undefined) continue;
    const itemPaths = await checkedRelativePaths(sourceRoot, item.changedPaths);
    if (
      itemPaths === undefined ||
      itemPaths.some((path) => !disposition.changedPaths.includes(path))
    ) issues.push(`Review item ${item.id} reports an invalid changed path.`);
  }
  if (changedPaths !== undefined) {
    const observed = await checkedRelativePaths(sourceRoot, input.observableChangedPaths);
    if (
      observed === undefined ||
      JSON.stringify(observed.toSorted()) !== JSON.stringify(changedPaths.toSorted())
    ) issues.push("Reported changed paths do not match the observable source changes.");
  }

  if (disposition.build.status === "succeeded") {
    if (disposition.revisedPdf === undefined || input.revisedPdfPath === undefined) {
      issues.push("A successful build must include a user-selected revised PDF.");
    } else {
      const expected = resolve(handoff.revisedPdfDestination);
      const selected = await realpath(input.revisedPdfPath).catch(() => undefined);
      const selectedInfo = selected === undefined ? undefined : await lstat(input.revisedPdfPath).catch(() => undefined);
      if (
        disposition.revisedPdf.path !== handoff.revisedPdfDestination ||
        selected !== expected || selectedInfo?.isSymbolicLink() === true || selectedInfo?.isFile() !== true
      ) {
        issues.push("The revised PDF is not the designated regular output file.");
      } else {
        try {
          const revisedBytes = await readFile(selected);
          const digest = sha256(revisedBytes);
          if (
            digest !== disposition.revisedPdf.sha256 ||
            digest !== disposition.build.outputSha256 ||
            digest === handoff.reviewedPdf.sha256
          ) issues.push("The revised PDF digest is missing, inconsistent, or not distinct from the reviewed PDF.");
          const inspection = await (input.inspectPdf ?? inspectRevisedPdf)(revisedBytes);
          const reviewIds = new Set(handoff.items.map(({ id }) => id));
          const inherited = inspection.annotationIds.some((id) => reviewIds.has(id)) ||
            inspection.annotations?.some((annotation) =>
              (annotation.id !== undefined && reviewIds.has(annotation.id)) ||
              annotation.author === "PDF Proofreader" ||
              (annotation.subtype !== undefined && annotation.subtype !== "link"),
            ) === true;
          if (inherited) {
            issues.push("The revised PDF still contains inherited review annotations.");
          }
        } catch {
          issues.push("The revised PDF could not be read or structurally inspected.");
        }
      }
    }
  } else if (disposition.revisedPdf !== undefined || input.revisedPdfPath !== undefined) {
    issues.push("A failed build must not claim a revised PDF.");
  }

  if (issues.length > 0) return { status: "Invalid", handoff, disposition, issues };
  return {
    status: disposition.build.status === "succeeded" ? "Complete" : "Partial",
    handoff,
    disposition,
    issues: [],
  };
}
