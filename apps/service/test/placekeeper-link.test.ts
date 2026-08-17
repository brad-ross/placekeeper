import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { encodePlacekeeperLink } from "../../../packages/core/src/placekeeper-link.js";
import {
  createPlacekeeperLinkForPdf,
  parsePlacekeeperReadableViewRoute,
  resolvePlacekeeperLink,
} from "../src/links/placekeeper-link.js";

const roots: string[] = [];
const viewId = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(name = "paper.pdf"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "placekeeper-link-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, "%PDF-1.7\n%%EOF");
  return path;
}

describe("Placekeeper service links", () => {
  it("derives inert recovery metadata from a readable route without requiring the PDF", () => {
    expect(parsePlacekeeperReadableViewRoute(
      `/r/${viewId}/missing/Paper%20%231%20%E8%AE%BA%E6%96%87.pdf`,
    )).toEqual({
      viewId,
      pdfPath: "/missing/Paper #1 论文.pdf",
      appLinkBase: "placekeeper:///missing/Paper%20%231%20%E8%AE%BA%E6%96%87.pdf",
    });
  });

  it("rejects ambiguous readable routes instead of constructing a recovery link", () => {
    expect(() => parsePlacekeeperReadableViewRoute(
      `/r/${viewId}/missing/../secret.pdf`,
    )).toThrow();
    expect(() => parsePlacekeeperReadableViewRoute(
      `/r/${viewId}/missing/paper%2Fsecret.pdf`,
    )).toThrow();
  });

  it("turns a decoded local path into the canonical file URL and ready app-link base", async () => {
    const path = await fixture("paper #1 %2F 论文.pdf");
    const prepared = await createPlacekeeperLinkForPdf(path, { kind: "page", page: 2 });
    const canonicalPath = await realpath(path);

    expect(prepared).toEqual({
      pdfPath: canonicalPath,
      pdfFileUrl: pathToFileURL(canonicalPath).href,
      appLinkBase: encodePlacekeeperLink({ path: canonicalPath, location: { kind: "page", page: 1 } }).split("#")[0],
      appLink: encodePlacekeeperLink({ path: canonicalPath, location: { kind: "page", page: 2 } }),
      location: { kind: "page", page: 2 },
    });

    await expect(resolvePlacekeeperLink(prepared.appLink)).resolves.toEqual(prepared);
  });

  it.each([
    ["missing", "missing.pdf", undefined],
    ["non-PDF extension", "notes.txt", "%PDF-1.7\n%%EOF"],
    ["non-PDF contents", "fake.pdf", "not a pdf"],
  ])("fails a %s input by its filename", async (_caseName, name, contents) => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-link-"));
    roots.push(root);
    const path = join(root, name);
    if (contents !== undefined) await writeFile(path, contents);

    await expect(createPlacekeeperLinkForPdf(path, { kind: "page", page: 1 }))
      .rejects.toThrow(name);
  });

  it("fails an unreadable PDF by name where file permissions are enforced", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const path = await fixture("private.pdf");
    await chmod(path, 0);
    await expect(createPlacekeeperLinkForPdf(path, { kind: "page", page: 1 }))
      .rejects.toThrow("private.pdf");
  });
});
