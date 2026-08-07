import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import {
  createHandoff,
  type HandoffV1,
} from "../src/handoff.js";
import type { ReviewState } from "../src/review-model.js";
import {
  validateDispositionDocument,
  validateHandoffDocument,
} from "../../../apps/service/src/handoff/schema-validator.js";

const id = (suffix: number) =>
  `00000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`;

const base = {
  schemaVersion: 1 as const,
  sessionId: id(99),
  source: { fileId: id(98), digest: "a".repeat(64), byteLength: 100 },
  sourceRootId: id(97),
  revision: 5,
  lifecycle: "active" as const,
  history: [],
  historyCursor: 0,
};

const rect = { x: 72, y: 90, width: 100, height: 14 };
const selection = {
  quote: "selected words",
  prefix: "before ",
  suffix: " after",
  rect,
  segmentRects: [rect],
  reliable: true,
};

const state: ReviewState = {
  ...base,
  items: [
    { id: id(1), kind: "replace", pageIndex: 0, createdAt: "2026-08-07T12:00:00.000Z", updatedAt: "2026-08-07T12:00:00.000Z", payload: { ...selection, proposedText: "new words" } },
    { id: id(2), kind: "delete", pageIndex: 0, createdAt: "2026-08-07T12:00:01.000Z", updatedAt: "2026-08-07T12:00:01.000Z", payload: selection },
    { id: id(3), kind: "insert", pageIndex: 1, createdAt: "2026-08-07T12:00:02.000Z", updatedAt: "2026-08-07T12:00:02.000Z", payload: { position: rect, leftContext: "left", rightContext: "right", reliable: true, proposedText: "inserted" } },
    { id: id(4), kind: "highlight", pageIndex: 1, createdAt: "2026-08-07T12:00:03.000Z", updatedAt: "2026-08-07T12:00:03.000Z", payload: { ...selection, comment: "consider this" } },
    { id: id(5), kind: "pageNote", pageIndex: 2, createdAt: "2026-08-07T12:00:04.000Z", updatedAt: "2026-08-07T12:00:04.000Z", payload: { position: rect, comment: "page-level note", nearbyText: "nearby" } },
  ],
};

async function validator(name: "handoff" | "disposition") {
  const schema = JSON.parse(
    await readFile(resolve(`schemas/${name}-v1.schema.json`), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

function handoff(): HandoffV1 {
  return createHandoff({
    state,
    createdAt: "2026-08-07T13:00:00.000Z",
    reviewedPdf: { path: "/tmp/paper-reviewed.pdf", sha256: "b".repeat(64) },
    sourceRoot: "/tmp/source",
    resultDirectory: "/tmp/result-001",
    revisedPdfDestination: "/tmp/result-001/paper-revised.pdf",
    sourceHints: new Map([[id(1), { path: "paper.tex", line: 12, confidence: "high", provenance: "synctex" }]]),
  });
}

describe("handoff and disposition schemas", () => {
  it("losslessly projects every review kind into a valid ordered handoff", async () => {
    const value = handoff();
    const validate = await validator("handoff");
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(value.items.map(({ id }) => id)).toEqual(state.items.map(({ id }) => id));
    expect(value.items.map(({ intent }) => intent)).toEqual([
      "replace", "delete", "insert", "highlight", "pageNote",
    ]);
    expect(value.items[2]).not.toHaveProperty("anchor.quote");
    expect(value.items[2]).toMatchObject({
      anchor: { kind: "caret", leftContext: "left", rightContext: "right" },
    });
  });

  it("rejects unknown fields, duplicate IDs, missing anchors/selection geometry, out-of-root hints, and unsupported major versions", async () => {
    const validate = await validator("handoff");
    const mutations = [
      (value: any) => { value.extra = true; },
      (value: any) => { delete value.items[0].anchor.quote; },
      (value: any) => { delete value.items[0].coordinates.segmentRects; },
      (value: any) => { value.items[0].sourceHint = { path: "../escape.tex", line: 1, confidence: "high", provenance: "synctex" }; },
      (value: any) => { value.schemaVersion = "2.0"; },
    ];
    for (const mutate of mutations) {
      const value = structuredClone(handoff());
      mutate(value);
      expect(validate(value)).toBe(false);
    }
    const duplicate = structuredClone(handoff());
    (duplicate.items[1] as { id: string }).id = duplicate.items[0]!.id;
    expect((await validateHandoffDocument(duplicate)).valid).toBe(false);
  });

  it("validates disposition shape while leaving cross-artifact exact-ID accounting to result checking", async () => {
    const validate = await validator("disposition");
    const disposition = {
      schemaVersion: "1.0",
      reviewId: state.sessionId,
      handoffSha256: "c".repeat(64),
      reviewedPdfSha256: "b".repeat(64),
      build: { status: "succeeded", outputSha256: "d".repeat(64) },
      changedPaths: ["paper.tex"],
      revisedPdf: { path: "/tmp/result-001/paper-revised.pdf", sha256: "d".repeat(64) },
      items: state.items.map((item, index) => ({
        id: item.id,
        status: (["Applied", "Already satisfied", "Ambiguous", "Not applied", "Applied"] as const)[index],
        explanation: "Recorded result",
        ...(index === 0 ? { changedPaths: ["paper.tex"] } : {}),
      })),
    };
    expect(validate(disposition), JSON.stringify(validate.errors)).toBe(true);
    disposition.items[1]!.id = disposition.items[0]!.id;
    expect((await validateDispositionDocument(disposition)).valid).toBe(false);
  });
});
