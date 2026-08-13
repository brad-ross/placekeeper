import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseContextEvidenceArguments,
  parseContextItemsArguments,
  parseContextSourceArguments,
  runContextCommand,
} from "../src/cli/context-command.js";
import type { PlacekeeperControlResponse } from "../src/host/launch-control.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("context evidence command", () => {
  it("preserves a typed source-work handle failure through the CLI", async () => {
    const control = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "source-workflow-unavailable",
      reason: "expired",
    }));
    const write = vi.fn();
    expect(await runContextCommand([
      "context", "source", "begin", "--handle", "evidence_abcdefghijklmnop",
    ], control, write)).toBe(2);
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toEqual({ ok: false, reason: "expired" });
  });

  it("keeps discussion read-only and addresses source work only through the current opaque handle", async () => {
    const handle = "evidence_abcdefghijklmnop";
    expect(parseContextSourceArguments([
      "context", "source", "begin", "--handle", handle, "--path", "paper.tex",
    ])).toEqual({ kind: "source-begin", handle, sourcePaths: ["paper.tex"] });
    expect(parseContextSourceArguments([
      "context", "source", "reconcile", "--handle", handle,
      "--execution", "execution-a", "--guards-json", '{"proposal-a":"abc"}',
    ])).toEqual({
      kind: "source-reconcile",
      handle,
      executionId: "execution-a",
      expectedSourceSha256ByProposal: { "proposal-a": "abc" },
    });

    const discussionControl = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "evidence",
      result: {
        status: "ok", evidenceKind: "review-items", mediaType: "application/json",
        dataBase64: Buffer.from('{"items":[]}').toString("base64"),
      },
    }));
    await runContextCommand(["context", "items", "--handle", handle], discussionControl, vi.fn());
    expect(discussionControl).toHaveBeenCalledExactlyOnceWith({
      kind: "retrieve-review-items-by-handle", handle,
    });
    expect(discussionControl).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "source-begin" }));

    const sourceControl = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "source-workflow",
      operation: "begin",
      response: {
        freshness: {
          identity: {
            placekeeperSessionId: "review-a", documentGeneration: 1,
            source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 1 },
            reviewRevision: 2, stateDigest: "b".repeat(64),
          },
          evidenceHandle: "evidence_freshabcdefghijkl",
        },
        result: {
          schemaVersion: 1, executionId: "execution-a", capturedAt: "2026-08-12T12:00:00.000Z",
          identity: {
            placekeeperSessionId: "review-a", documentGeneration: 1,
            source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 1 },
            reviewRevision: 2, stateDigest: "b".repeat(64),
          },
          items: [], sourceFingerprints: [], baselineDigest: "c".repeat(64),
        },
      },
    }));
    const write = vi.fn();
    expect(await runContextCommand([
      "context", "source", "begin", "--handle", handle, "--path", "paper.tex",
    ], sourceControl, write)).toBe(0);
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({
      ok: true, operation: "begin", freshness: { evidenceHandle: "evidence_freshabcdefghijkl" },
    });
  });

  it("loads proposal JSON from a bounded absolute file instead of requiring shell-quoted source text", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-source-payload-"));
    roots.push(root);
    const path = join(root, "proposal.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify({
      schemaVersion: 1,
      idempotencyKey: "proposal-1",
      baselineItemId: "item-1",
      path: "paper.tex",
      expectedText: "value with 'quotes' and $symbols",
      replacementText: "safe replacement",
    })));
    const control = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "source-workflow",
      operation: "propose",
      response: {
        freshness: {
          identity: {
            placekeeperSessionId: "review-a", documentGeneration: 1,
            source: { fileId: "file-a", digest: "a".repeat(64), byteLength: 1 },
            reviewRevision: 2, stateDigest: "b".repeat(64),
          },
          evidenceHandle: "evidence_freshabcdefghijkl",
        },
        result: {
          status: "accepted",
          proposal: {
            schemaVersion: 1, idempotencyKey: "proposal-1", baselineItemId: "item-1",
            path: "paper.tex", expectedText: "value with 'quotes' and $symbols",
            replacementText: "safe replacement",
          },
        },
      },
    }));
    expect(await runContextCommand([
      "context", "source", "propose", "--handle", "evidence_abcdefghijklmnop",
      "--execution", "execution-a", "--proposal-file", path,
    ], control, vi.fn())).toBe(0);
    expect(control).toHaveBeenCalledWith(expect.objectContaining({
      kind: "source-propose",
      proposal: expect.objectContaining({ expectedText: "value with 'quotes' and $symbols" }),
    }));
  });

  it("parses bounded evidence operations without accepting a task id or browser URL", () => {
    expect(parseContextEvidenceArguments([
      "context", "evidence", "--handle", "evidence_abcdefghijklmnop",
      "--kind", "raw-annotations", "--offset", "10", "--limit", "20", "--max-bytes", "4096",
    ])).toEqual({
      handle: "evidence_abcdefghijklmnop",
      request: { kind: "raw-annotations", offset: 10, limit: 20, maxBytes: 4096 },
    });
    expect(() => parseContextEvidenceArguments([
      "context", "evidence", "--handle", "evidence_abcdefghijklmnop", "--kind", "page-text",
    ])).toThrow(/page/u);
    expect(() => parseContextEvidenceArguments([
      "context", "evidence", "--handle", "evidence_abcdefghijklmnop", "--kind", "document", "--output", "relative.pdf",
    ])).toThrow(/invalid/u);
  });

  it("retrieves paginated canonical Review Items by opaque handle", async () => {
    expect(parseContextItemsArguments([
      "context", "items", "--handle", "evidence_abcdefghijklmnop", "--page", "2", "--offset", "0", "--limit", "25",
    ])).toEqual({ handle: "evidence_abcdefghijklmnop", pageIndex: 2, offset: 0, limit: 25 });
    const payload = JSON.stringify({ offset: 0, limit: 25, total: 1, items: [{ id: "item-1", intent: "replace", pageIndex: 2 }] });
    const control = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "evidence",
      result: {
        status: "ok",
        evidenceKind: "review-items",
        mediaType: "application/json",
        dataBase64: Buffer.from(payload).toString("base64"),
      },
    }));
    const write = vi.fn();
    expect(await runContextCommand([
      "context", "items", "--handle", "evidence_abcdefghijklmnop", "--page", "2", "--offset", "0", "--limit", "25",
    ], control, write)).toBe(0);
    expect(control).toHaveBeenCalledWith({
      kind: "retrieve-review-items-by-handle",
      handle: "evidence_abcdefghijklmnop",
      pageIndex: 2,
      offset: 0,
      limit: 25,
    });
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ ok: true, kind: "review-items", content: payload });
  });

  it("returns bounded text evidence through the installed daemon mediator", async () => {
    const control = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "evidence",
      result: {
        status: "ok",
        evidenceKind: "page-text",
        mediaType: "text/plain; charset=utf-8",
        dataBase64: Buffer.from("Current page text").toString("base64"),
      },
    }));
    const write = vi.fn();
    expect(await runContextCommand([
      "context", "evidence", "--handle", "evidence_abcdefghijklmnop",
      "--kind", "page-text", "--page", "0", "--max-bytes", "1024",
    ], control, write)).toBe(0);
    expect(control).toHaveBeenCalledWith({
      kind: "retrieve-evidence-by-handle",
      handle: "evidence_abcdefghijklmnop",
      request: { kind: "page-text", pageIndex: 0, maxBytes: 1024 },
    });
    expect(JSON.parse(write.mock.calls[0]![0] as string)).toMatchObject({ ok: true, content: "Current page text" });
  });

  it("keeps document bytes out of stdout and creates a private non-overwriting output", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-context-command-"));
    roots.push(root);
    const outputPath = join(root, "evidence.pdf");
    const control = vi.fn(async (): Promise<PlacekeeperControlResponse> => ({
      kind: "evidence",
      result: {
        status: "ok",
        evidenceKind: "document",
        mediaType: "application/pdf",
        dataBase64: Buffer.from("%PDF-private-evidence").toString("base64"),
      },
    }));
    const write = vi.fn();
    expect(await runContextCommand([
      "context", "evidence", "--handle", "evidence_abcdefghijklmnop",
      "--kind", "document", "--output", outputPath,
    ], control, write)).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe("%PDF-private-evidence");
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(write.mock.calls[0]![0]).not.toContain("%PDF-private-evidence");
    expect(await runContextCommand([
      "context", "evidence", "--handle", "evidence_abcdefghijklmnop",
      "--kind", "document", "--output", outputPath,
    ], control, vi.fn())).toBe(2);
  });
});
