import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, expect, test, type BrowserContext } from "@playwright/test";

import { CHROME_EXTENSION_ID } from "../../packaging/macos/chrome-integration.js";
import {
  startChromePdfFixtureServer,
  type ChromePdfFixtureServer,
} from "./chrome-pdf-fixture-server.js";

const extensionPath = resolve("apps/chrome-extension/dist");
const pdfPath = resolve("test/fixtures/pdfs/text-native.pdf");
const temporaryRoots: string[] = [];

async function freshPersistentContext(options: {
  readonly extension?: boolean;
} = {}): Promise<BrowserContext> {
  const userDataDir = await mkdtemp(join(tmpdir(), "placekeeper-chrome-profile-"));
  temporaryRoots.push(userDataDir);
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: options.extension === true ? [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ] : [],
  });
}

async function extensionWorker(context: BrowserContext) {
  const expected = `chrome-extension://${CHROME_EXTENSION_ID}/background.js`;
  return context.serviceWorkers().find((worker) => worker.url() === expected) ??
    await context.waitForEvent("serviceworker", {
      predicate: (worker) => worker.url() === expected,
      timeout: 5_000,
    }).catch(() => undefined);
}

test.describe("Chrome PDF performance contract", () => {
  test("pins the versioned native-transport performance contract", async () => {
    const budget = JSON.parse(await readFile(
      resolve("test/acceptance/chrome-performance-budget.json"),
      "utf8",
    )) as {
      schemaVersion: number;
      corpusVersion: string;
      fixtures: Array<{
        id: string;
        local: { fixture?: string; byteLength?: number; sha256?: string };
        remote: unknown;
      }>;
      repetitions: { cold: number; warm: number };
      latency: { percentile: string; relativePercent: number; absoluteMilliseconds: number };
      memory: {
        extensionPdfBytes: number;
        extensionFixedBytes: number;
        nativeServiceTransientBytes: number;
      };
      cancellation: { releaseWithinMilliseconds: number };
    };

    expect(budget).toMatchObject({
      schemaVersion: 1,
      corpusVersion: "chrome-native-v1",
      repetitions: { cold: 5, warm: 10 },
      latency: { percentile: "p50", relativePercent: 20, absoluteMilliseconds: 1_000 },
      memory: {
        extensionPdfBytes: 1,
        extensionFixedBytes: 96 * 1024 * 1024,
        nativeServiceTransientBytes: 32 * 1024 * 1024,
      },
      cancellation: { releaseWithinMilliseconds: 2_000 },
    });
    expect(budget.fixtures.map(({ id }) => id)).toEqual([
      "small-text",
      "representative-mixed",
      "image-heavy-scan",
      "structurally-complex",
      "near-64-mib",
    ]);
    expect(budget.fixtures.every(({ local, remote }) => local !== undefined && remote !== undefined))
      .toBe(true);
    for (const { local } of budget.fixtures) {
      if (local.fixture === undefined) continue;
      const bytes = await readFile(resolve(local.fixture));
      expect(bytes.byteLength).toBe(local.byteLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(local.sha256);
    }
    const nearLimit = budget.fixtures.at(-1)?.local as {
      recipe?: string;
      byteLength?: number;
    };
    expect(nearLimit.recipe).toBe("pad-before-eof");
    expect(nearLimit.byteLength).toBeGreaterThanOrEqual(60 * 1024 * 1024);
    expect(nearLimit.byteLength).toBeLessThan(64 * 1024 * 1024);
  });
});

test.describe("Chrome local-source identity proof", () => {
  test("an opened no-follow snapshot survives replacement, truncation, and symlink swaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "placekeeper-local-identity-proof-"));
    try {
      const source = join(root, "paper.pdf");
      const moved = join(root, "opened-paper.pdf");
      const outside = join(root, "outside.pdf");
      const original = Buffer.from("%PDF-1.7\ntrusted source\n%%EOF");
      await writeFile(source, original);
      await writeFile(outside, "%PDF-1.7\nuntrusted source\n%%EOF");

      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.readFile();
      const identity = await handle.stat();
      await handle.close();
      const accepted = {
        byteLength: opened.byteLength,
        sha256: createHash("sha256").update(opened).digest("hex"),
        device: identity.dev,
        inode: identity.ino,
      };

      await rename(source, moved);
      await writeFile(source, "%PDF-1.7\nreplacement\n%%EOF");
      await writeFile(moved, "");
      await rm(source);
      await symlink(outside, source);

      expect(opened).toEqual(original);
      expect({
        byteLength: opened.byteLength,
        sha256: createHash("sha256").update(opened).digest("hex"),
        device: identity.dev,
        inode: identity.ino,
      }).toEqual(accepted);
      expect(await readFile(source)).not.toEqual(opened);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test.describe("Chrome PDF handoff acceptance", () => {
  let fixture!: ChromePdfFixtureServer;

  test.beforeAll(async () => {
    fixture = await startChromePdfFixtureServer({ pdfBytes: await readFile(pdfPath) });
  });

  test.afterAll(async () => {
    if (fixture !== undefined) await fixture.close();
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })));
  });

  test("serves authenticated suffixless, redirected POST, and hostile PDF responses deterministically", async () => {
    const context = await freshPersistentContext();
    try {
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(fixture.origin);
      await page.getByLabel("Fixture password").fill("reader");
      await Promise.all([
        page.waitForURL(fixture.origin + "/"),
        page.getByRole("button", { name: "Start authenticated session" }).click(),
      ]);

      const suffixless = await context.request.get(`${fixture.origin}/document?id=42`);
      expect(suffixless.status()).toBe(200);
      expect(suffixless.headers()["content-type"]).toBe("application/pdf");
      expect(await suffixless.body()).toEqual(await readFile(pdfPath));

      const singleUse = await context.request.post(`${fixture.origin}/redirected-document`, {
        form: { intent: "open" },
      });
      expect(singleUse.status()).toBe(200);
      expect(singleUse.url()).toBe(`${fixture.origin}/single-use-document`);
      expect(singleUse.headers()["content-type"]).toBe("application/pdf");
      expect(await singleUse.body()).toEqual(await readFile(pdfPath));
      const replay = await context.request.post(`${fixture.origin}/redirected-document`, {
        form: { intent: "open" },
      });
      expect(replay.status()).toBe(410);

      const invalid = await context.request.get(`${fixture.origin}/invalid-document`);
      expect(invalid.status()).toBe(200);
      expect(invalid.headers()["content-type"]).toBe("application/pdf");
      expect((await invalid.body()).subarray(0, 5).toString()).not.toBe("%PDF-");

      const slow = await context.request.get(`${fixture.origin}/slow-document`);
      expect(slow.status()).toBe(200);
      expect(await slow.body()).toEqual(await readFile(pdfPath));

      await expect(context.request.get(`${fixture.origin}/interrupted-document`))
        .rejects.toThrow();
      const overBudget = await context.request.head(`${fixture.origin}/over-budget-document`);
      expect(Number(overBudget.headers()["content-length"]))
        .toBeGreaterThan(256 * 1024 * 1024);

      expect(fixture.snapshot()).toEqual({
        authenticatedSessions: 1,
        interrupted: 1,
        invalid: 1,
        overBudget: 1,
        redirects: 2,
        singleUseAccepted: 1,
        singleUseRejected: 1,
        slow: 1,
        suffixless: 1,
      });
      expect(JSON.stringify(fixture.snapshot())).not.toContain("reader");
    } finally {
      await context.close();
    }
  });

  test("starts the unpacked extension paused when MIME-handler automation is available", async () => {
    const context = await freshPersistentContext({ extension: true });
    try {
      const browserVersion = context.browser()?.version() ?? "unknown";
      const browserMajor = Number.parseInt(browserVersion.split(".")[0] ?? "", 10);
      test.skip(
        !Number.isFinite(browserMajor) || browserMajor < 151,
        `Playwright's managed Chromium is ${browserVersion}; Chrome 151+ is required for the public mimeHandler API, so the installed Chrome smoke remains required.`,
      );
      const worker = await extensionWorker(context);
      test.skip(
        worker === undefined,
        "Playwright's bundled Chromium did not load the unpacked extension; the fresh-profile installed Chrome smoke remains required.",
      );
      const feature = await worker!.evaluate(() => ({
        get: typeof chrome.mimeHandler?.getMimeHandlerOptions === "function",
        set: typeof chrome.mimeHandler?.setMimeHandlerOptions === "function",
        stream: typeof chrome.mimeHandler?.getStreamInfo === "function",
        fallback: typeof chrome.mimeHandler?.abortAndFallbackToNativeHandler === "function",
      }));
      test.skip(
        !Object.values(feature).every(Boolean),
        "The automated Chromium build does not expose Chrome 151's public mimeHandler surface; run the installed Google Chrome smoke.",
      );

      await expect.poll(async () => worker!.evaluate(async () => ({
        sentinel: (await chrome.storage.local.get("automaticOpenExplicitlyEnabled"))
          .automaticOpenExplicitlyEnabled,
        mime: (await chrome.mimeHandler.getMimeHandlerOptions("application/pdf")).enabled,
      }))).toEqual({ sentinel: false, mime: false });
    } finally {
      await context.close();
    }
  });
});
