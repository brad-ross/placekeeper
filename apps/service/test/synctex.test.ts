import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSyncTexOutput } from "../src/synctex/parser.js";
import { querySyncTex } from "../src/synctex/query.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pdf-proofreader-synctex-"));
  roots.push(root);
  await writeFile(join(root, "paper.tex"), "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n");
  return root;
}

describe("SyncTeX advisory hints", () => {
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
