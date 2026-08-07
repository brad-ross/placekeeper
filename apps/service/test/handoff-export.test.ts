import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { addPageNote } from "../../../packages/core/src/review-commands.js";
import { createReviewState } from "../../../packages/core/src/review-model.js";
import { reduceReview } from "../../../packages/core/src/review-reducer.js";
import { projectReviewItems } from "../../../packages/core/src/annotation-projection.js";
import { exportCodexHandoff } from "../src/handoff/handoff-export.js";
import { buildCodexPrompt } from "../src/handoff/prompt-template.js";
import { checkCodexResult } from "../src/handoff/result-check.js";
import { SessionBroker } from "../src/sessions/session-broker.js";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-handoff-"));
  roots.push(root);
  const sourceRoot = join(root, "source");
  const resultParent = join(root, "results");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(sourceRoot), mkdir(resultParent)]));
  await writeFile(join(sourceRoot, "paper.tex"), "original source");
  const reviewedPath = join(root, "paper-reviewed.pdf");
  const reviewedBytes = Buffer.from("%PDF-1.7\nreview evidence\n%%EOF");
  await writeFile(reviewedPath, reviewedBytes);
  const empty = createReviewState({
    sessionId: randomUUID(),
    source: { fileId: randomUUID(), digest: "a".repeat(64), byteLength: 100 },
  });
  const state = reduceReview(empty, addPageNote(empty, 0, { x: 10, y: 10, width: 20, height: 20 }, "Fix this"));
  const delivery = {
    sessionId: state.sessionId,
    source: state.source,
    originalDigest: state.source.digest,
    revision: state.revision,
    sourceSnapshotPath: reviewedPath,
    annotations: projectReviewItems(state.items),
    items: structuredClone(state.items),
    sourceRootPath: sourceRoot,
  };
  return { root, sourceRoot, resultParent, reviewedPath, reviewedBytes, state, delivery };
}

describe("Codex handoff export and explicit result check", () => {
  it("freezes canonical semantic items and approved source-root metadata beside the PDF projection", async () => {
    const fixture = await setup();
    const broker = new SessionBroker({ recoveryRoot: join(fixture.root, "recovery") });
    const opened = await broker.openReview({ pdfPath: fixture.reviewedPath, sourceRootPath: fixture.sourceRoot });
    if (opened.kind !== "opened") throw new Error("Expected a new review");
    const state = broker.state(opened.launch.sessionId)!;
    await broker.acceptMutation(opened.launch.sessionId, addPageNote(state, 0, { x: 10, y: 10, width: 20, height: 20 }, "Frozen semantic note"));
    const frozen = await broker.freezeDelivery(opened.launch.sessionId);
    expect(frozen).toMatchObject({
      revision: 1,
      sourceRootId: opened.launch.rootId,
      sourceRootPath: await realpath(fixture.sourceRoot),
      items: [{ id: frozen.annotations[0]!.id, kind: "pageNote", payload: { comment: "Frozen semantic note" } }],
      annotations: [{ kind: "pageNote" }],
    });
  });

  it("writes immutable collision-safe handoffs tied to the reviewed PDF and frozen canonical revision", async () => {
    const fixture = await setup();
    const input = {
      delivery: fixture.delivery,
      reviewedPdf: { path: fixture.reviewedPath, revision: fixture.state.revision, digest: sha256(fixture.reviewedBytes), verification: { pageCount: 1, annotationIds: fixture.state.items.map(({ id }) => id) } },
      resultParent: fixture.resultParent,
      revisedPdfFilename: "paper-revised.pdf",
      createdAt: "2026-08-07T13:00:00.000Z",
    };
    const first = await exportCodexHandoff(input);
    const firstBytes = await readFile(first.handoffPath);
    const repeat = await exportCodexHandoff(input);
    expect(repeat.handoffPath).not.toBe(first.handoffPath);
    expect(repeat.resultDirectory).not.toBe(first.resultDirectory);
    expect(repeat.handoff.items.map(({ id }) => id)).toEqual(first.handoff.items.map(({ id }) => id));
    expect(await readFile(first.handoffPath)).toEqual(firstBytes);

    const laterDelivery = { ...fixture.delivery, revision: fixture.delivery.revision + 1 };
    const later = await exportCodexHandoff({ ...input, delivery: laterDelivery, reviewedPdf: { ...input.reviewedPdf, revision: laterDelivery.revision } });
    expect(later.handoffPath).not.toBe(first.handoffPath);
    expect(await readFile(first.handoffPath)).toEqual(firstBytes);
    expect(JSON.parse(firstBytes.toString())).toMatchObject({
      frozenRevision: fixture.state.revision,
      reviewedPdf: { sha256: sha256(fixture.reviewedBytes) },
    });
  });

  it("produces a complete local-only instruction with exact evidence paths and no submission/network operation", async () => {
    const fixture = await setup();
    const exported = await exportCodexHandoff({
      delivery: fixture.delivery,
      reviewedPdf: { path: fixture.reviewedPath, revision: fixture.state.revision, digest: sha256(fixture.reviewedBytes), verification: { pageCount: 1, annotationIds: fixture.state.items.map(({ id }) => id) } },
      resultParent: fixture.resultParent,
      revisedPdfFilename: "paper-revised.pdf",
      createdAt: "2026-08-07T13:00:00.000Z",
    });
    const prompt = buildCodexPrompt(exported.handoff);
    expect(prompt).toContain(exported.handoffPath);
    expect(prompt).toContain(fixture.reviewedPath);
    expect(prompt).toContain(fixture.sourceRoot);
    expect(prompt).toContain(exported.handoff.revisedPdfDestination);
    expect(prompt).toContain("untrusted data");
    expect(prompt).toContain("do not guess");
    expect(prompt).toContain("ordinary Codex permission gates");
    expect(prompt).not.toContain("submit task");
  });

  it("omits a supplied source hint when its existing symlink escapes the approved root", async () => {
    const fixture = await setup();
    const outside = join(fixture.root, "outside.tex");
    await writeFile(outside, "outside");
    await symlink(outside, join(fixture.sourceRoot, "linked.tex"));
    const exported = await exportCodexHandoff({
      delivery: fixture.delivery,
      reviewedPdf: { path: fixture.reviewedPath, revision: fixture.state.revision, digest: sha256(fixture.reviewedBytes), verification: { pageCount: 1, annotationIds: fixture.state.items.map(({ id }) => id) } },
      resultParent: fixture.resultParent,
      revisedPdfFilename: "paper-revised.pdf",
      sourceHints: new Map([[fixture.state.items[0]!.id, { path: "linked.tex", line: 1, confidence: "high", provenance: "synctex" }]]),
    });
    expect(exported.handoff.items[0]).not.toHaveProperty("sourceHint");
  });

  it("allocates a fresh handoff without changing valid-looking prior evidence that was altered", async () => {
    const fixture = await setup();
    const input = {
      delivery: fixture.delivery,
      reviewedPdf: { path: fixture.reviewedPath, revision: fixture.state.revision, digest: sha256(fixture.reviewedBytes), verification: { pageCount: 1, annotationIds: fixture.state.items.map(({ id }) => id) } },
      resultParent: fixture.resultParent,
      revisedPdfFilename: "paper-revised.pdf",
      createdAt: "2026-08-07T13:00:00.000Z",
    };
    const first = await exportCodexHandoff(input);
    const altered = JSON.parse(await readFile(first.handoffPath, "utf8"));
    altered.items[0].payload.comment = "altered evidence";
    await writeFile(first.handoffPath, `${JSON.stringify(altered, null, 2)}\n`);
    const second = await exportCodexHandoff(input);
    expect(second.handoffPath).not.toBe(first.handoffPath);
    expect(second.handoff.items[0]).toMatchObject({ payload: { comment: "Fix this" } });
  });

  it("classifies complete, partial, and invalid results using hashes, exact IDs, paths, output digest, and clean PDF evidence", async () => {
    const fixture = await setup();
    const exported = await exportCodexHandoff({
      delivery: fixture.delivery,
      reviewedPdf: { path: fixture.reviewedPath, revision: fixture.state.revision, digest: sha256(fixture.reviewedBytes), verification: { pageCount: 1, annotationIds: fixture.state.items.map(({ id }) => id) } },
      resultParent: fixture.resultParent,
      revisedPdfFilename: "paper-revised.pdf",
      createdAt: "2026-08-07T13:00:00.000Z",
    });
    const revised = Buffer.from("%PDF-1.7\nclean revised output\n%%EOF");
    await writeFile(exported.handoff.revisedPdfDestination, revised);
    await writeFile(join(fixture.sourceRoot, "paper.tex"), "changed source");
    const dispositionPath = join(exported.resultDirectory, "disposition.json");
    const disposition = {
      schemaVersion: "1.0",
      reviewId: fixture.state.sessionId,
      handoffSha256: exported.handoffSha256,
      reviewedPdfSha256: sha256(fixture.reviewedBytes),
      build: { status: "succeeded", outputSha256: sha256(revised) },
      changedPaths: ["paper.tex"],
      revisedPdf: { path: exported.handoff.revisedPdfDestination, sha256: sha256(revised) },
      items: [{ id: fixture.state.items[0]!.id, status: "Applied", explanation: "Updated paper.tex", changedPaths: ["paper.tex"] }],
    };
    await writeFile(dispositionPath, JSON.stringify(disposition));
    const expectedEvidence = {
      handoffPath: exported.handoffPath,
      expectedHandoffSha256: exported.handoffSha256,
      expectedReviewedPdfSha256: sha256(fixture.reviewedBytes),
      dispositionPath,
      observableChangedPaths: ["paper.tex"],
    };
    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, inspectPdf: async () => ({ annotationIds: [], generatedLinkCount: 1 }) })).resolves.toMatchObject({ status: "Complete" });

    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, observableChangedPaths: ["other.tex"], inspectPdf: async () => ({ annotationIds: [] }) })).resolves.toMatchObject({ status: "Invalid" });
    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, inspectPdf: async () => ({ annotationIds: [], annotations: [{ author: "PDF Proofreader", subtype: "highlight" }] }) })).resolves.toMatchObject({ status: "Invalid" });
    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, inspectPdf: async () => { throw new Error("inspection failed"); } })).resolves.toMatchObject({ status: "Invalid" });

    await writeFile(dispositionPath, JSON.stringify({ ...disposition, items: [{ ...disposition.items[0], changedPaths: undefined }] }));
    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, inspectPdf: async () => ({ annotationIds: [] }) })).resolves.toMatchObject({ status: "Invalid" });

    await writeFile(dispositionPath, JSON.stringify({ ...disposition, build: { status: "failed" }, revisedPdf: undefined }));
    await expect(checkCodexResult({ ...expectedEvidence, inspectPdf: async () => ({ annotationIds: [] }) })).resolves.toMatchObject({ status: "Partial" });

    const outsideDirectory = join(fixture.root, "outside-source-root");
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, join(fixture.sourceRoot, "escape"));
    await writeFile(dispositionPath, JSON.stringify({
      ...disposition,
      build: { status: "failed" },
      revisedPdf: undefined,
      changedPaths: ["escape/missing.tex"],
      items: [{ ...disposition.items[0], changedPaths: ["escape/missing.tex"] }],
    }));
    await expect(checkCodexResult({ ...expectedEvidence, observableChangedPaths: ["escape/missing.tex"], inspectPdf: async () => ({ annotationIds: [] }) })).resolves.toMatchObject({ status: "Invalid" });

    await writeFile(dispositionPath, JSON.stringify({ ...disposition, items: [], changedPaths: ["../escape.tex"] }));
    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, inspectPdf: async () => ({ annotationIds: [] }) })).resolves.toMatchObject({ status: "Invalid" });

    const tamperedHandoff = JSON.parse(await readFile(exported.handoffPath, "utf8"));
    tamperedHandoff.reviewedPdf.sha256 = "e".repeat(64);
    const tamperedBytes = `${JSON.stringify(tamperedHandoff, null, 2)}\n`;
    await writeFile(exported.handoffPath, tamperedBytes);
    await writeFile(dispositionPath, JSON.stringify({
      ...disposition,
      handoffSha256: sha256(tamperedBytes),
      reviewedPdfSha256: "e".repeat(64),
    }));
    await expect(checkCodexResult({ ...expectedEvidence, revisedPdfPath: exported.handoff.revisedPdfDestination, inspectPdf: async () => ({ annotationIds: [] }) })).resolves.toMatchObject({ status: "Invalid" });
  });
});
