import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseContextEvidenceArguments,
  parseContextItemsArguments,
  runContextCommand,
} from "../src/cli/context-command.js";
import type { ProofreaderControlResponse } from "../src/host/launch-control.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("context evidence command", () => {
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
    const control = vi.fn(async (): Promise<ProofreaderControlResponse> => ({
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
    const control = vi.fn(async (): Promise<ProofreaderControlResponse> => ({
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
    const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-context-command-"));
    roots.push(root);
    const outputPath = join(root, "evidence.pdf");
    const control = vi.fn(async (): Promise<ProofreaderControlResponse> => ({
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
