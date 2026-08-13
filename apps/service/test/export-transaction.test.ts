import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PdfWriteResult,
  PdfWriter,
  ReviewAnnotation,
} from "../../../packages/core/src/pdf-writer.js";
import { addHighlight } from "../../../packages/core/src/review-commands.js";
import type { ReviewSourceIdentity } from "../../../packages/core/src/review-model.js";
import { createReviewState } from "../../../packages/core/src/review-model.js";
import { FileCapabilityRegistry } from "../src/files/file-capabilities.js";
import { ExportCoordinator } from "../src/export/export-coordinator.js";
import { DraftSnapshotStore } from "../src/recovery/draft-snapshot.js";
import { SessionControlRegistry } from "../src/sessions/control-socket.js";
import { SessionBroker } from "../src/sessions/session-broker.js";

const temporaryDirectories: string[] = [];
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "placekeeper-export-"));
  temporaryDirectories.push(path);
  return path;
}

function annotation(): ReviewAnnotation {
  return {
    kind: "highlight",
    id: randomUUID(),
    pageIndex: 0,
    rect: { x: 72, y: 92, width: 80, height: 14 },
    quadPoints: [{ x: 72, y: 92, width: 80, height: 14 }],
    contents: "Check this.",
    author: "Placekeeper",
    createdAt: "2026-08-07T12:00:00.000Z",
    modifiedAt: "2026-08-07T12:00:00.000Z",
    textAnchorReliable: true,
  };
}

async function exportFixture() {
  const directory = await temporaryDirectory();
  const originalPath = join(directory, "paper.pdf");
  const snapshotPath = join(directory, "snapshot.pdf");
  const original = Buffer.from("%PDF-1.7\noriginal immutable bytes\n%%EOF");
  const reviewed = Buffer.from("%PDF-1.7\nreviewed bytes\n%%EOF");
  await writeFile(originalPath, original);
  await writeFile(snapshotPath, original);
  const capabilities = new FileCapabilityRegistry();
  const approved = await capabilities.approvePdf(originalPath);
  const source: ReviewSourceIdentity = {
    fileId: approved.id,
    digest: sha256(original),
    byteLength: original.byteLength,
  };
  const item = annotation();
  const result: PdfWriteResult = {
    pdfBytes: reviewed,
    evidence: {
      backend: "embedpdf",
      backendVersion: "2.14.4",
      originalSha256: source.digest,
      outputSha256: sha256(reviewed),
      pageCount: 1,
      structurallyValid: true,
      preexistingAnnotationIds: [],
      annotations: [],
    },
  };
  return {
    directory,
    originalPath,
    snapshotPath,
    original,
    reviewed,
    capabilities,
    approved,
    source,
    item,
    result,
    delivery: (revision = 1, annotations: readonly ReviewAnnotation[] = [item]) => ({
      sessionId: "00000000-0000-4000-8000-000000000099",
      source,
      originalDigest: source.digest,
      revision,
      sourceSnapshotPath: snapshotPath,
      annotations,
    }),
  };
}

describe("reviewed PDF export transaction", () => {
  it("atomically saves a reviewed copy without changing the original", async () => {
    const directory = await temporaryDirectory();
    const originalPath = join(directory, "paper.pdf");
    const snapshotPath = join(directory, "snapshot.pdf");
    const original = Buffer.from("%PDF-1.7\noriginal immutable bytes\n%%EOF");
    const reviewed = Buffer.from("%PDF-1.7\nreviewed bytes\n%%EOF");
    await writeFile(originalPath, original);
    await writeFile(snapshotPath, original);

    const capabilities = new FileCapabilityRegistry();
    const approved = await capabilities.approvePdf(originalPath);
    const state = {
      ...createReviewState({
        sessionId: randomUUID(),
        source: {
          fileId: approved.id,
          digest: sha256(original),
          byteLength: original.byteLength,
        },
      }),
      revision: 1,
    };
    const item = annotation();
    const result: PdfWriteResult = {
      pdfBytes: reviewed,
      evidence: {
        backend: "embedpdf",
        backendVersion: "2.14.4",
        originalSha256: sha256(original),
        outputSha256: sha256(reviewed),
        pageCount: 1,
        structurallyValid: true,
        preexistingAnnotationIds: [],
        annotations: [],
      },
    };
    const writer: PdfWriter = { write: async () => result };
    let recorded = 0;
    const coordinator = new ExportCoordinator({
      writer,
      capabilities,
      verify: async () => ({ pageCount: 1, annotationIds: [item.id] }),
      recordSuccessfulExport: async () => {
        recorded += 1;
      },
    });

    const exported = await coordinator.exportReviewedCopy({
      sessionId: state.sessionId,
      source: state.source,
      originalDigest: state.source.digest,
      revision: state.revision,
      sourceSnapshotPath: snapshotPath,
      annotations: [item],
    });

    expect(exported.path).toBe(
      join(dirname(approved.canonicalPath), "paper-reviewed.pdf"),
    );
    expect(await readFile(exported.path)).toEqual(reviewed);
    expect(await readFile(originalPath)).toEqual(original);
    expect(recorded).toBe(1);
  });

  it("deduplicates concurrent exports and chooses collision-safe names without overwriting", async () => {
    const fixture = await exportFixture();
    const priorPath = join(fixture.directory, "paper-reviewed.pdf");
    await writeFile(priorPath, "prior reviewed artifact");
    let writes = 0;
    let recorded = 0;
    const coordinator = new ExportCoordinator({
      writer: {
        write: async () => {
          writes += 1;
          return fixture.result;
        },
      },
      capabilities: fixture.capabilities,
      verify: async () => ({ pageCount: 1, annotationIds: [fixture.item.id] }),
      recordSuccessfulExport: async () => {
        recorded += 1;
      },
    });

    const [first, duplicate] = await Promise.all([
      coordinator.exportReviewedCopy(fixture.delivery()),
      coordinator.exportReviewedCopy(fixture.delivery()),
    ]);
    const repeated = await coordinator.exportReviewedCopy(fixture.delivery());
    const laterRevision = await coordinator.exportReviewedCopy(fixture.delivery(2));

    expect(first.path).toBe(duplicate.path);
    expect(repeated.path).toBe(first.path);
    expect(first.path).toMatch(/paper-reviewed-2\.pdf$/u);
    expect(laterRevision.path).toMatch(/paper-reviewed-3\.pdf$/u);
    expect(await readFile(priorPath, "utf8")).toBe("prior reviewed artifact");
    expect(writes).toBe(2);
    expect(recorded).toBe(2);
  });

  it.each(["verification", "finalization"] as const)(
    "cleans private candidates and preserves prior artifacts after %s failure",
    async (failure) => {
      const fixture = await exportFixture();
      const priorPath = join(fixture.directory, "paper-reviewed.pdf");
      await writeFile(priorPath, "stable prior artifact");
      let recorded = 0;
      const coordinator = new ExportCoordinator({
        writer: { write: async () => fixture.result },
        capabilities: fixture.capabilities,
        verify: async () => {
          if (failure === "verification") throw new Error("verification failed");
          return { pageCount: 1, annotationIds: [fixture.item.id] };
        },
        hooks: {
          beforeFinalize: () => {
            if (failure === "finalization") throw new Error("finalize failed");
          },
        },
        recordSuccessfulExport: async () => {
          recorded += 1;
        },
      });

      await expect(
        coordinator.exportReviewedCopy(fixture.delivery()),
      ).rejects.toThrow(`${failure === "verification" ? "verification" : "finalize"} failed`);
      expect(await readFile(fixture.originalPath)).toEqual(fixture.original);
      expect(await readFile(priorPath, "utf8")).toBe("stable prior artifact");
      expect((await readdir(fixture.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(recorded).toBe(0);
    },
  );

  it("rejects empty reviews before invoking the writer", async () => {
    const fixture = await exportFixture();
    let writes = 0;
    const coordinator = new ExportCoordinator({
      writer: {
        write: async () => {
          writes += 1;
          return fixture.result;
        },
      },
      capabilities: fixture.capabilities,
    });

    expect(() => coordinator.exportReviewedCopy(fixture.delivery(0, []))).toThrow(
      "There is no review feedback to deliver",
    );
    expect(writes).toBe(0);
  });

  it("freezes an acknowledged broker revision and retains recovery after export", async () => {
    const directory = await temporaryDirectory();
    const originalPath = join(directory, "paper.pdf");
    const original = Buffer.from("%PDF-1.7\nrecoverable original\n%%EOF");
    const reviewed = Buffer.from("%PDF-1.7\nrecoverable reviewed\n%%EOF");
    await writeFile(originalPath, original);
    const recoveryRoot = join(directory, "recovery");
    const broker = new SessionBroker({ recoveryRoot });
    const opened = await broker.openReview({ pdfPath: originalPath });
    if (opened.kind !== "opened") throw new Error("Expected opened review");
    const state = broker.state(opened.launch.sessionId)!;
    await broker.acceptMutation(
      opened.launch.sessionId,
      addHighlight(state, {
        pageIndex: 0,
        quote: "recoverable",
        prefix: "",
        suffix: " original",
        rect: { x: 72, y: 92, width: 80, height: 14 },
        segmentRects: [{ x: 72, y: 92, width: 80, height: 14 }],
        reliable: true,
      }),
    );
    const frozen = await broker.freezeDelivery(opened.launch.sessionId);
    expect(frozen.annotations).toMatchObject([{
      author: "Placekeeper",
      custom: {
        placekeeper: {
          owner: "placekeeper",
          schemaVersion: 2,
          projection: { author: "Placekeeper" },
        },
      },
    }]);
    const result: PdfWriteResult = {
      pdfBytes: reviewed,
      evidence: {
        backend: "embedpdf",
        backendVersion: "2.14.4",
        originalSha256: frozen.source.digest,
        outputSha256: sha256(reviewed),
        pageCount: 1,
        structurallyValid: true,
        preexistingAnnotationIds: [],
        annotations: [],
      },
    };
    const coordinator = new ExportCoordinator({
      writer: { write: async () => result },
      capabilities: broker.capabilities,
      controls: broker.controls,
      verify: async () => ({
        pageCount: 1,
        annotationIds: frozen.annotations.map(({ id }) => id),
      }),
      recordSuccessfulExport: (sessionId) => broker.recordSuccessfulExport(sessionId),
    });

    await coordinator.exportReviewedCopy(frozen);

    const recovered = await new DraftSnapshotStore(
      join(recoveryRoot, opened.launch.sessionId),
    ).recover();
    expect(frozen).toMatchObject({ revision: 1, annotations: [{ kind: "highlight" }] });
    expect(recovered).toMatchObject({
      state: { revision: 1, items: [{ kind: "highlight" }] },
    });
    expect(recovered?.lastExportAt).toBeDefined();
    expect(await readFile(originalPath)).toEqual(original);
  });

  it("does not finalize when session cancellation arrives at the commit boundary", async () => {
    const fixture = await exportFixture();
    const controls = new SessionControlRegistry();
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      controls,
      verify: async () => ({ pageCount: 1, annotationIds: [fixture.item.id] }),
      hooks: {
        beforeFinalize: () => controls.cancel(fixture.delivery().sessionId),
      },
    });

    await expect(coordinator.exportReviewedCopy(fixture.delivery())).rejects.toThrow(
      "Review session ended",
    );
    expect((await readdir(fixture.directory)).filter((name) => /reviewed.*\.pdf$/u.test(name))).toEqual([]);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.original);
  });

  it("returns a committed warning when directory sync fails after the reviewed copy link", async () => {
    const fixture = await exportFixture();
    let recorded = 0;
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: async () => ({ pageCount: 1, annotationIds: [fixture.item.id] }),
      hooks: {
        beforeCommittedDirectorySync: (kind) => {
          if (kind === "reviewed-copy") throw new Error("simulated directory sync failure");
        },
      },
      recordSuccessfulExport: async () => {
        recorded += 1;
      },
    });

    const result = await coordinator.exportReviewedCopy(fixture.delivery());

    expect(result.warning).toContain("reviewed copy was created");
    expect(await readFile(result.path)).toEqual(fixture.reviewed);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.original);
    expect(recorded).toBe(1);
  });

  it("returns a committed warning when reviewed-copy bookkeeping fails after the link", async () => {
    const fixture = await exportFixture();
    const coordinator = new ExportCoordinator({
      writer: { write: async () => fixture.result },
      capabilities: fixture.capabilities,
      verify: async () => ({ pageCount: 1, annotationIds: [fixture.item.id] }),
      recordSuccessfulExport: async () => {
        throw new Error("simulated post-link bookkeeping failure");
      },
    });

    const result = await coordinator.exportReviewedCopy(fixture.delivery());

    expect(result.warning).toContain("reviewed copy was created");
    expect(await readFile(result.path)).toEqual(fixture.reviewed);
    expect(await readFile(fixture.originalPath)).toEqual(fixture.original);
    expect((await readdir(fixture.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
