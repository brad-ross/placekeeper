import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HandoffV1 } from "../../../packages/core/src/handoff.js";
import type { FrozenReviewDelivery, PdfExportResult } from "../src/export/export-coordinator.js";
import { ReviewDeliveryService } from "../src/delivery/review-delivery-service.js";
import { SessionControlRegistry } from "../src/sessions/control-socket.js";
import type { CheckCodexResultInput } from "../src/handoff/result-check.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("production review delivery orchestration", () => {
  it("freezes once per action and checks returned results against a trusted receipt and observed source changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-delivery-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const resultDirectory = join(sourceRoot, "result");
    await mkdir(sourceRoot);
    await mkdir(resultDirectory);
    await writeFile(join(sourceRoot, "paper.tex"), "before");
    const reviewedPdfPath = join(root, "paper-reviewed.pdf");
    await writeFile(reviewedPdfPath, "reviewed");
    const delivery = {
      sessionId: "session-a",
      source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 8 },
      originalDigest: "a".repeat(64),
      revision: 4,
      sourceSnapshotPath: join(root, "snapshot.pdf"),
      annotations: [{ id: "item-a" }],
      items: [{
        id: "item-a", kind: "pageNote", pageIndex: 0,
        createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
        payload: { position: { x: 1, y: 2, width: 3, height: 4 }, comment: "Fix" },
      }],
      sourceRootPath: sourceRoot,
    } as unknown as FrozenReviewDelivery;
    const reviewed = {
      kind: "reviewed-copy",
      path: reviewedPdfPath,
      revision: 4,
      digest: "b".repeat(64),
      verification: { annotationIds: ["item-a"] },
    } as unknown as PdfExportResult;
    const handoffPath = join(resultDirectory, "handoff.json");
    await writeFile(handoffPath, "{}\n");
    const handoff = {
      sourceRoot,
      resultDirectory,
      revisedPdfDestination: join(resultDirectory, "paper-revised.pdf"),
    } as HandoffV1;
    const check = vi.fn(async (_input: CheckCodexResultInput) => ({
      status: "Partial" as const,
      issues: ["build failed"],
    }));
    const service = new ReviewDeliveryService({
      broker: {
        freezeDelivery: vi.fn(async () => structuredClone(delivery)),
        capabilities: { getFilePath: vi.fn(() => join(root, "paper.pdf")) },
        controls: new SessionControlRegistry(),
      },
      exportReviewedCopy: vi.fn(async () => reviewed),
      replaceOriginal: vi.fn(async () => ({ ...reviewed, kind: "original-replacement" as const })),
      queryHints: vi.fn(async () => new Map()),
      exportHandoff: vi.fn(async () => ({
        handoff,
        handoffPath,
        handoffSha256: "c".repeat(64),
        resultDirectory,
        prompt: "Local prompt",
      })),
      checkResult: check,
    });

    const prepared = await service.prepareCodex("session-a");
    expect(prepared).toMatchObject({
      handoffPath,
      handoffSha256: "c".repeat(64),
      reviewedPdfPath,
      reviewedPdfSha256: "b".repeat(64),
      prompt: "Local prompt",
    });
    await writeFile(join(sourceRoot, "paper.tex"), "after");
    const result = await service.checkCodex("session-a", {
      receiptId: prepared.receiptId,
      dispositionText: "{}\n",
      revisedPdfSelected: false,
    });
    expect(result).toEqual({ status: "Partial", message: "build failed" });
    expect(check).toHaveBeenCalledWith(expect.objectContaining({
      handoffPath,
      expectedHandoffSha256: "c".repeat(64),
      expectedReviewedPdfSha256: "b".repeat(64),
      observableChangedPaths: ["paper.tex"],
    }));
    const selectedDispositionPath = check.mock.calls[0]![0].dispositionPath;
    await expect(readFile(selectedDispositionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a receipt from another active review", async () => {
    const service = new ReviewDeliveryService({
      broker: {
        freezeDelivery: vi.fn(async () => { throw new Error("unused"); }),
        capabilities: { getFilePath: vi.fn() },
        controls: new SessionControlRegistry(),
      },
      exportReviewedCopy: vi.fn(), replaceOriginal: vi.fn(), queryHints: vi.fn(),
      exportHandoff: vi.fn(), checkResult: vi.fn(),
    });
    await expect(service.checkCodex("session-b", {
      receiptId: "missing", dispositionText: "{}", revisedPdfSelected: false,
    })).rejects.toThrow("trusted handoff receipt");
  });

  it("cancels a handoff race on session end and removes its uncommitted result directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-delivery-race-"));
    roots.push(root);
    const sourceRoot = join(root, "source");
    const resultDirectory = join(sourceRoot, "result");
    await mkdir(sourceRoot);
    await mkdir(resultDirectory);
    const reviewedPdfPath = join(root, "reviewed.pdf");
    await writeFile(reviewedPdfPath, "reviewed");
    const controls = new SessionControlRegistry();
    let release!: () => void;
    let entered!: () => void;
    const enteredHandoff = new Promise<void>((resolve) => { entered = resolve; });
    const blockedHandoff = new Promise<void>((resolve) => { release = resolve; });
    const service = new ReviewDeliveryService({
      broker: {
        controls,
        capabilities: { getFilePath: vi.fn(() => join(root, "paper.pdf")) },
        freezeDelivery: vi.fn(async () => ({
          sessionId: "session-race",
          source: { fileId: "file", digest: "a".repeat(64), byteLength: 8 },
          originalDigest: "a".repeat(64), revision: 1,
          sourceSnapshotPath: join(root, "snapshot.pdf"), annotations: [{}],
          items: [{ id: "item" }], sourceRootPath: sourceRoot,
        } as unknown as FrozenReviewDelivery)),
      },
      exportReviewedCopy: vi.fn(async () => ({
        path: reviewedPdfPath, revision: 1, digest: "b".repeat(64),
        verification: { annotationIds: ["item"] },
      } as unknown as PdfExportResult)),
      replaceOriginal: vi.fn(), queryHints: vi.fn(async () => new Map()),
      exportHandoff: vi.fn(async () => {
        entered();
        await blockedHandoff;
        return {
          handoff: { revisedPdfDestination: join(resultDirectory, "revised.pdf") } as HandoffV1,
          handoffPath: join(resultDirectory, "handoff.json"),
          handoffSha256: "c".repeat(64), resultDirectory, prompt: "Prompt",
        };
      }),
      checkResult: vi.fn(),
    });
    const pending = service.prepareCodex("session-race");
    await enteredHandoff;
    controls.cancel("session-race");
    release();
    await expect(pending).rejects.toThrow("Review session ended");
    await expect(readFile(join(resultDirectory, "handoff.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
