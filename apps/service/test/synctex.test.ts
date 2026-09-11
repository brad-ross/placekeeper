import { gzipSync } from "node:zlib";
import { mkdtemp, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";

import { parseSyncTexOutput, parseSyncTexViewOutput } from "../src/synctex/parser.js";
import { querySyncTex, runSyncTex, syncTexProcessPath } from "../src/synctex/query.js";
import { SessionBroker } from "../src/sessions/session-broker.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-synctex-"));
  roots.push(root);
  await writeFile(join(root, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  return root;
}

async function generatedOutputFixture(
  options: { readonly sidecar?: "plain" | "compressed" | "both" | "missing" } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-generation-synctex-"));
  roots.push(root);
  const pdfPath = join(root, "paper.pdf");
  const sourcePath = join(root, "paper.tex");
  const sidecarText = "SyncTeX Version:1\nInput:1:paper.tex\nContent:\n";
  const pdf = await PDFDocument.create();
  pdf.addPage([320, 240]);
  await writeFile(pdfPath, await pdf.save({ useObjectStreams: false }));
  await writeFile(sourcePath, "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  if (options.sidecar !== "missing") {
    const formats = options.sidecar === "both" ? ["plain", "compressed"] as const : [options.sidecar];
    await Promise.all(formats.map((format) => writeFile(
      join(root, format === "compressed" ? "paper.synctex.gz" : "paper.synctex"),
      format === "compressed" ? gzipSync(sidecarText) : sidecarText,
    )));
  }
  const broker = new SessionBroker({ recoveryRoot: join(root, "recovery") });
  const opened = await broker.openReview({
    pdfPath,
    sourceRootPath: root,
    surface: "vscode",
    workflowMode: "generated-output",
  });
  if (opened.kind !== "opened") throw new Error("Expected generated output to open");
  return { root, pdfPath, sourcePath, broker, launch: opened.launch, sidecarText };
}

describe("SyncTeX advisory hints", () => {
  it("treats SyncTeX's negative column sentinel as unknown", () => {
    expect(parseSyncTexOutput(
      "Output:/work/paper.pdf\nInput:/work/paper.tex\nLine:7\nColumn:-1\n",
    )).toEqual([{ path: "/work/paper.tex", line: 7 }]);
  });

  it("parses multiple candidates and safely returns the contained relative source hint", async () => {
    const root = await fixture();
    const output = `SyncTeX result begin\nOutput:${join(root, "paper.tex")}\nLine:3\nColumn:1\nPage:1\nx:72\ny:144\nSyncTeX result end\n`;
    expect(parseSyncTexOutput(output)).toEqual([
      expect.objectContaining({ path: join(root, "paper.tex"), line: 3, page: 1 }),
    ]);
    const hint = await querySyncTex({
      sourceRoot: root,
      pdfPath: join(root, "paper.pdf"),
      pageIndex: 0,
      point: { x: 72, y: 144 },
      run: async (request) => {
        expect(request.argv).toEqual(["edit", "-o", `1:72:144:${join(root, "paper.pdf")}`]);
        expect(request.cwd).toBe(await realpath(root));
        expect(request.timeoutMs).toBeLessThanOrEqual(2_000);
        expect(request.maxOutputBytes).toBeLessThanOrEqual(64 * 1024);
        return { stdout: output, stderr: "", exitCode: 0 };
      },
    });
    expect(hint).toEqual({ path: "paper.tex", line: 3, confidence: "low", provenance: "synctex" });
  });

  it("skips stale candidates and selects the next usable contained result", async () => {
    const root = await fixture();
    const output = "Output:missing.tex\nLine:99\nPage:1\nx:72\ny:144\nOutput:paper.tex\nLine:3\nPage:1\nx:72\ny:144\n";
    expect(parseSyncTexOutput(output)).toHaveLength(2);
    await expect(querySyncTex({
      sourceRoot: root,
      pdfPath: join(root, "paper.pdf"),
      pageIndex: 0,
      point: { x: 72, y: 144 },
      run: async () => ({ stdout: output, stderr: "", exitCode: 0 }),
    })).resolves.toEqual({ path: "paper.tex", line: 3, confidence: "high", provenance: "synctex" });
  });

  it.each(["missing", "malformed", "timed-out", "oversized", "absolute-escape", "traversal"])(
    "omits unusable %s results without weakening fallback evidence",
    async (caseName) => {
      const root = await fixture();
      const outside = join(root, "..", "outside.tex");
      const stdout = caseName === "malformed" ? "not synctex"
        : caseName === "oversized" ? "x".repeat(70_000)
        : caseName === "absolute-escape" ? `Output:${outside}\nLine:2\nPage:1\nx:1\ny:1\n`
        : caseName === "traversal" ? "Output:../outside.tex\nLine:2\nPage:1\nx:1\ny:1\n"
        : "";
      const hint = await querySyncTex({
        sourceRoot: root, pdfPath: join(root, "paper.pdf"), pageIndex: 0,
        point: { x: 1, y: 1 },
        run: async () => caseName === "timed-out" ? { stdout: "", stderr: "", exitCode: null, timedOut: true }
          : caseName === "missing" ? { stdout: "", stderr: "ENOENT", exitCode: null }
          : { stdout, stderr: "", exitCode: 0 },
      });
      expect(hint).toBeUndefined();
    },
  );

  it("rejects an existing symlink whose physical target escapes the source root", async () => {
    const root = await fixture();
    const outside = join(root, "..", "outside-symlink.tex");
    await writeFile(outside, "outside");
    await symlink(outside, join(root, "linked.tex"));
    const hint = await querySyncTex({
      sourceRoot: root, pdfPath: join(root, "paper.pdf"), pageIndex: 0,
      point: { x: 1, y: 1 },
      run: async () => ({ stdout: `Output:${join(root, "linked.tex")}\nLine:1\nPage:1\nx:1\ny:1\n`, stderr: "", exitCode: 0 }),
    });
    expect(hint).toBeUndefined();
    await rm(outside, { force: true });
  });
});

describe("generation-bound SyncTeX navigation", () => {
  it("adds the stable MacTeX shim when a GUI host omits it from PATH", () => {
    expect(syncTexProcessPath("darwin", "/usr/bin:/bin"))
      .toBe("/Library/TeX/texbin:/usr/bin:/bin");
    expect(syncTexProcessPath("darwin", "/Library/TeX/texbin:/usr/bin"))
      .toBe("/Library/TeX/texbin:/usr/bin");
    expect(syncTexProcessPath("linux", "/usr/local/bin:/usr/bin"))
      .toBe("/usr/local/bin:/usr/bin");
  });

  it("enforces subprocess timeout, output, and unavailable-tool bounds", async () => {
    const root = await fixture();
    const [timedOut, oversized, unavailable] = await Promise.all([
      runSyncTex({
        executable: process.execPath,
        argv: ["-e", "setInterval(() => {}, 1000)"],
        cwd: root,
        timeoutMs: 50,
        maxOutputBytes: 1024,
      }),
      runSyncTex({
        executable: process.execPath,
        argv: ["-e", "process.stdout.write('x'.repeat(4096))"],
        cwd: root,
        timeoutMs: 2_000,
        maxOutputBytes: 128,
      }),
      runSyncTex({
        executable: join(root, "missing-synctex"),
        argv: [],
        cwd: root,
        timeoutMs: 2_000,
        maxOutputBytes: 128,
      }),
    ]);
    expect(timedOut).toMatchObject({ timedOut: true });
    expect(oversized).toMatchObject({ oversized: true });
    expect(unavailable).toMatchObject({ unavailableTool: true, exitCode: null });
  });

  it("parses forward view output and resolves both directions against one private sibling pair", async () => {
    const value = await generatedOutputFixture();
    expect(parseSyncTexViewOutput(
      "SyncTeX result begin\nOutput:source.pdf\nPage:1\nx:72\ny:144\nSyncTeX result end\n",
    )).toEqual([{ output: "source.pdf", page: 1, x: 72, y: 144 }]);

    let privatePdfPath = "";
    const forward = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "forward-panel-a-1",
      sourcePath: "paper.tex",
      line: 3,
      column: 1,
      run: async (request) => {
        expect(request.argv.slice(0, 2)).toEqual(["view", "-i"]);
        privatePdfPath = request.argv.at(-1)!;
        expect(privatePdfPath).not.toBe(value.pdfPath);
        return {
          stdout: `Output:${privatePdfPath}\nPage:1\nx:72\ny:144\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(forward).toMatchObject({
      status: "ok",
      operationToken: "forward-panel-a-1",
      documentGeneration: 1,
      target: { pageIndex: 0, x: 72, y: 144 },
    });

    const reverse = await value.broker.reverseSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "reverse-panel-a-1",
      pageIndex: 0,
      point: { x: 72, y: 144 },
      run: async (request) => {
        expect(request.argv).toEqual(["edit", "-o", `1:72:144:${privatePdfPath}`]);
        return {
          stdout: `Output:${value.sourcePath}\nLine:3\nColumn:1\nPage:1\nx:72\ny:144\n`,
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(reverse).toMatchObject({
      status: "ok",
      operationToken: "reverse-panel-a-1",
      target: { path: "paper.tex", line: 3, column: 1 },
    });
  });

  it("selects the last forward rectangle when SyncTeX returns multiple targets on one page", async () => {
    const value = await generatedOutputFixture();
    const result = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "forward-same-page-rectangles",
      sourcePath: "paper.tex",
      line: 3,
      column: 17,
      run: async (request) => ({
        stdout: [
          `Output:${request.argv.at(-1)}`,
          "Page:3",
          "x:167.669067",
          "y:156.585541",
          `Output:${request.argv.at(-1)}`,
          "Page:3",
          "x:191.745514",
          "y:168.540710",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result).toMatchObject({
      status: "ok",
      operationToken: "forward-same-page-rectangles",
      target: { pageIndex: 2, x: 191.745514, y: 168.540710 },
    });
  });

  it("selects the last forward target across Beamer overlay pages", async () => {
    const value = await generatedOutputFixture();
    const result = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "forward-conflicting-pages",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => ({
        stdout: [
          `Output:${request.argv.at(-1)}`,
          "Page:2",
          "x:72",
          "y:144",
          `Output:${request.argv.at(-1)}`,
          "Page:3",
          "x:72",
          "y:144",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result).toMatchObject({
      status: "ok",
      operationToken: "forward-conflicting-pages",
      target: { pageIndex: 2, x: 72, y: 144 },
    });
  });

  it("selects the final surviving bound forward record rather than the greatest page", async () => {
    const value = await generatedOutputFixture();
    const result = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "forward-tool-order",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => ({
        stdout: [
          `Output:${request.argv.at(-1)}`, "Page:9", "x:90", "y:90",
          `Output:${request.argv.at(-1)}`, "Page:2", "x:20", "y:20",
          "Output:/unbound/other.pdf", "Page:10", "x:100", "y:100",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result).toMatchObject({ status: "ok", target: { pageIndex: 1, x: 20, y: 20 } });
  });

  it("accepts a large bounded forward result from a Beamer frame", async () => {
    const value = await generatedOutputFixture();
    const result = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "forward-many-rectangles",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => {
        const stdout = `Output:${request.argv.at(-1)}\nPage:3\nx:72\ny:144\n`.repeat(1600);
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(64 * 1024);
        return { stdout, stderr: "", exitCode: 0,
          oversized: Buffer.byteLength(stdout) > request.maxOutputBytes };
      },
    });
    expect(result).toMatchObject({ status: "ok", target: { pageIndex: 2, x: 72, y: 144 } });
  });

  it("requires one unique contained reverse target", async () => {
    const value = await generatedOutputFixture();
    await writeFile(join(value.root, "other.tex"), "other");
    const result = await value.broker.reverseSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "reverse-ambiguous",
      pageIndex: 0,
      point: { x: 1, y: 2 },
      run: async () => ({
        stdout: `Output:paper.tex\nLine:3\nPage:1\nx:1\ny:2\nOutput:other.tex\nLine:1\nPage:1\nx:1\ny:2\n`,
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result).toMatchObject({ status: "ambiguous", operationToken: "reverse-ambiguous" });
  });

  it.each([
    ["unavailable-tool", { stdout: "", stderr: "", exitCode: null, unavailableTool: true }],
    ["timeout", { stdout: "", stderr: "", exitCode: null, timedOut: true }],
    ["oversized", { stdout: "x".repeat(1024 * 1024 + 1), stderr: "", exitCode: 0 }],
    ["malformed", { stdout: "not synctex", stderr: "", exitCode: 0 }],
  ] as const)("reports %s without collapsing failure states", async (status, runResult) => {
    const value = await generatedOutputFixture();
    const result = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: `forward-${status}`,
      sourcePath: "paper.tex",
      line: 3,
      run: async () => runResult,
    });
    expect(result.status).toBe(status);
  });

  it("distinguishes missing, pending, stale, and out-of-root availability", async () => {
    const missing = await generatedOutputFixture({ sidecar: "missing" });
    await expect(missing.broker.forwardSyncTex({
      sessionId: missing.launch.sessionId,
      operationToken: "missing-sidecar",
      sourcePath: "paper.tex",
      line: 3,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ status: "missing" });

    const pendingPdf = await PDFDocument.create();
    pendingPdf.addPage([400, 300]);
    await writeFile(missing.pdfPath, await pendingPdf.save({ useObjectStreams: false }));
    await expect(missing.broker.replaceLiveDocument({
      sessionId: missing.launch.sessionId,
      outputPath: missing.pdfPath,
      observationEpoch: 1,
    })).resolves.toMatchObject({ status: "committed", documentGeneration: 2 });
    await expect(missing.broker.forwardSyncTex({
      sessionId: missing.launch.sessionId,
      operationToken: "pending-sidecar",
      sourcePath: "paper.tex",
      line: 3,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ status: "pending", documentGeneration: 2 });

    const ambiguous = await generatedOutputFixture({ sidecar: "both" });
    await expect(ambiguous.broker.forwardSyncTex({
      sessionId: ambiguous.launch.sessionId,
      operationToken: "ambiguous-sidecar",
      sourcePath: "paper.tex",
      line: 3,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ status: "ambiguous" });

    const stale = await generatedOutputFixture();
    const replacement = await PDFDocument.create();
    replacement.addPage([500, 300]);
    await writeFile(stale.pdfPath, await replacement.save({ useObjectStreams: false }));
    await stale.broker.replaceLiveDocument({
      sessionId: stale.launch.sessionId,
      outputPath: stale.pdfPath,
      observationEpoch: 1,
    });
    await expect(stale.broker.forwardSyncTex({
      sessionId: stale.launch.sessionId,
      operationToken: "unchanged-old-sidecar",
      sourcePath: "paper.tex",
      line: 3,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ status: "stale", documentGeneration: 2 });

    const unsafe = await generatedOutputFixture();
    const outside = join(unsafe.root, "..", "outside-forward.tex");
    await writeFile(outside, "outside");
    await expect(unsafe.broker.forwardSyncTex({
      sessionId: unsafe.launch.sessionId,
      operationToken: "outside-source",
      sourcePath: outside,
      line: 1,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ status: "out-of-root" });
    await rm(outside, { force: true });
  });

  it("accepts sidecar-before-PDF, sidecar-after-PDF, and compressed replacements only for the current generation", async () => {
    const value = await generatedOutputFixture();
    await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "attach-generation-one",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => ({
        stdout: `Output:${request.argv.at(-1)}\nPage:1\nx:1\ny:2\n`, stderr: "", exitCode: 0,
      }),
    });

    await writeFile(join(value.root, "paper.synctex"), `${value.sidecarText}generation:2\n`);
    const secondPdf = await PDFDocument.create();
    secondPdf.addPage([400, 300]);
    await writeFile(value.pdfPath, await secondPdf.save({ useObjectStreams: false }));
    const equalTimestamp = new Date("2026-08-27T12:00:00.000Z");
    await Promise.all([
      utimes(value.pdfPath, equalTimestamp, equalTimestamp),
      utimes(join(value.root, "paper.synctex"), equalTimestamp, equalTimestamp),
    ]);
    await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    });
    const beforePdf = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "sidecar-before-pdf",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => ({
        stdout: `Output:${request.argv.at(-1)}\nPage:2\nx:2\ny:3\n`, stderr: "", exitCode: 0,
      }),
    });
    expect(beforePdf).toMatchObject({ status: "ok", documentGeneration: 2, target: { pageIndex: 1 } });

    await unlink(join(value.root, "paper.synctex"));
    const thirdPdf = await PDFDocument.create();
    thirdPdf.addPage([500, 300]);
    await writeFile(value.pdfPath, await thirdPdf.save({ useObjectStreams: false }));
    await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 2,
    });
    await expect(value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "before-sidecar-arrival",
      sourcePath: "paper.tex",
      line: 3,
      run: async () => { throw new Error("must not run"); },
    })).resolves.toMatchObject({ status: "pending", documentGeneration: 3 });

    await writeFile(join(value.root, "paper.synctex.gz"), gzipSync(`${value.sidecarText}generation:3\n`));
    const afterPdf = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "compressed-sidecar-after-pdf",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => ({
        stdout: `Output:${request.argv.at(-1)}\nPage:3\nx:3\ny:4\n`, stderr: "", exitCode: 0,
      }),
    });
    expect(afterPdf).toMatchObject({ status: "ok", documentGeneration: 3, target: { pageIndex: 2 } });
  });

  it("ignores a late result after a rapid successor changes generation and sidecar", async () => {
    const value = await generatedOutputFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "old-panel-cursor",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => {
        entered.resolve();
        await release.promise;
        return { stdout: `Output:${request.argv.at(-1)}\nPage:1\nx:1\ny:2\n`, stderr: "", exitCode: 0 };
      },
    });
    await entered.promise;
    await writeFile(join(value.root, "paper.synctex"), `${value.sidecarText}successor\n`);
    const successor = await PDFDocument.create();
    successor.addPage([600, 300]);
    await writeFile(value.pdfPath, await successor.save({ useObjectStreams: false }));
    await value.broker.replaceLiveDocument({
      sessionId: value.launch.sessionId, outputPath: value.pdfPath, observationEpoch: 1,
    });
    release.resolve();
    await expect(pending).resolves.toMatchObject({ status: "stale", operationToken: "old-panel-cursor" });
  });

  it("ignores an older cursor operation when a newer panel operation wins the same generation", async () => {
    const value = await generatedOutputFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const older = value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "panel-a-cursor-1",
      sourcePath: "paper.tex",
      line: 2,
      run: async (request) => {
        entered.resolve();
        await release.promise;
        return { stdout: `Output:${request.argv.at(-1)}\nPage:1\nx:1\ny:2\n`, stderr: "", exitCode: 0 };
      },
    });
    await entered.promise;
    const newer = await value.broker.forwardSyncTex({
      sessionId: value.launch.sessionId,
      operationToken: "panel-b-cursor-2",
      sourcePath: "paper.tex",
      line: 3,
      run: async (request) => ({
        stdout: `Output:${request.argv.at(-1)}\nPage:1\nx:3\ny:4\n`, stderr: "", exitCode: 0,
      }),
    });
    expect(newer).toMatchObject({ status: "ok", operationToken: "panel-b-cursor-2" });
    release.resolve();
    await expect(older).resolves.toMatchObject({ status: "stale", operationToken: "panel-a-cursor-1" });
  });
});
