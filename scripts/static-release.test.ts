import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import type { APIRequestContext } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";

import { sha256Hex } from "../packages/core/src/sha256.js";
import {
  createSmokePdf,
  observedSourceIsNewer,
  parseArguments,
  parseIdentity,
} from "./smoke-static-site.js";

async function workflow(name: string): Promise<string> {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

function jobNames(source: string): string[] {
  return [...source.slice(source.indexOf("\njobs:\n") + 7).matchAll(/^  ([a-z][a-z0-9_-]*):\n/gmu)]
    .map((match) => match[1]!);
}

function expectImmutableActionPins(source: string): void {
  const pins = [...source.matchAll(/^\s+uses:\s+[^@\s]+@([^\s]+)\s+#\s+v\S+$/gmu)]
    .map((match) => match[1]!);
  expect(pins.length).toBeGreaterThan(0);
  expect(pins.every((pin) => /^[0-9a-f]{40}$/u.test(pin))).toBe(true);
}

describe("static release workflows", () => {
  it("keeps the pull-request gate bounded and unprivileged", async () => {
    const source = await workflow("static-web.yml");
    const triggers = source.slice(0, source.indexOf("\nconcurrency:\n"));
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain('- "scripts/**"');
    expect(triggers).not.toContain("apps/chrome-extension/scripts/embedpdf-worker-source");
    expect(triggers).not.toMatch(/pull_request_target:|push:|schedule:/u);
    expect(source).toContain("cancel-in-progress: true");
    expect(source).toContain("permissions: {}\n");
    expect(source).toContain("contents: read");
    expect(source).not.toContain("pages: write");
    expect(source).not.toContain("id-token: write");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("run: pnpm test:static:pr");
    expect(jobNames(source)).toEqual(["static-web"]);
    expectImmutableActionPins(source);
  });

  it("keeps publication manual, two-job, single-build, and fail closed", async () => {
    const source = await workflow("deploy-pages.yml");
    const triggers = source.slice(0, source.indexOf("\nconcurrency:\n"));
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toMatch(/pull_request(?:_target)?:|push:|schedule:/u);
    expect(jobNames(source)).toEqual(["package", "deploy"]);
    expect(source.match(/pnpm build:static:pages/gu)).toHaveLength(1);
    expect(source).toContain("vars.PLACEKEEPER_PAGES_PUBLICATION == 'enabled'");
    expect(source).toContain("github.ref == 'refs/heads/main'");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("https://brad-ross.github.io/placekeeper");
    expect(source).toContain("actions/deploy-pages@");

    const deployJob = source.slice(source.indexOf("\n  deploy:\n"));
    expect(deployJob).not.toContain("actions/checkout@");
    expect(deployJob).not.toMatch(/^\s+run:/gmu);
    expect(deployJob).not.toContain("pnpm ");
    expect(deployJob).toContain("contents: read");
    expect(deployJob).toContain("pages: write");
    expect(deployJob).toContain("id-token: write");
    expectImmutableActionPins(source);
  });
});

describe("static live smoke inputs", () => {
  it("accepts only the reviewed target and exact identities", () => {
    const source = "a".repeat(40);
    const content = "b".repeat(64);
    expect(parseArguments([
      "--url", "https://brad-ross.github.io/placekeeper/",
      "--source", source,
      "--content", content,
      "--first-release",
    ])).toEqual({
      targetUrl: "https://brad-ross.github.io/placekeeper/",
      sourceSha: source,
      contentDigest: content,
      firstRelease: true,
    });
    expect(() => parseArguments([
      "--url", "https://example.com/placekeeper/",
      "--source", source,
      "--content", content,
    ])).toThrow("reviewed Pages target");
  });

  it("accepts only a coherent, safe manifest identity", () => {
    const manifestBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      entries: [{ path: "assets/app-abcdefgh.js", bytes: 3, sha256: "c".repeat(64) }],
    })}\n`);
    const contentDigest = sha256Hex(manifestBytes);
    const versionBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      sourceSha: "a".repeat(40),
      base: "/placekeeper/",
      contentManifestSha256: contentDigest,
    })}\n`);
    expect(parseIdentity(versionBytes, manifestBytes)).toMatchObject({
      sourceSha: "a".repeat(40),
      contentDigest,
    });

    const unsafeManifest = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      entries: [{ path: "../outside", bytes: 3, sha256: "c".repeat(64) }],
    })}\n`);
    const unsafeVersion = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      sourceSha: "a".repeat(40),
      base: "/placekeeper/",
      contentManifestSha256: sha256Hex(unsafeManifest),
    })}\n`);
    expect(() => parseIdentity(unsafeVersion, unsafeManifest)).toThrow("unsafe or malformed");
  });

  it("classifies a remotely newer source even when its commit is absent locally", async () => {
    const expected = "d".repeat(40);
    const unseenObserved = "e".repeat(40);
    const requests: Array<{ readonly url: string; readonly options: Record<string, unknown> }> = [];
    const request = {
      get: async (url: string, options: Record<string, unknown>) => {
        requests.push({ url, options });
        return {
          url: () => url,
          status: () => 200,
          json: async () => ({ status: "ahead" }),
        };
      },
    } as unknown as APIRequestContext;

    await expect(observedSourceIsNewer(request, expected, unseenObserved, Date.now() + 1_000))
      .resolves.toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      `https://api.github.com/repos/brad-ross/placekeeper/compare/${expected}...${unseenObserved}`,
    );
    expect(requests[0]!.options).toMatchObject({
      failOnStatusCode: false,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
    expect(JSON.stringify(requests[0]!.options)).not.toMatch(/authorization|token/iu);
  });

  it.each(["behind", "diverged", "identical"])(
    "does not classify a %s source comparison as superseded",
    async (status) => {
      const expectedUrl = `https://api.github.com/repos/brad-ross/placekeeper/compare/${"a".repeat(40)}...${"b".repeat(40)}`;
      const request = {
        get: async () => ({
          url: () => expectedUrl,
          status: () => 200,
          json: async () => ({ status }),
        }),
      } as unknown as APIRequestContext;

      await expect(observedSourceIsNewer(
        request,
        "a".repeat(40),
        "b".repeat(40),
        Date.now() + 1_000,
      )).resolves.toBe(false);
    },
  );

  it("creates its local smoke PDF with one foreign annotation", async () => {
    const document = await PDFDocument.load(await createSmokePdf());
    expect(document.getPageCount()).toBe(1);
    const annotations = document.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    expect(annotations.size()).toBe(1);
    const annotation = document.context.lookup(annotations.get(0), PDFDict);
    expect(annotation.lookup(PDFName.of("NM"), PDFString).decodeText()).toBe("smoke-foreign-highlight");
  });
});
