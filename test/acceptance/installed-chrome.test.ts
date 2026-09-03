import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseChromeMajor, validateManualEvidence } from "./installed-chrome.js";

describe("installed Google Chrome release runner", () => {
  it("accepts stable Chrome versions at or after the MIME-handler boundary", () => {
    expect(parseChromeMajor("Google Chrome 151.0.7890.0")).toBe(151);
    expect(parseChromeMajor("Google Chrome 152.0.0.0")).toBe(152);
    expect(parseChromeMajor("Chromium 152.0.0.0")).toBeUndefined();
    expect(parseChromeMajor("Google Chrome unknown")).toBeUndefined();
  });

  it("requires interactive unpacked loading into a disposable profile", async () => {
    const source = await readFile(resolve("test/acceptance/installed-chrome.ts"), "utf8");
    expect(source).toContain('"--remote-debugging-port=0"');
    expect(source).toContain('"chrome://extensions/"');
    expect(source).toContain("enable Developer mode");
    expect(source).not.toContain('"--load-extension=');
    expect(source).not.toContain('"--disable-extensions-except=');
  });

  it("rejects pending, stale, or over-budget manual release evidence", () => {
    const expected = {
      appBuildIdentity: "a".repeat(64),
      chromeVersion: "Google Chrome 152.0.0.0",
      extensionRuntimeIdentitySha256: "b".repeat(64),
    };
    const valid = {
      schemaVersion: 1,
      ...expected,
      scenarios: {
        ae3PreActivationFallback: true, ae4ActiveDisconnect: true,
        ae5CanonicalPresentations: true, ae6Navigation: true,
        ae7CapabilityFreeLink: true, ae8ProtectedSuccessor: true,
        ordinaryReview: true, updateSkew: true, hostileCanaries: true,
        keyboardAccessibility: true, crossSurfaceRegression: true,
      },
      ktd8: {
        corpusVersion: "chrome-native-v1", coldRunsPerFixture: 5,
        warmRunsPerFixture: 10, localAndAuthenticatedRemote: true,
        latencyBudgetPassed: true, memoryBudgetPassed: true,
        progressResponsive: true, cancellationReleaseMs: 1_999,
        measurements: [
          "small-text", "representative-mixed", "image-heavy-scan",
          "structurally-complex", "near-64-mib",
        ].flatMap((fixtureId) => (["local", "authenticated-remote"] as const).map((disposition) => ({
          fixtureId, disposition, redirectP50Ms: 100, nativeP50Ms: 110, nativeP95Ms: 150,
          peakRssBytes: { extension: 1, nativeHost: 2, service: 3, aggregate: 6 },
        }))),
      },
    };
    expect(validateManualEvidence(valid, expected)).toEqual(valid);
    expect(() => validateManualEvidence({ ...valid, appBuildIdentity: "c".repeat(64) }, expected))
      .toThrow(/stale/iu);
    expect(() => validateManualEvidence({ ...valid, ktd8: { ...valid.ktd8, cancellationReleaseMs: 2_001 } }, expected))
      .toThrow(/KTD8/iu);
  });
});
